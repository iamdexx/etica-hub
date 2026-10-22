import type { Address } from 'viem';

export interface PulseWindow {
  pair: Address;
  token0: Address;
  token1: Address;
  /** Unix seconds of the newest Swap, or null when none was found in the scan. */
  lastSwapAt: number | null;
  paused: boolean;
  /** Hub-backed liveReserves() of (token0, token1); both zero until the window is seeded. */
  reserves?: readonly [bigint, bigint];
  /** EticaDirectMetaPair (quoteOut/swapExactIn); false for a plain V2-style Direct pair. */
  meta?: boolean;
}

export function isSeeded(w: PulseWindow): boolean {
  return !w.reserves || (w.reserves[0] > 0n && w.reserves[1] > 0n);
}

/** One direction of a trip: a token path starting or ending in the EGAZ pool token. */
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
  const open = windows.filter((w) => !w.paused && isSeeded(w));
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
    (w) => !w.paused && isSeeded(w) && (w.lastSwapAt === null || now - w.lastSwapAt >= maxQuietSeconds),
  );
  const skipped: PulsePlan['skipped'] = windows
    .filter((w) => w.paused || !isSeeded(w))
    .map((w) => ({ pair: w.pair, reason: w.paused ? 'paused' : 'unseeded' }));
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

/** The leg that walks the first `hops` hops of `leg` back to its start. */
export function reverseLeg(leg: PulseLeg, hops: number): PulseLeg {
  return {
    path: leg.path.slice(0, hops + 1).reverse(),
    pairs: leg.pairs.slice(0, hops).reverse(),
  };
}

export function withSlippage(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

/** Reserve of `token` in the window, or null when unknown / not a side of it. */
export function reserveOf(w: PulseWindow, token: Address): bigint | null {
  if (!w.reserves) return null;
  if (same(w.token0, token)) return w.reserves[0];
  if (same(w.token1, token)) return w.reserves[1];
  return null;
}

/**
 * EGAZ to put through a trip: the configured amount, capped at `maxReserveBps`
 * of the EGAZ-side reserve of the first window so a $20 window is not asked to
 * absorb a trade it cannot fill.
 */
export function sizeTrip(input: {
  trip: PulseTrip;
  windows: PulseWindow[];
  wegaz: Address;
  amountWei: bigint;
  maxReserveBps: number;
}): bigint {
  const { trip, windows, wegaz, amountWei, maxReserveBps } = input;
  const first = windows.find((w) => same(w.pair, trip.out.pairs[0] as Address));
  const reserve = first ? reserveOf(first, wegaz) : null;
  if (reserve === null) return amountWei;
  const cap = (reserve * BigInt(maxReserveBps)) / 10_000n;
  return cap < amountWei ? cap : amountWei;
}
