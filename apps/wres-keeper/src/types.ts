/**
 * Shared domain types for the wRES keeper.
 *
 * The keeper reasons over two flows:
 *   - Entry  : new research registration -> TRON `mintTwin` (+ `frontUpgrade`)
 *   - Payout : TRON `claimForPayout` -> reserve top-up / keeper ops / ETX payout
 *
 * The entry trigger is chain-agnostic: a `Registration` records
 * `(originChainId, originRef, tronRecipient, payoutWallet)` so any origin
 * chain (Etica, Ethereum, Solana, etc.) can seed a TRON research topic.
 *
 * All amounts on the TRON side are denominated in SUN (1 TRX = 1e6 SUN) and
 * carried as `bigint`. Etica-side amounts are wei (`bigint`).
 */

export type Hex = `0x${string}`;

/** 1 TRX = 1,000,000 SUN. Mirrors `SUN_PER_TRX` in WrappedRESMiner. */
export const SUN_PER_TRX = 1_000_000n;

/** Basis-point denominator. Mirrors `BPS_DENOMINATOR` on-chain. */
export const BPS_DENOMINATOR = 10_000n;

/**
 * A research NFT registered for cloning onto TRON. Chain-agnostic: any origin
 * chain can emit a registration. The keeper mints a TRON twin for each
 * registration that doesn't already have one.
 */
export interface Registration {
  /** Unique identifier on the origin chain (e.g., RES tokenId on Etica). */
  resTokenId: bigint;
  /** TRON recipient for the minted twin (20-byte EVM-format address). */
  tronRecipient: Hex;
  /** Etica/EVM wallet that receives ETX payouts. */
  payoutWallet: Hex;
}

/** A minted TRON twin, keyed by its sequential ERC-721 tokenId. */
export interface TwinRecord {
  tokenId: bigint;
  resTokenId: bigint;
  /** Etica wallet that receives ETX payouts (from the Miner struct). */
  payoutWallet: Hex;
  /** Settled-but-unclaimed TRX (SUN) reported by `pendingReward`. */
  pendingSun: bigint;
}

/** Three-way split applied to a claimed payout (in SUN). */
export interface PayoutSplit {
  /** Slice retained in the TRX reserve (`TrxReserve.topUp`). */
  reserveTopUpSun: bigint;
  /** Slice retained by the keeper as TRX for its own gas/energy costs. */
  keeperOpsSun: bigint;
  /** Slice bridged + swapped to ETX for the holder. */
  payoutSun: bigint;
}

/** A new registration that needs a TRON twin minted (and optionally fronted). */
export interface EntryPlan {
  resTokenId: bigint;
  tronRecipient: Hex;
  payoutWallet: Hex;
  /** TRX (SUN) to front from the reserve immediately after mint (0 = none). */
  initialFrontSun: bigint;
}

/** A twin with enough settled revenue to pay out. */
export interface PayoutPlan {
  tokenId: bigint;
  payoutWallet: Hex;
  claimableSun: bigint;
  split: PayoutSplit;
}

/** The full set of actions a single tick wants to take. */
export interface KeeperPlan {
  entries: EntryPlan[];
  payouts: PayoutPlan[];
}

/** Snapshot of cross-chain state gathered at the start of a tick. */
export interface Observation {
  /** Pending registrations (from any origin chain) awaiting a TRON twin. */
  registrations: Registration[];
  /** Twins already minted on TRON, by resTokenId. */
  mintedByResTokenId: Map<string, bigint>;
  /** Known twins with their settled reward. */
  twins: TwinRecord[];
}

/** Minimal structured logger (console satisfies this). */
export type Logger = Pick<Console, 'info' | 'warn' | 'error'>;
