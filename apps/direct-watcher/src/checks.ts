/**
 * Pure invariant checks over a chain snapshot. No I/O here so the rules
 * are unit-testable; `watch.ts` builds the snapshot and acts on findings.
 *
 * Severity:
 *   critical — funds-affecting invariant broke; the watcher auto-pauses
 *              swaps when it holds the guardian key.
 *   warning  — settings drift or price skew; operator should look.
 *   info     — notable but expected activity (large swap, loose tokens).
 */

import type { Address } from 'viem';
import type { ExpectedSettings } from './config.js';

export type Severity = 'critical' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
}

export interface WindowSnapshot {
  pair: Address;
  token0: Address;
  token1: Address;
  retired: boolean;
  lp0: bigint;
  lp1: bigint;
  r0: bigint;
  r1: bigint;
  /** Hub cross price r1/r0 as (num, den) derived from the two hub pools. */
  hubPriceNum: bigint;
  hubPriceDen: bigint;
  /** Raw token0 / token1 / ETX sitting in the window at rest. */
  loose0: bigint;
  loose1: bigint;
  looseEtx: bigint;
  swaps: { amount0In: bigint; amount1In: bigint; sender: Address; txHash: `0x${string}` }[];
}

export interface FactorySnapshot {
  feeTo: Address;
  feeToSetter: Address;
  guardian: Address;
  metaPairDeployer: Address;
  swapsPaused: boolean;
  /** Unix seconds a guardian pause lapses; 0 for a setter pause or when open. */
  pauseExpiresAt: number;
  minStEtx: bigint;
  baseFeeBps: number;
  tiers: { minStEtx: bigint; feeBps: number }[];
  whitelisted: Record<string, boolean>;
}

export interface WindowState {
  lp0: string;
  lp1: string;
}

export interface WatcherState {
  lastBlock: string;
  windows: Record<string, WindowState>;
}

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function checkFactory(snap: FactorySnapshot, expected: ExpectedSettings): Finding[] {
  const out: Finding[] = [];
  const crit = (code: string, field: string, want: string, got: string) =>
    out.push({ severity: 'critical', code, message: `${field} changed: expected ${want}, on-chain ${got}` });
  const warn = (code: string, field: string, want: string, got: string) =>
    out.push({ severity: 'warning', code, message: `${field} changed: expected ${want}, on-chain ${got}` });

  if (expected.feeTo && !eq(expected.feeTo, snap.feeTo)) crit('FEE_TO', 'feeTo', expected.feeTo, snap.feeTo);
  if (expected.feeToSetter && !eq(expected.feeToSetter, snap.feeToSetter))
    crit('FEE_TO_SETTER', 'feeToSetter', expected.feeToSetter, snap.feeToSetter);
  if (expected.metaPairDeployer && !eq(expected.metaPairDeployer, snap.metaPairDeployer))
    crit('DEPLOYER', 'metaPairDeployer', expected.metaPairDeployer, snap.metaPairDeployer);
  if (expected.guardian && !eq(expected.guardian, snap.guardian))
    warn('GUARDIAN', 'guardian', expected.guardian, snap.guardian);
  if (expected.minStEtx !== undefined && BigInt(expected.minStEtx) !== snap.minStEtx)
    warn('MIN_STETX', 'minStEtx', expected.minStEtx, snap.minStEtx.toString());
  if (expected.baseFeeBps !== undefined && expected.baseFeeBps !== snap.baseFeeBps)
    warn('BASE_FEE', 'baseFeeBps', String(expected.baseFeeBps), String(snap.baseFeeBps));
  if (expected.tiers) {
    const want = expected.tiers.map((t) => `${t.minStEtx}:${t.feeBps}`).join(',');
    const got = snap.tiers.map((t) => `${t.minStEtx}:${t.feeBps}`).join(',');
    if (want !== got) warn('TIERS', 'fee ladder', want || '(none)', got || '(none)');
  }
  for (const a of expected.whitelist ?? []) {
    if (!snap.whitelisted[a.toLowerCase()])
      crit('WHITELIST', `whitelist[${a}]`, 'true', 'false');
  }
  for (const [a, allowed] of Object.entries(snap.whitelisted)) {
    if (allowed && !(expected.whitelist ?? []).some((w) => eq(w, a)))
      crit('WHITELIST_EXTRA', `whitelist[${a}]`, 'false', 'true');
  }
  if (snap.swapsPaused) {
    const until = snap.pauseExpiresAt
      ? `guardian pause, reopens by itself ${new Date(snap.pauseExpiresAt * 1000).toISOString()} unless the multisig unpauses first`
      : 'setter pause, holds until the multisig unpauses';
    out.push({ severity: 'warning', code: 'PAUSED', message: `swaps are paused on the venue (${until})` });
  }
  return out;
}

export function checkWindow(
  w: WindowSnapshot,
  prev: WindowState | undefined,
  reserveDriftBps: number,
  largeSwapBps: number,
): Finding[] {
  const out: Finding[] = [];
  const tag = `${w.pair}`;
  if (prev) {
    if (w.lp0 < BigInt(prev.lp0) || w.lp1 < BigInt(prev.lp1)) {
      out.push({
        severity: 'critical',
        code: 'LP_DECREASED',
        message: `${tag} hub LP went down: ${prev.lp0}/${prev.lp1} -> ${w.lp0}/${w.lp1}`,
      });
    }
  }
  if (w.retired) {
    out.push({ severity: 'info', code: 'RETIRED', message: `${tag} is retired (swaps off)` });
  }
  // reported r1/r0 vs hub cross price num/den, in bps
  if (w.r0 > 0n && w.hubPriceDen > 0n && w.hubPriceNum > 0n) {
    const lhs = w.r1 * w.hubPriceDen; // r1 * den
    const rhs = w.r0 * w.hubPriceNum; // r0 * num
    const diff = lhs > rhs ? lhs - rhs : rhs - lhs;
    const driftBps = Number((diff * 10_000n) / rhs);
    if (driftBps > reserveDriftBps) {
      out.push({
        severity: 'warning',
        code: 'RESERVE_DRIFT',
        message: `${tag} reported price is ${driftBps} bps off the hub (call sync(), or hub was moved)`,
      });
    }
  }
  if (w.loose0 > 0n || w.loose1 > 0n || w.looseEtx > 0n) {
    out.push({
      severity: 'info',
      code: 'LOOSE_TOKENS',
      message: `${tag} holds loose tokens at rest: ${w.loose0}/${w.loose1}/${w.looseEtx} ETX (prepaid or donated)`,
    });
  }
  for (const s of w.swaps) {
    const in0 = s.amount0In > 0n;
    const amount = in0 ? s.amount0In : s.amount1In;
    const reserve = in0 ? w.r0 : w.r1;
    if (reserve > 0n && amount * 10_000n > reserve * BigInt(largeSwapBps)) {
      out.push({
        severity: 'info',
        code: 'LARGE_SWAP',
        message: `${tag} swap of ${amount} ${in0 ? 'token0' : 'token1'} (${Number((amount * 10_000n) / reserve)} bps of reserve) by ${s.sender} ${s.txHash}`,
      });
    }
  }
  return out;
}

export function nextState(
  windows: WindowSnapshot[],
  prev: WatcherState | undefined,
  head: bigint,
): WatcherState {
  const out: WatcherState = { lastBlock: head.toString(), windows: { ...(prev?.windows ?? {}) } };
  for (const w of windows) {
    const key = w.pair.toLowerCase();
    const old = out.windows[key];
    // never lower the floor: a decrease is a finding, not a new baseline
    const lp0 = old && BigInt(old.lp0) > w.lp0 ? old.lp0 : w.lp0.toString();
    const lp1 = old && BigInt(old.lp1) > w.lp1 ? old.lp1 : w.lp1.toString();
    out.windows[key] = { lp0, lp1 };
  }
  return out;
}

export function worst(findings: Finding[]): Severity | undefined {
  if (findings.some((f) => f.severity === 'critical')) return 'critical';
  if (findings.some((f) => f.severity === 'warning')) return 'warning';
  if (findings.length) return 'info';
  return undefined;
}
