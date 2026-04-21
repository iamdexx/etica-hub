import {
  decodeAbiParameters,
  isAddress,
  type Hex,
} from 'viem';

/**
 * UniswapX DutchOrder decoding.
 *
 * The caller POSTs `encodedOrder` (ABI-encoded DutchOrder struct) + `signature`.
 * We decode the struct to extract indexable fields (swapper, tokens, deadline,
 * decay window, etc.) for storage and filtering. We do NOT verify the
 * signature — that's the reactor's job when a keeper submits the fill. Off-chain
 * sig verification is also non-trivial here because UniswapX orders are signed
 * as a Permit2 witness, not as a direct DutchOrder EIP-712 digest.
 *
 * The ABI layout below mirrors `DutchOrderLib.sol`:
 *   struct DutchOrder {
 *     OrderInfo info;
 *     uint256 decayStartTime;
 *     uint256 decayEndTime;
 *     DutchInput input;            // (address token, uint256 startAmount, uint256 endAmount)
 *     DutchOutput[] outputs;       // [(address token, uint256 startAmount, uint256 endAmount, address recipient)]
 *   }
 *   struct OrderInfo {
 *     address reactor;
 *     address swapper;
 *     uint256 nonce;
 *     uint256 deadline;
 *     address additionalValidationContract;
 *     bytes   additionalValidationData;
 *   }
 */

export const DUTCH_ORDER_ABI_TYPE = {
  type: 'tuple',
  components: [
    {
      name: 'info',
      type: 'tuple',
      components: [
        { name: 'reactor', type: 'address' },
        { name: 'swapper', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'additionalValidationContract', type: 'address' },
        { name: 'additionalValidationData', type: 'bytes' },
      ],
    },
    { name: 'decayStartTime', type: 'uint256' },
    { name: 'decayEndTime', type: 'uint256' },
    {
      name: 'input',
      type: 'tuple',
      components: [
        { name: 'token', type: 'address' },
        { name: 'startAmount', type: 'uint256' },
        { name: 'endAmount', type: 'uint256' },
      ],
    },
    {
      name: 'outputs',
      type: 'tuple[]',
      components: [
        { name: 'token', type: 'address' },
        { name: 'startAmount', type: 'uint256' },
        { name: 'endAmount', type: 'uint256' },
        { name: 'recipient', type: 'address' },
      ],
    },
  ],
} as const;

export interface DecodedDutchOrder {
  reactor: `0x${string}`;
  swapper: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
  additionalValidationContract: `0x${string}`;
  additionalValidationData: Hex;
  decayStartTime: bigint;
  decayEndTime: bigint;
  input: {
    token: `0x${string}`;
    startAmount: bigint;
    endAmount: bigint;
  };
  outputs: Array<{
    token: `0x${string}`;
    startAmount: bigint;
    endAmount: bigint;
    recipient: `0x${string}`;
  }>;
}

export function decodeDutchOrder(encodedOrder: Hex): DecodedDutchOrder {
  const [decoded] = decodeAbiParameters([DUTCH_ORDER_ABI_TYPE], encodedOrder) as [
    {
      info: {
        reactor: `0x${string}`;
        swapper: `0x${string}`;
        nonce: bigint;
        deadline: bigint;
        additionalValidationContract: `0x${string}`;
        additionalValidationData: Hex;
      };
      decayStartTime: bigint;
      decayEndTime: bigint;
      input: {
        token: `0x${string}`;
        startAmount: bigint;
        endAmount: bigint;
      };
      outputs: ReadonlyArray<{
        token: `0x${string}`;
        startAmount: bigint;
        endAmount: bigint;
        recipient: `0x${string}`;
      }>;
    },
  ];

  return {
    reactor: decoded.info.reactor,
    swapper: decoded.info.swapper,
    nonce: decoded.info.nonce,
    deadline: decoded.info.deadline,
    additionalValidationContract: decoded.info.additionalValidationContract,
    additionalValidationData: decoded.info.additionalValidationData,
    decayStartTime: decoded.decayStartTime,
    decayEndTime: decoded.decayEndTime,
    input: {
      token: decoded.input.token,
      startAmount: decoded.input.startAmount,
      endAmount: decoded.input.endAmount,
    },
    outputs: decoded.outputs.map((o) => ({
      token: o.token,
      startAmount: o.startAmount,
      endAmount: o.endAmount,
      recipient: o.recipient,
    })),
  };
}

/**
 * Cheap sanity checks applied to every incoming order. Signature recovery and
 * on-chain balance/nonce checks are OUT of scope — that's the reactor's job.
 */
export function validateOrderStructure(order: DecodedDutchOrder, signature: Hex): string | null {
  if (!isAddress(order.reactor)) return 'invalid reactor address';
  if (!isAddress(order.swapper)) return 'invalid swapper address';
  if (!isAddress(order.input.token)) return 'invalid input token';
  if (order.outputs.length === 0) return 'order must have at least one output';
  for (const o of order.outputs) {
    if (!isAddress(o.token)) return 'invalid output token';
    if (!isAddress(o.recipient)) return 'invalid output recipient';
    if (o.startAmount === 0n) return 'output startAmount must be > 0';
    if (o.endAmount === 0n) return 'output endAmount must be > 0';
  }
  if (order.input.startAmount === 0n) return 'input startAmount must be > 0';
  // Deadline checked first: an expired order is meaningless regardless of
  // whatever decay window it quotes.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (order.deadline <= nowSec) return 'order deadline already passed';
  if (order.decayStartTime > order.decayEndTime) {
    return 'decayStartTime must be <= decayEndTime';
  }
  if (order.decayEndTime > order.deadline) {
    return 'decayEndTime must be <= deadline';
  }

  // 65 bytes = `0x` + 130 hex chars.
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return 'signature must be 65-byte hex';
  }

  return null;
}
