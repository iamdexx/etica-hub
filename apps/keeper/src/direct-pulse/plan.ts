import type { Address } from 'viem';

export interface PulseWindow {
  pair: Address;
  token0: Address;
  token1: Address;
  /** Unix seconds of the newest Swap, or null when none was found in the scan. */
  lastSwapAt: number | null;
  paused: boolean;
}

/** One router call: a token path starting or ending in WEGAZ (EGAZ in, EGAZ out). */
export interface PulseLeg {
  path: Address[];
  /** Windows this leg trades through, in path order. */
  pairs: Address[];
}

export interface PulseTrip {
  /** The quiet window this trip exists for. */
  target: Address;
  out: PulseLeg;
  back: PulseLeg;
}

export interface PulsePlan {
  trips: PulseTrip[];
  quiet: Address[];
  skipped: { pair: Address; reason: string }[];
}

const low = (a: Address) => a.toLowerCase();
const same = (a: Address, b: Address) => low(a) === low(b);

function pairBetween(windows: PulseWindow[], a: Address, b: Address): PulseWindow | undefined {
  return windows.find(
    (w) => (same(w.token0, a) && same(w.token1, b)) || (same(w.token0, b) && same(w.token1, a)),
  );
}

/** Shortest token path from `from` to `to` over open windows (BFS), or null. */
export function shortestPath(windows: PulseWindow[], from: Address, to: Address): Address[] | null {
  if (same(from, to)) return [from];
  const open = windows.filter((w) => !w.paused);
  const prev = new Map<string, Address>();
  const seen = new Set<string>([low(from)]);
  const queue: Address[] = [from];
  while (queue.length) {
    const cur = queue.shift() as Address;
    for (const w of open) {
      let next: Address | null = null;
      if (same(w.token0, cur)) next = w.token1;
      else if (same(w.token1, cur)) next = w.token0;
      if (!next || seen.has(low(next))) continue;
      seen.add(low(next));
      prev.set(low(next), cur);
      if (same(next, to)) {
        const path: Address[] = [to];
        let p: Address | undefined = cur;
        while (p) {
          path.unshift(p);
          p = prev.get(low(p));
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

function legFor(windows: PulseWindow[], path: Address[]): PulseLeg {
  const pairs: Address[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i] as Address;
    const b = path[i + 1] as Address;
    const w = pairBetween(windows, a, b);
    if (!w) throw new Error(`no window for ${a} -> ${b}`);
    pairs.push(w.pair);
  }
  return { path, pairs };
}

/**
 * One EGAZ round trip per quiet window: EGAZ -> ... -> far side of the
 * window, then straight back to EGAZ. Windows already crossed by an earlier
 * trip count as pulsed and get no trip of their own.
 */
export function buildPulsePlan(input: {
  windows: PulseWindow[];
  wegaz: Address;
  now: number;
  maxQuietSeconds: number;
}): PulsePlan {
  const { windows, wegaz, now, maxQuietSeconds } = input;
  const quiet = windows.filter(
    (w) => !w.paused && (w.lastSwapAt === null || now - w.lastSwapAt >= maxQuietSeconds),
  );
  const skipped: PulsePlan['skipped'] = windows
    .filter((w) => w.paused)
    .map((w) => ({ pair: w.pair, reason: 'paused' }));
  const touched = new Set<string>();
  const trips: PulseTrip[] = [];
  for (const w of quiet) {
    if (touched.has(low(w.pair))) continue;
    // Enter on whichever side is closer to EGAZ, exit through the other.
    const candidates = [
      [w.token0, w.token1],
      [w.token1, w.token0],
    ] as const;
    let best: PulseTrip | null = null;
    for (const [near, far] of candidates) {
      if (same(far, wegaz)) continue;
      const toNear = shortestPath(windows, wegaz, near);
      const home = shortestPath(windows, far, wegaz);
      if (!toNear || !home) continue;
      const outPath = [...toNear, far];
      const trip: PulseTrip = { target: w.pair, out: legFor(windows, outPath), back: legFor(windows, home) };
      const hops = trip.out.pairs.length + trip.back.pairs.length;
      if (!best || hops < best.out.pairs.length + best.back.pairs.length) best = trip;
    }
    if (!best) {
      skipped.push({ pair: w.pair, reason: 'no EGAZ route' });
      continue;
    }
    trips.push(best);
    for (const p of [...best.out.pairs, ...best.back.pairs]) touched.add(low(p));
  }
  return { trips, quiet: quiet.map((w) => w.pair), skipped };
}

export function withSlippage(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}
