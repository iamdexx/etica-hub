/**
 * Shared domain types for the wRES keeper.
 *
 * The keeper reasons over three flows:
 *   - Entry  : Etica `Locked` -> TRON `mintTwin` (+ `frontUpgrade`)
 *   - Payout : TRON `claimForPayout` -> 1% reserve top-up / 99% ETX to holder
 *   - Exit   : Etica `requestUnlock` matured past its challenge window ->
 *              permissionless `executeUnlock` returns the RES to its locker
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
 * A RES NFT escrowed in the Etica `RESLockVault`, as read from a `Locked`
 * event. `tronRecipient` is stored on Etica as a 20-byte `address`; the keeper
 * converts it to a TRON address (0x41-prefixed hex / base58) before minting.
 */
export interface LockRecord {
  resTokenId: bigint;
  owner: Hex;
  /** 20-byte address as stored on Etica (no 0x41 TRON prefix). */
  tronRecipient: Hex;
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

/** A new lock that needs a TRON twin minted (and optionally fronted). */
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

/**
 * A pending owner-initiated unlock on the vault, read from `UnlockRequested`
 * events and confirmed against the authoritative `locks` getter. `unlockReadyAt`
 * is a unix timestamp (seconds); a veto resets it to 0, clearing the request.
 */
export interface PendingUnlock {
  resTokenId: bigint;
  unlockReadyAt: bigint;
  active: boolean;
}

/** A matured unlock request the keeper can finalize via `executeUnlock`. */
export interface ExitPlan {
  resTokenId: bigint;
}

/** The full set of actions a single tick wants to take. */
export interface KeeperPlan {
  entries: EntryPlan[];
  payouts: PayoutPlan[];
  exits: ExitPlan[];
}

/** Snapshot of cross-chain state gathered at the start of a tick. */
export interface Observation {
  /** Active locks on Etica (RES escrowed, no twin-return yet). */
  locks: LockRecord[];
  /** Twins already minted on TRON, by resTokenId. */
  mintedByResTokenId: Map<string, bigint>;
  /** Known twins with their settled reward. */
  twins: TwinRecord[];
  /** Owner-initiated unlock requests pending on the Etica vault. */
  pendingUnlocks: PendingUnlock[];
  /** Current chain time (unix seconds) used to mature unlock requests. */
  nowSec: bigint;
}

/** Minimal structured logger (console satisfies this). */
export type Logger = Pick<Console, 'info' | 'warn' | 'error'>;
