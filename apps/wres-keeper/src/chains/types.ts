/**
 * Chain-client interfaces.
 *
 * The keeper's orchestration (keeper.ts / executor.ts) depends only on these
 * interfaces, never on viem or tronweb directly. That keeps the decision logic
 * unit-testable with in-memory fakes and isolates all RPC/signing concerns to
 * the `etica.ts` / `tron.ts` adapters.
 *
 * Every write method is a no-op stub on the read-only adapters used in
 * dry-run, so a missing signer can never broadcast.
 */

import type { Hex, Registration, TwinRecord } from '../types.js';

/** Read + write surface for the Etica (L1) side. */
export interface EticaClient {
  /** The keeper's own Etica address (null in dry-run with no signer). */
  keeperAddress(): Hex | null;
  /**
   * Scan for research registrations awaiting a TRON twin. Chain-agnostic:
   * could read from any origin chain's event log or a local registry.
   */
  scanRegistrations(): Promise<Registration[]>;
  /** Mint eTRX 1:1 against TRX revenue locked on TRON (payout leg). */
  mintEtrx(to: Hex, amountWei: bigint): Promise<Hex>;
  /** Approve the DEX router to spend `amountWei` of the keeper's eTRX. */
  approveEtrx(amountWei: bigint): Promise<Hex>;
  /** Quote the ETX out for `amountInWei` of eTRX along the eTRX->ETX path. */
  quoteEtxOut(amountInWei: bigint): Promise<bigint>;
  /** Swap eTRX -> ETX on the DEX and deliver ETX to `to`. */
  swapEtrxForEtx(amountInWei: bigint, minOutWei: bigint, to: Hex): Promise<Hex>;
}

/** Snapshot of the TRON side gathered each tick. */
export interface TronObservation {
  /** resTokenId (as string) -> minted twin tokenId, from `TwinMinted` events. */
  mintedByResTokenId: Map<string, bigint>;
  /** Known twins with their settled-but-unclaimed reward. */
  twins: TwinRecord[];
}

/** Read + write surface for the TRON side. */
export interface TronClient {
  /** Enumerate minted twins + their pending rewards. */
  scanTwins(): Promise<TronObservation>;
  /** TRX (SUN) the reserve can front this epoch (min of balance, drip cap). */
  frontableNow(): Promise<bigint>;
  /** Mint a twin bound to a payout wallet; returns txid + new tokenId. */
  mintTwin(
    tronRecipient: Hex,
    payoutWallet: Hex,
    resTokenId: bigint,
  ): Promise<{ txid: string; tokenId: bigint }>;
  /** Freeze reserve TRX (SUN) into a twin on the holder's behalf. */
  frontUpgrade(tokenId: bigint, amountSun: bigint): Promise<string>;
  /** Pull a twin's settled reward to the distributor; returns claimed SUN. */
  claimForPayout(tokenId: bigint): Promise<{ txid: string; amountSun: bigint }>;
  /** Refill the reserve with `amountSun` (the 1% revenue top-up). */
  topUp(amountSun: bigint): Promise<string>;
}
