/**
 * Etica (L1) chain adapter — viem.
 *
 * Chain-agnostic registration scanning: reads new research registrations from
 * a configurable source (currently returns an empty list — registrations are
 * expected to come from the TRON-side `ResearchSovereignRegistry` or a local
 * queue in the future). Writes (eTRX mint/approve, DEX swap) require a wallet;
 * without a signer they throw, and the executor never calls them in dry-run.
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
import { ETRX_ABI } from '../abi.js';
import type { WresKeeperConfig } from '../config.js';
import type { Hex, Logger, Registration } from '../types.js';
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

  async function scanRegistrations(): Promise<Registration[]> {
    // Chain-agnostic: registrations come from any origin chain. For now this
    // returns an empty list — new entries are expected to be driven by the
    // TRON-side ResearchSovereignRegistry.register() or a local queue.
    // Future adapters per origin chain plug in here.
    log.info('[etica] scanRegistrations: 0 pending (no origin-chain source configured)');
    return [];
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
    scanRegistrations,
    mintEtrx,
    approveEtrx,
    quoteEtxOut,
    swapEtrxForEtx,
  };
}
