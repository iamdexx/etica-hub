/**
 * In-memory chain-client fakes + a recording logger for unit tests.
 *
 * They implement the `EticaClient` / `TronClient` interfaces exactly, record
 * every call, and let a test override any return value or force a throw — so we
 * can assert the executor's sequencing, budget math, and error isolation
 * without touching viem, tronweb, or a real RPC.
 */

import { vi } from 'vitest';
import type { EticaClient, TronClient, TronObservation } from '../src/chains/types.js';
import type { Hex, Logger, Registration } from '../src/types.js';

export interface RecordingLogger extends Logger {
  infos: string[];
  warns: string[];
  errors: string[];
}

export function makeLogger(): RecordingLogger {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    warns,
    errors,
    info: (...a: unknown[]) => infos.push(a.join(' ')),
    warn: (...a: unknown[]) => warns.push(a.join(' ')),
    error: (...a: unknown[]) => errors.push(a.join(' ')),
  };
}

export interface FakeEticaOptions {
  keeper?: Hex | null;
  registrations?: Registration[];
  quoteOut?: bigint;
}

export function makeEticaClient(opts: FakeEticaOptions = {}) {
  const client: EticaClient = {
    keeperAddress: vi.fn(() => opts.keeper ?? ('0xKEEPER0000000000000000000000000000000001' as Hex)),
    scanRegistrations: vi.fn(async () => opts.registrations ?? []),
    mintEtrx: vi.fn(async () => '0xmint' as Hex),
    approveEtrx: vi.fn(async () => '0xapprove' as Hex),
    quoteEtxOut: vi.fn(async () => opts.quoteOut ?? 1_000_000_000_000_000_000n),
    swapEtrxForEtx: vi.fn(async () => '0xswap' as Hex),
  };
  return client as EticaClient & { [K in keyof EticaClient]: ReturnType<typeof vi.fn> };
}

export interface FakeTronOptions {
  observation?: TronObservation;
  frontable?: bigint;
  mintTokenId?: bigint;
  claimAmountSun?: bigint;
}

export function makeTronClient(opts: FakeTronOptions = {}) {
  const observation: TronObservation = opts.observation ?? {
    mintedByResTokenId: new Map(),
    twins: [],
  };
  let nextTokenId = opts.mintTokenId ?? 1n;
  const client: TronClient = {
    scanTwins: vi.fn(async () => observation),
    frontableNow: vi.fn(async () => opts.frontable ?? 0n),
    mintTwin: vi.fn(async () => ({ txid: '0xtwin', tokenId: nextTokenId++ })),
    frontUpgrade: vi.fn(async () => '0xfront'),
    claimForPayout: vi.fn(async () => ({
      txid: '0xclaim',
      amountSun: opts.claimAmountSun ?? 1_000_000n,
    })),
    topUp: vi.fn(async () => '0xtopup'),
  };
  return client as TronClient & { [K in keyof TronClient]: ReturnType<typeof vi.fn> };
}
