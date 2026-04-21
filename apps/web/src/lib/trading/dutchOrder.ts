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

/** DCA batch plan — ties every leg back to one UI-level strategy row. */
export interface DcaLeg {
  /** 0-based leg position in the schedule. */
  index: number;
  /** Unix seconds when the keeper becomes eligible to fill this leg. */
  decayStartSec: number;
  /** Unix seconds at which the leg expires if un-filled. */
  deadlineSec: number;
  /** The underlying DutchOrder for this leg — pass to `encodeDutchOrder`. */
  order: DutchOrder;
}

export interface BuildDcaLegsParams {
  reactor: Address;
  swapper: Address;
  side: Side;
  baseToken: Address;
  quoteToken: Address;
  /** Total base-token amount across ALL legs. Divided evenly; remainder lands on the last leg. */
  totalBaseAmount: bigint;
  /** Uniform limit price per leg (quote-per-base, 18 decimals). */
  pricePerBase18: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  /** Number of legs. Must be >= 2. */
  legs: number;
  /** Seconds between the decayStart of consecutive legs. Must be >= 60. */
  intervalSec: number;
  /** Unix seconds for the first leg's decayStart (usually `floor(Date.now()/1000)`). */
  firstLegStartSec: number;
  /** Per-leg validity window (seconds between a leg's decayStart and its deadline). */
  legValiditySec: number;
  /** Nonce generator. Defaults to `randomPermit2Nonce`; injectable for deterministic tests. */
  nonceGenerator?: () => bigint;
}

/**
 * Build N flat limit orders laid out on a DCA schedule.
 *
 * Each leg is a plain limit order (same shape as `buildLimitOrder`) with its
 * own staggered `decayStartTime`. The keeper's `decayStartTime <= now` gate
 * is what releases each leg in sequence — no on-chain scheduling needed.
 *
 * The total base amount is split evenly across legs; any remainder from
 * integer division is added to the last leg so the sum matches the input
 * exactly (avoids a dust delta between the user-approved amount and the sum
 * of per-leg inputs).
 *
 * Caller is responsible for generating ONE `dcaBatchId` and tagging every
 * leg's POST payload with it + the leg's `index` and the total leg count —
 * the orderbook stores that metadata so the dashboard can group legs into a
 * single strategy row.
 */
export function buildDcaLegs(p: BuildDcaLegsParams): DcaLeg[] {
  if (p.legs < 2) throw new Error('DCA requires at least 2 legs');
  if (p.legs > 50) throw new Error('DCA capped at 50 legs per batch');
  if (p.intervalSec < 60) throw new Error('intervalSec must be >= 60');
  if (p.totalBaseAmount < BigInt(p.legs)) {
    throw new Error('totalBaseAmount must be >= legs (each leg needs >= 1 wei)');
  }
  if (p.legValiditySec < 300) throw new Error('legValiditySec must be >= 300');

  const perLeg = p.totalBaseAmount / BigInt(p.legs);
  const remainder = p.totalBaseAmount - perLeg * BigInt(p.legs);
  const gen = p.nonceGenerator ?? randomPermit2Nonce;

  const out: DcaLeg[] = [];
  for (let i = 0; i < p.legs; i++) {
    const decayStart = p.firstLegStartSec + i * p.intervalSec;
    const deadline = decayStart + p.legValiditySec;
    const baseAmount = i === p.legs - 1 ? perLeg + remainder : perLeg;
    out.push({
      index: i,
      decayStartSec: decayStart,
      deadlineSec: deadline,
      order: buildLimitOrder({
        reactor: p.reactor,
        swapper: p.swapper,
        side: p.side,
        baseToken: p.baseToken,
        quoteToken: p.quoteToken,
        baseAmount,
        pricePerBase18: p.pricePerBase18,
        baseDecimals: p.baseDecimals,
        quoteDecimals: p.quoteDecimals,
        deadlineSec: deadline,
        nonce: gen(),
        decayStartSec: decayStart,
        decayEndSec: decayStart,
      }),
    });
  }
  return out;
}

/** One level of a bounded-grid plan. */
export interface GridLevel {
  /** 0-based level position, ascending by price (lowest = 0). */
  index: number;
  /** Side of this level: buy levels sit below the reference price, sell above. */
  side: Side;
  /** Limit price for this level (quote-per-base, 18 decimals). */
  pricePerBase18: bigint;
  /** Unix seconds when the keeper becomes eligible to fill this level. */
  decayStartSec: number;
  /** Unix seconds at which this level expires. */
  deadlineSec: number;
  /** The underlying DutchOrder for this level — pass to `encodeDutchOrder`. */
  order: DutchOrder;
}

export interface BuildGridLegsParams {
  reactor: Address;
  swapper: Address;
  baseToken: Address;
  quoteToken: Address;
  baseDecimals: number;
  quoteDecimals: number;
  /** Lowest buy level price (quote-per-base, 18 decimals). Must be > 0. */
  lowPrice18: bigint;
  /** Highest sell level price (quote-per-base, 18 decimals). Must be > `lowPrice18`. */
  highPrice18: bigint;
  /** Current reference price (quote-per-base, 18 decimals) used to split buy vs sell.
   * Levels with price < reference are buys; levels with price > reference are sells.
   * Must satisfy `lowPrice18 < referencePrice18 < highPrice18`. */
  referencePrice18: bigint;
  /** Total number of levels. Must be >= 2 and <= 50. Levels are laid out at
   * evenly-spaced linear price steps between `lowPrice18` and `highPrice18`. */
  levels: number;
  /** Base-token amount filled PER SELL level. Multiplied by the number of sell
   * levels to compute total base required, and again at the equivalent quote
   * price for buys (so the user needs both `totalBase` base + `totalQuote` quote
   * on deposit for the grid to fully fill). Must be > 0. */
  baseAmountPerLevel: bigint;
  /** Unix seconds when every level's decayStart begins. All levels become
   * eligible simultaneously — the grid is passive, keeper fills whichever side
   * the market crosses first. */
  startSec: number;
  /** Unix seconds at which every level expires. Must be > `startSec + 300`. */
  deadlineSec: number;
  /** Nonce generator. Defaults to `randomPermit2Nonce`; injectable for tests. */
  nonceGenerator?: () => bigint;
}

/**
 * Build N flat limit orders laid out on a bounded grid between `lowPrice18`
 * and `highPrice18`, split around `referencePrice18`.
 *
 * Each level is its own independent limit order (same shape as
 * `buildLimitOrder`) at its own `pricePerBase18`, all sharing the same
 * decayStart / deadline so they're simultaneously eligible. The keeper fills
 * whichever level the market crosses.
 *
 * Price layout: evenly-spaced linear steps between `lowPrice18` and
 * `highPrice18`, inclusive. With N levels the step size is
 * `(highPrice18 - lowPrice18) / (N - 1)`. Levels strictly below the reference
 * price become `buy` orders; levels strictly above become `sell` orders. A
 * level coinciding with the reference is skipped (would be an immediate fill).
 *
 * Caller is responsible for generating ONE `gridBatchId` and tagging every
 * level's POST payload with it + the level's `index` and the total level
 * count so the dashboard can group levels into a single strategy row.
 */
export function buildGridLegs(p: BuildGridLegsParams): GridLevel[] {
  if (p.levels < 2) throw new Error('grid requires at least 2 levels');
  if (p.levels > 50) throw new Error('grid capped at 50 levels per batch');
  if (p.lowPrice18 <= 0n) throw new Error('lowPrice18 must be > 0');
  if (p.highPrice18 <= p.lowPrice18) {
    throw new Error('highPrice18 must be > lowPrice18');
  }
  if (p.referencePrice18 <= p.lowPrice18 || p.referencePrice18 >= p.highPrice18) {
    throw new Error('referencePrice18 must be strictly between lowPrice18 and highPrice18');
  }
  if (p.baseAmountPerLevel <= 0n) throw new Error('baseAmountPerLevel must be > 0');
  if (p.deadlineSec <= p.startSec + 300) {
    throw new Error('deadlineSec must be at least 300s after startSec');
  }

  const gen = p.nonceGenerator ?? randomPermit2Nonce;
  const step = (p.highPrice18 - p.lowPrice18) / BigInt(p.levels - 1);
  if (step === 0n) throw new Error('price step resolves to 0 — widen bounds or reduce levels');

  const out: GridLevel[] = [];
  for (let i = 0; i < p.levels; i++) {
    const price =
      i === p.levels - 1
        ? p.highPrice18 // anchor the top level exactly at highPrice18 regardless of integer-division drift
        : p.lowPrice18 + step * BigInt(i);
    // Skip a level that lands exactly on the reference price — it would be
    // an immediate fill on both sides.
    if (price === p.referencePrice18) continue;
    const side: Side = price < p.referencePrice18 ? 'buy' : 'sell';
    out.push({
      // Contiguous 0-based index within emitted levels so the orderbook's
      // `gridIndex < gridTotal` guard holds even when a candidate price is
      // skipped for coinciding with the reference price.
      index: out.length,
      side,
      pricePerBase18: price,
      decayStartSec: p.startSec,
      deadlineSec: p.deadlineSec,
      order: buildLimitOrder({
        reactor: p.reactor,
        swapper: p.swapper,
        side,
        baseToken: p.baseToken,
        quoteToken: p.quoteToken,
        baseAmount: p.baseAmountPerLevel,
        pricePerBase18: price,
        baseDecimals: p.baseDecimals,
        quoteDecimals: p.quoteDecimals,
        deadlineSec: p.deadlineSec,
        nonce: gen(),
        decayStartSec: p.startSec,
        decayEndSec: p.startSec,
      }),
    });
  }
  return out;
}

/** Random 128-bit hex id shared by every level of one grid batch. */
export function randomGridBatchId(): string {
  return randomDcaBatchId();
}

/** Random 128-bit hex id shared by every leg of one DCA batch. Uses
 * `crypto.randomUUID()` when available, falls back to `getRandomValues`. */
export function randomDcaBatchId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('crypto unavailable — need a secure RNG');
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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
