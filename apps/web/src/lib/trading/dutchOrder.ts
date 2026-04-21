import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
  type TypedData,
} from 'viem';

/**
 * Client-side helpers for constructing, signing, and encoding UniswapX
 * DutchOrder blobs that the order-book API (`apps/orderbook`) and
 * `DutchOrderReactor` (`packages/trading-contracts/lib/uniswapx`) will accept.
 *
 * A UniswapX order is really a Permit2 `permitWitnessTransferFrom` signature
 * where the witness is the DutchOrder struct. On-chain, the reactor
 * reconstructs that witness from the encoded order + witness-type string and
 * asks Permit2 to recover the swapper. Off-chain, the client produces two
 * things:
 *
 *   1. `encodedOrder` — ABI-encoded DutchOrder struct. Same shape as
 *      `abi.decode(..., (DutchOrder))` in the reactor.
 *   2. `signature`    — 65-byte EIP-712 signature over the Permit2 witness
 *      typed data with the DutchOrder embedded as the witness.
 *
 * Both blobs are POSTed to `/orders`. The keeper later reads them and submits
 * `reactor.execute(SignedOrder{order: encodedOrder, sig: signature})`.
 *
 * Scope of this file:
 *   - No wallet / RPC / wagmi imports here. Pure data transform, unit-testable
 *     in node. Callers pass the signer's address and a `signTypedData` fn.
 *   - Limit-order focused. `decayStart == decayEnd` and `startAmount == endAmount`
 *     for both input and output, so the order is a flat (no-decay) limit.
 *     Dutch decay, TWAP, and trigger-based (stop-loss) orders reuse the same
 *     primitives in follow-up PRs.
 */

/** Canonical Permit2 EIP-712 domain name. */
const PERMIT2_DOMAIN_NAME = 'Permit2';

/** Random 256-bit Permit2 nonce. Permit2 uses unordered nonces so any uint256
 * works as long as no two orders from the same swapper share a nonce word+bit.
 * Generating from `crypto.getRandomValues` gives a collision rate ≪ 1/2^128
 * for any realistic number of orders a user will ever sign. */
export function randomPermit2Nonce(): bigint {
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues unavailable — need a secure RNG');
  }
  globalThis.crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/** Side of the trade from the swapper's POV. `buy` spends the quote (ETX) to
 * receive the base (ETI/EGAZ); `sell` spends the base to receive the quote. */
export type Side = 'buy' | 'sell';

export interface BuildLimitOrderParams {
  /** Reactor we're targeting. Zero-address is invalid. */
  reactor: Address;
  /** Swapper (== connected wallet) address. */
  swapper: Address;
  /** Buy or sell. */
  side: Side;
  /** Base token address (e.g. ETI or EGAZ). */
  baseToken: Address;
  /** Quote token address (ETX for the hub-and-spoke model). */
  quoteToken: Address;
  /** Amount of the BASE token, scaled to the base's decimals, as bigint. */
  baseAmount: bigint;
  /** Limit price expressed as (quote per base), with 18 decimals of precision.
   * Example: price = 1.5 ETX per ETI → `parseUnits('1.5', 18)`. */
  pricePerBase18: bigint;
  /** Base token decimals. Needed to convert `baseAmount × price` → quoteAmount. */
  baseDecimals: number;
  /** Quote token decimals. Most mainnet tokens are 18. */
  quoteDecimals: number;
  /** Unix seconds (not ms) after which the order expires. */
  deadlineSec: number;
  /** Permit2 nonce. Caller-supplied so the same order is deterministic across
   * retries; use `randomPermit2Nonce()` for fresh orders. */
  nonce: bigint;
  /** Optional decay window start. Defaults to `deadlineSec - 60` (flat limit). */
  decayStartSec?: number;
  /** Optional decay window end. Defaults to `decayStartSec`. */
  decayEndSec?: number;
}

export interface DutchOrder {
  info: {
    reactor: Address;
    swapper: Address;
    nonce: bigint;
    deadline: bigint;
    additionalValidationContract: Address;
    additionalValidationData: Hex;
  };
  decayStartTime: bigint;
  decayEndTime: bigint;
  input: {
    token: Address;
    startAmount: bigint;
    endAmount: bigint;
  };
  outputs: Array<{
    token: Address;
    startAmount: bigint;
    endAmount: bigint;
    recipient: Address;
  }>;
}

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/** Compute `base × price / 10^18`, i.e. the quote amount corresponding to
 * `baseAmount` at the given 18-dec-scaled price. */
export function quoteFromBase(baseAmount: bigint, pricePerBase18: bigint): bigint {
  return (baseAmount * pricePerBase18) / 10n ** 18n;
}

/** Compute `quote × 10^18 / price`, i.e. the base amount you'd receive for
 * `quoteAmount` at the given 18-dec-scaled price. Used for buy-side sizing. */
export function baseFromQuote(quoteAmount: bigint, pricePerBase18: bigint): bigint {
  if (pricePerBase18 === 0n) throw new Error('price cannot be zero');
  return (quoteAmount * 10n ** 18n) / pricePerBase18;
}

/**
 * Build a flat (no-decay) DutchOrder for a limit trade.
 *
 * The "limit" price semantics:
 *   - `sell`: swapper sends `baseAmount` of base, wants AT LEAST
 *     `baseAmount × price` of quote. The keeper can give more (the user wins).
 *   - `buy`:  swapper sends `baseAmount × price` of quote, wants AT LEAST
 *     `baseAmount` of base. The keeper can give more.
 *
 * With `startAmount == endAmount` on both sides, the reactor's `_validateOrder`
 * check passes (no input-and-output decay) and the order is a pure limit.
 */
export function buildLimitOrder(p: BuildLimitOrderParams): DutchOrder {
  if (p.baseAmount <= 0n) throw new Error('baseAmount must be > 0');
  if (p.pricePerBase18 <= 0n) throw new Error('pricePerBase18 must be > 0');
  if (p.deadlineSec <= Math.floor(Date.now() / 1000)) {
    throw new Error('deadlineSec must be in the future');
  }

  // Scale price (which is quote-per-base in 1e18-fixed) from the base's
  // decimals to the quote's decimals. For 18/18 pairs this is a no-op.
  // quoteAmount = baseAmount × price / 1e18 × 10^(quoteDecimals - baseDecimals)
  const decimalShift = BigInt(p.quoteDecimals - p.baseDecimals);
  const rawQuote =
    decimalShift >= 0n
      ? quoteFromBase(p.baseAmount, p.pricePerBase18) * 10n ** decimalShift
      : quoteFromBase(p.baseAmount, p.pricePerBase18) / 10n ** -decimalShift;

  const inputToken = p.side === 'sell' ? p.baseToken : p.quoteToken;
  const outputToken = p.side === 'sell' ? p.quoteToken : p.baseToken;
  const inputAmount = p.side === 'sell' ? p.baseAmount : rawQuote;
  const outputAmount = p.side === 'sell' ? rawQuote : p.baseAmount;

  const decayStart = BigInt(p.decayStartSec ?? p.deadlineSec - 60);
  const decayEnd = BigInt(p.decayEndSec ?? Number(decayStart));
  if (decayEnd < decayStart) throw new Error('decayEnd must be >= decayStart');
  if (decayEnd > BigInt(p.deadlineSec)) {
    throw new Error('decayEnd must be <= deadlineSec');
  }

  return {
    info: {
      reactor: p.reactor,
      swapper: p.swapper,
      nonce: p.nonce,
      deadline: BigInt(p.deadlineSec),
      additionalValidationContract: ZERO_ADDRESS,
      additionalValidationData: '0x',
    },
    decayStartTime: decayStart,
    decayEndTime: decayEnd,
    input: {
      token: inputToken,
      startAmount: inputAmount,
      endAmount: inputAmount,
    },
    outputs: [
      {
        token: outputToken,
        startAmount: outputAmount,
        endAmount: outputAmount,
        recipient: p.swapper,
      },
    ],
  };
}

/** ABI-encode the DutchOrder struct so it can be dropped into the
 * `encodedOrder` field on `/orders` POST. Matches the layout the reactor
 * expects in `abi.decode(signedOrder.order, (DutchOrder))`. */
export function encodeDutchOrder(o: DutchOrder): Hex {
  const params = parseAbiParameters([
    'DutchOrder order',
    'struct DutchOrder { OrderInfo info; uint256 decayStartTime; uint256 decayEndTime; DutchInput input; DutchOutput[] outputs; }',
    'struct OrderInfo { address reactor; address swapper; uint256 nonce; uint256 deadline; address additionalValidationContract; bytes additionalValidationData; }',
    'struct DutchInput { address token; uint256 startAmount; uint256 endAmount; }',
    'struct DutchOutput { address token; uint256 startAmount; uint256 endAmount; address recipient; }',
  ]);
  return encodeAbiParameters(params, [o]);
}

/** Compute the deterministic storage key the order-book API uses
 * (`keccak256(encodedOrder)`). Useful for linking to `/orders/:hash`. */
export function orderBookHash(encoded: Hex): Hex {
  return keccak256(encoded);
}

/**
 * Build the EIP-712 typed data for the Permit2 witness signature.
 *
 * UniswapX composes a "PermitWitnessTransferFrom" with `DutchOrder` as the
 * witness. The primary type is `PermitWitnessTransferFrom` and must be
 * signed against Permit2's domain (`name: 'Permit2'`, no version, verifying
 * contract = permit2 address on the target chain).
 *
 * Returns an object suitable for viem's `signTypedData({ ... })`.
 */
/** Flattened DutchOrder the way the EIP-712 witness type expects it —
 * `input` is expanded into three top-level fields. This matches
 * `DutchOrderLib.DUTCH_LIMIT_ORDER_TYPE` in the reactor. The ABI-encoded
 * struct (`encodeDutchOrder`) keeps `input` as a tuple instead, because
 * `abi.decode(..., (DutchOrder))` in the reactor expects that layout. Two
 * different representations of the same data, one for each codec. */
interface FlatDutchWitness {
  info: DutchOrder['info'];
  decayStartTime: bigint;
  decayEndTime: bigint;
  inputToken: Address;
  inputStartAmount: bigint;
  inputEndAmount: bigint;
  outputs: DutchOrder['outputs'];
}

export function buildPermit2WitnessTypedData(
  o: DutchOrder,
  opts: { chainId: number; permit2: Address },
): {
  domain: { name: string; chainId: number; verifyingContract: Address };
  types: TypedData;
  primaryType: 'PermitWitnessTransferFrom';
  message: {
    permitted: { token: Address; amount: bigint };
    spender: Address;
    nonce: bigint;
    deadline: bigint;
    witness: FlatDutchWitness;
  };
} {
  const witness: FlatDutchWitness = {
    info: o.info,
    decayStartTime: o.decayStartTime,
    decayEndTime: o.decayEndTime,
    inputToken: o.input.token,
    inputStartAmount: o.input.startAmount,
    inputEndAmount: o.input.endAmount,
    outputs: o.outputs,
  };

  return {
    domain: {
      name: PERMIT2_DOMAIN_NAME,
      chainId: opts.chainId,
      verifyingContract: opts.permit2,
    },
    types: {
      PermitWitnessTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'witness', type: 'DutchOrder' },
      ],
      TokenPermissions: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      // Sub-structs are concatenated in alphabetical order per EIP-712
      // (`DutchOrder` < `DutchOutput` < `OrderInfo`) — this matches
      // `DutchOrderLib.PERMIT2_ORDER_TYPE` verbatim.
      DutchOrder: [
        { name: 'info', type: 'OrderInfo' },
        { name: 'decayStartTime', type: 'uint256' },
        { name: 'decayEndTime', type: 'uint256' },
        { name: 'inputToken', type: 'address' },
        { name: 'inputStartAmount', type: 'uint256' },
        { name: 'inputEndAmount', type: 'uint256' },
        { name: 'outputs', type: 'DutchOutput[]' },
      ],
      DutchOutput: [
        { name: 'token', type: 'address' },
        { name: 'startAmount', type: 'uint256' },
        { name: 'endAmount', type: 'uint256' },
        { name: 'recipient', type: 'address' },
      ],
      OrderInfo: [
        { name: 'reactor', type: 'address' },
        { name: 'swapper', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'additionalValidationContract', type: 'address' },
        { name: 'additionalValidationData', type: 'bytes' },
      ],
    },
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      // `permitted.amount` is the MAX transferable — DutchInput max is
      // `max(startAmount, endAmount)`. For a flat limit they're equal.
      permitted: {
        token: o.input.token,
        amount: o.input.startAmount > o.input.endAmount ? o.input.startAmount : o.input.endAmount,
      },
      // The reactor is the Permit2 spender authorized to pull the input.
      spender: o.info.reactor,
      nonce: o.info.nonce,
      deadline: o.info.deadline,
      witness,
    },
  };
}
