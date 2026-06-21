/**
 * TRON (java-tron) side of the harness — deploy + read/write over tronweb.
 * Account #0 (the keeper) deploys and owns the miner + reserve.
 */

import { TronWeb } from 'tronweb';
import { TRON_KEEPER_PK, TRON_RPC_URL } from './config.js';
import type { Artifact } from './artifacts.js';

export type Abi = readonly unknown[];

export class Tron {
  readonly tronWeb: TronWeb;
  readonly ownerBase58: string;
  readonly ownerHex: string;

  constructor() {
    const key = TRON_KEEPER_PK.replace(/^0x/, '');
    this.tronWeb = new TronWeb({ fullHost: TRON_RPC_URL, privateKey: key });
    this.ownerBase58 = this.tronWeb.address.fromPrivateKey(key) as string;
    this.ownerHex = this.tronWeb.address.toHex(this.ownerBase58);
  }

  /** base58 (T...) for a private key. */
  addressOf(privateKey: string): string {
    return this.tronWeb.address.fromPrivateKey(privateKey.replace(/^0x/, '')) as string;
  }

  toHex(addr: string): string {
    return this.tronWeb.address.toHex(addr);
  }

  /** EVM 0x-form (last 20 bytes) of a TRON address — what the vault stores. */
  toEvm(addr: string): `0x${string}` {
    return `0x${this.tronWeb.address.toHex(addr).slice(-40)}`;
  }

  private async waitTx(txid: string): Promise<void> {
    for (let i = 0; i < 90; i++) {
      const info = await this.tronWeb.trx.getTransactionInfo(txid);
      if (info && (info as { id?: string }).id) {
        const result = (info as { receipt?: { result?: string } }).receipt?.result;
        if (result && result !== 'SUCCESS') {
          throw new Error(`tx ${txid} failed: ${result}`);
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`tx not confirmed: ${txid}`);
  }

  async deploy(name: string, artifact: Artifact, parameters: unknown[] = []): Promise<string> {
    const tx = await this.tronWeb.transactionBuilder.createSmartContract(
      {
        abi: artifact.abi as never,
        bytecode: artifact.bytecodeRaw,
        feeLimit: 1_000_000_000,
        callValue: 0,
        userFeePercentage: 100,
        originEnergyLimit: 10_000_000,
        parameters,
      } as never,
      this.ownerHex,
    );
    const signed = await this.tronWeb.trx.sign(tx);
    await this.tronWeb.trx.sendRawTransaction(signed);
    await this.waitTx(tx.txID);
    const base58 = this.tronWeb.address.fromHex(tx.contract_address) as string;
    return base58;
  }

  contract(abi: Abi, address: string) {
    return this.tronWeb.contract(abi as never, address);
  }

  /** Send a state-changing call (optionally with TRX value), wait for receipt. */
  async send(
    abi: Abi,
    address: string,
    method: string,
    args: unknown[] = [],
    opts: { callValue?: number; feeLimit?: number } = {},
  ): Promise<string> {
    const c = this.contract(abi, address) as unknown as Record<string, (...a: unknown[]) => {
      send: (o: { callValue?: number; feeLimit?: number }) => Promise<string>;
    }>;
    const txid = await c[method](...args).send({ feeLimit: 1_000_000_000, ...opts });
    await this.waitTx(txid);
    return txid;
  }

  async call<T = unknown>(abi: Abi, address: string, method: string, args: unknown[] = []): Promise<T> {
    const c = this.contract(abi, address) as unknown as Record<string, (...a: unknown[]) => {
      call: () => Promise<T>;
    }>;
    return c[method](...args).call();
  }

  /** TRX balance of a contract/account, in SUN. */
  async balanceSun(address: string): Promise<bigint> {
    return BigInt(await this.tronWeb.trx.getBalance(address));
  }
}

/** Coerce a tronweb return value (BN / hex / number / {_hex}) into a bigint. */
export function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v);
  if (v && typeof v === 'object') {
    const obj = v as { _hex?: string; toString?: () => string };
    if (typeof obj._hex === 'string') return BigInt(obj._hex);
    if (typeof obj.toString === 'function') return BigInt(obj.toString());
  }
  throw new Error(`cannot coerce to bigint: ${String(v)}`);
}
