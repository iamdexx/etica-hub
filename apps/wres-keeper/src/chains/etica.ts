/**
 * Etica (L1) chain adapter — viem.
 *
 * Reads `Locked` / `UnlockRequested` events from the RESLockVault and confirms
 * each against the authoritative `locks` getter. Writes (executeUnlock, eTRX
 * mint/approve, DEX swap) require a wallet; without a signer they throw, and the
 * executor never calls them in dry-run.
 */

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { routerAbi } from '@etica-hub/shared/abis';
import { ETRX_ABI, RES_LOCK_VAULT_ABI } from '../abi.js';
import type { WresKeeperConfig } from '../config.js';
import type { Hex, LockRecord, Logger, PendingUnlock } from '../types.js';
import type { EticaClient } from './types.js';

/** Deadline helper: now + 20 minutes, in seconds. */
function swapDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
}

export function createEticaClient(config: WresKeeperConfig, log: Logger): EticaClient {
  const transport = http(config.eticaRpcUrl);
  const publicClient: PublicClient = createPublicClient({ transport });

  const account = config.keeperEticaPrivateKey
    ? privateKeyToAccount(config.keeperEticaPrivateKey)
    : null;
  const walletClient: WalletClient | null = account
    ? createWalletClient({ account, transport })
    : null;

  function requireWallet(): { wallet: WalletClient; account: NonNullable<typeof account> } {
    if (!walletClient || !account) {
      throw new Error('Etica wallet not configured (WRES_KEEPER_ETICA_PRIVATE_KEY unset)');
    }
    return { wallet: walletClient, account };
  }

  function keeperAddress(): Hex | null {
    return account ? (account.address as Hex) : null;
  }

  async function scanRange(): Promise<{ vault: Address; fromBlock: bigint; toBlock: bigint }> {
    if (!config.resLockVault) throw new Error('RESLockVault address unset');
    const head = await publicClient.getBlockNumber();
    const lookback = BigInt(config.scanLookbackBlocks);
    const fromBlock = head > lookback ? head - lookback : 0n;
    return { vault: config.resLockVault, fromBlock, toBlock: head };
  }

  async function scanActiveLocks(): Promise<LockRecord[]> {
    if (!config.resLockVault) return [];
    const { vault, fromBlock, toBlock } = await scanRange();

    const logs = await publicClient.getContractEvents({
      address: vault,
      abi: RES_LOCK_VAULT_ABI,
      eventName: 'Locked',
      fromBlock,
      toBlock,
    });

    // De-duplicate by resTokenId (a token can only be locked once at a time).
    const seen = new Set<string>();
    const out: LockRecord[] = [];
    for (const entry of logs) {
      const resTokenId = entry.args.resTokenId;
      if (resTokenId === undefined) continue;
      const key = resTokenId.toString();
      if (seen.has(key)) continue;
      seen.add(key);

      // Authoritative: only keep locks the vault still reports as active.
      const lock = await publicClient.readContract({
        address: vault,
        abi: RES_LOCK_VAULT_ABI,
        functionName: 'locks',
        args: [resTokenId],
      });
      const [owner, payoutWallet, tronRecipient, , , active] = lock;
      if (!active) continue;

      out.push({
        resTokenId,
        owner: owner as Hex,
        tronRecipient: tronRecipient as Hex,
        payoutWallet: payoutWallet as Hex,
      });
    }
    log.info(`[etica] ${out.length} active lock(s) found`);
    return out;
  }

  async function scanPendingUnlocks(): Promise<PendingUnlock[]> {
    if (!config.resLockVault) return [];
    const { vault, fromBlock, toBlock } = await scanRange();

    const logs = await publicClient.getContractEvents({
      address: vault,
      abi: RES_LOCK_VAULT_ABI,
      eventName: 'UnlockRequested',
      fromBlock,
      toBlock,
    });

    const seen = new Set<string>();
    const out: PendingUnlock[] = [];
    for (const entry of logs) {
      const resTokenId = entry.args.resTokenId;
      if (resTokenId === undefined) continue;
      const key = resTokenId.toString();
      if (seen.has(key)) continue;
      seen.add(key);

      // Authoritative: read the live request state (a veto resets readyAt to 0).
      const lock = await publicClient.readContract({
        address: vault,
        abi: RES_LOCK_VAULT_ABI,
        functionName: 'locks',
        args: [resTokenId],
      });
      const [, , , , unlockReadyAt, active] = lock;
      out.push({ resTokenId, unlockReadyAt: BigInt(unlockReadyAt), active });
    }
    log.info(`[etica] ${out.length} pending unlock request(s) found`);
    return out;
  }

  async function now(): Promise<bigint> {
    const block = await publicClient.getBlock();
    return block.timestamp;
  }

  async function executeUnlock(resTokenId: bigint): Promise<Hex> {
    if (!config.resLockVault) throw new Error('RESLockVault address unset');
    const { wallet, account } = requireWallet();
    return wallet.writeContract({
      account,
      chain: null,
      address: config.resLockVault,
      abi: RES_LOCK_VAULT_ABI,
      functionName: 'executeUnlock',
      args: [resTokenId],
    });
  }

  async function mintEtrx(to: Hex, amountWei: bigint): Promise<Hex> {
    if (!config.etrx) throw new Error('ETRX address unset');
    const { wallet, account } = requireWallet();
    return wallet.writeContract({
      account,
      chain: null,
      address: config.etrx,
      abi: ETRX_ABI,
      functionName: 'mint',
      args: [getAddress(to), amountWei],
    });
  }

  async function approveEtrx(amountWei: bigint): Promise<Hex> {
    if (!config.etrx || !config.dexRouter) {
      throw new Error('ETRX / DEX router address unset — cannot approve');
    }
    const { wallet, account } = requireWallet();
    return wallet.writeContract({
      account,
      chain: null,
      address: config.etrx,
      abi: ETRX_ABI,
      functionName: 'approve',
      args: [config.dexRouter, amountWei],
    });
  }

  async function quoteEtxOut(amountInWei: bigint): Promise<bigint> {
    if (!config.dexRouter || !config.etrx || !config.etx) {
      throw new Error('DEX router / ETRX / ETX address unset — cannot quote');
    }
    const path: Address[] = [config.etrx, config.etx];
    const amounts = await publicClient.readContract({
      address: config.dexRouter,
      abi: routerAbi,
      functionName: 'getAmountsOut',
      args: [amountInWei, path],
    });
    const last = amounts[amounts.length - 1];
    if (last === undefined) throw new Error('getAmountsOut returned no output');
    return last;
  }

  async function swapEtrxForEtx(amountInWei: bigint, minOutWei: bigint, to: Hex): Promise<Hex> {
    if (!config.dexRouter || !config.etrx || !config.etx) {
      throw new Error('DEX router / ETRX / ETX address unset — cannot swap');
    }
    const { wallet, account } = requireWallet();
    const path: Address[] = [config.etrx, config.etx];
    return wallet.writeContract({
      account,
      chain: null,
      address: config.dexRouter,
      abi: routerAbi,
      functionName: 'swapExactTokensForTokens',
      args: [amountInWei, minOutWei, path, getAddress(to), swapDeadline()],
    });
  }

  return {
    keeperAddress,
    scanActiveLocks,
    scanPendingUnlocks,
    now,
    executeUnlock,
    mintEtrx,
    approveEtrx,
    quoteEtxOut,
    swapEtrxForEtx,
  };
}
