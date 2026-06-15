/**
 * TRON chain adapter — tronweb.
 *
 * Twins are minted sequentially (`nextTokenId` starts at 1, `totalSupply`
 * tracks the count) and are never burned — the only exit is the Etica-side
 * unlock. So we enumerate the live set by walking `1..totalSupply` and reading
 * the public `miners` getter + `pendingReward`, which avoids depending on a
 * TronGrid event index (often gated behind an API key).
 *
 * Writes (mintTwin, frontUpgrade, claimForPayout, topUp) require a signer; in
 * dry-run the keeper never calls them, and a private key is never set.
 */

import { TronWeb } from 'tronweb';
import { TRX_RESERVE_TRON_ABI, WRAPPED_RES_MINER_TRON_ABI } from '../abi.js';
import type { WresKeeperConfig } from '../config.js';
import type { Hex, Logger, TwinRecord } from '../types.js';
import type { TronClient, TronObservation } from './types.js';

/** Minimal typed view over a tronweb contract method (call/send). */
interface TronMethod {
  call(options?: { callValue?: number; feeLimit?: number }): Promise<unknown>;
  send(options?: { callValue?: number; feeLimit?: number }): Promise<string>;
}

/** The WrappedRESMiner surface the keeper uses (tronweb is otherwise untyped). */
interface MinerContract {
  totalSupply(): TronMethod;
  miners(tokenId: bigint): TronMethod;
  pendingReward(tokenId: bigint): TronMethod;
  mintTwin(to: string, payoutWallet: string, resTokenId: bigint): TronMethod;
  claimForPayout(tokenId: bigint): TronMethod;
}

/** The TrxReserve surface the keeper uses. */
interface ReserveContract {
  frontableNow(): TronMethod;
  frontUpgrade(tokenId: bigint, amount: bigint): TronMethod;
  topUp(): TronMethod;
}

/** Coerce a tronweb numeric result (bigint | number | string | BigNumber). */
function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v);
  if (v !== null && typeof v === 'object' && 'toString' in v) {
    return BigInt((v as { toString(): string }).toString());
  }
  throw new Error(`tron: cannot convert to bigint: ${String(v)}`);
}

/** Read one named field off a struct-like tronweb result (object or tuple). */
function field(result: unknown, name: string, index: number): unknown {
  if (Array.isArray(result)) return result[index];
  if (result !== null && typeof result === 'object' && name in result) {
    return (result as Record<string, unknown>)[name];
  }
  throw new Error(`tron: field "${name}" missing on struct result`);
}

export function createTronClient(config: WresKeeperConfig, log: Logger): TronClient {
  const tronWeb = new TronWeb({ fullHost: config.tronRpcUrl });
  const hasSigner = Boolean(config.keeperTronPrivateKey);
  if (config.keeperTronPrivateKey) {
    tronWeb.setPrivateKey(config.keeperTronPrivateKey);
  }

  function requireSigner(): void {
    if (!hasSigner) {
      throw new Error('Tron signer not configured (WRES_KEEPER_TRON_PRIVATE_KEY unset)');
    }
  }

  /** EVM/Etica 20-byte address -> TRON base58 (shares the same 20 bytes). */
  function eticaToTronBase58(addr: Hex): string {
    return tronWeb.address.fromHex(`41${addr.slice(2)}`);
  }

  /** TRON address (base58 or 41-hex) -> Etica 0x address (last 20 bytes). */
  function tronToEticaHex(tronAddr: string): Hex {
    const hex = tronWeb.address.toHex(tronAddr);
    return `0x${hex.slice(-40)}` as Hex;
  }

  function miner(): MinerContract {
    if (!config.wrappedResMiner) throw new Error('WrappedRESMiner address unset');
    return tronWeb.contract(
      WRAPPED_RES_MINER_TRON_ABI as unknown as [],
      config.wrappedResMiner,
    ) as unknown as MinerContract;
  }

  function reserve(): ReserveContract {
    if (!config.trxReserve) throw new Error('TrxReserve address unset');
    return tronWeb.contract(
      TRX_RESERVE_TRON_ABI as unknown as [],
      config.trxReserve,
    ) as unknown as ReserveContract;
  }

  async function scanTwins(): Promise<TronObservation> {
    const mintedByResTokenId = new Map<string, bigint>();
    const twins: TwinRecord[] = [];
    if (!config.wrappedResMiner) {
      log.info('[tron] WrappedRESMiner unset — no twins to scan');
      return { mintedByResTokenId, twins };
    }

    const c = miner();
    const total = toBigInt(await c.totalSupply().call());
    for (let id = 1n; id <= total; id++) {
      const m = await c.miners(id).call();
      const resTokenId = toBigInt(field(m, 'resTokenId', 0));
      const payoutWallet = tronToEticaHex(String(field(m, 'payoutWallet', 1)));
      const pendingSun = toBigInt(await c.pendingReward(id).call());

      mintedByResTokenId.set(resTokenId.toString(), id);
      twins.push({ tokenId: id, resTokenId, payoutWallet, pendingSun });
    }

    log.info(`[tron] ${twins.length} twin(s) scanned (totalSupply=${total})`);
    return { mintedByResTokenId, twins };
  }

  async function frontableNow(): Promise<bigint> {
    if (!config.trxReserve) return 0n;
    return toBigInt(await reserve().frontableNow().call());
  }

  async function mintTwin(
    tronRecipient: Hex,
    payoutWallet: Hex,
    resTokenId: bigint,
  ): Promise<{ txid: string; tokenId: bigint }> {
    requireSigner();
    const c = miner();
    // Twin ids are assigned from `totalSupply + 1`; the keeper is the sole
    // minter and ticks are serialized, so this read is the new token's id.
    const tokenId = toBigInt(await c.totalSupply().call()) + 1n;
    const txid = await c
      .mintTwin(eticaToTronBase58(tronRecipient), eticaToTronBase58(payoutWallet), resTokenId)
      .send({ feeLimit: config.tronFeeLimitSun });
    return { txid, tokenId };
  }

  async function frontUpgrade(tokenId: bigint, amountSun: bigint): Promise<string> {
    requireSigner();
    return reserve()
      .frontUpgrade(tokenId, amountSun)
      .send({ feeLimit: config.tronFeeLimitSun });
  }

  async function claimForPayout(tokenId: bigint): Promise<{ txid: string; amountSun: bigint }> {
    requireSigner();
    const c = miner();
    // `pendingReward` equals exactly what `claimForPayout` settles + transfers.
    const amountSun = toBigInt(await c.pendingReward(tokenId).call());
    const txid = await c.claimForPayout(tokenId).send({ feeLimit: config.tronFeeLimitSun });
    return { txid, amountSun };
  }

  async function topUp(amountSun: bigint): Promise<string> {
    requireSigner();
    return reserve()
      .topUp()
      .send({ callValue: Number(amountSun), feeLimit: config.tronFeeLimitSun });
  }

  return { scanTwins, frontableNow, mintTwin, frontUpgrade, claimForPayout, topUp };
}
