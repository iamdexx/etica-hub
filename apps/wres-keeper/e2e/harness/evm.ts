/**
 * EVM (anvil) side of the harness — thin viem wrapper for deploys, reads, writes
 * and anvil-specific time travel. Account #0 is the deployer / keeper / locker.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ETICA_CHAIN_ID, ETICA_RPC_URL, EVM_KEEPER_PK } from './config.js';
import type { Artifact } from './artifacts.js';

export const localEtica = defineChain({
  id: ETICA_CHAIN_ID,
  name: 'Local Etica (anvil)',
  nativeCurrency: { name: 'Etica', symbol: 'ETI', decimals: 18 },
  rpcUrls: { default: { http: [ETICA_RPC_URL] } },
});

export class Evm {
  readonly account = privateKeyToAccount(EVM_KEEPER_PK as `0x${string}`);
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;

  constructor() {
    const transport = http(ETICA_RPC_URL);
    this.publicClient = createPublicClient({ chain: localEtica, transport });
    this.walletClient = createWalletClient({ account: this.account, chain: localEtica, transport });
  }

  async deploy(artifact: Artifact, args: unknown[] = []): Promise<Address> {
    const hash = await this.walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args,
      account: this.account,
      chain: localEtica,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error('deploy produced no contract address');
    return receipt.contractAddress;
  }

  async write(address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<void> {
    const hash = await this.walletClient.writeContract({
      address,
      abi,
      functionName,
      args,
      account: this.account,
      chain: localEtica,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`tx ${functionName} reverted: ${hash}`);
  }

  async read<T = unknown>(address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
    return this.publicClient.readContract({ address, abi, functionName, args }) as Promise<T>;
  }

  /** anvil time travel: jump `seconds` forward and mine a block to apply it. */
  async increaseTime(seconds: number): Promise<void> {
    await this.rpc('evm_increaseTime', [seconds]);
    await this.rpc('evm_mine', []);
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(ETICA_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`${method} failed: ${json.error.message}`);
    return json.result;
  }
}
