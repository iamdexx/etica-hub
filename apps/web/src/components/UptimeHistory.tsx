import { availabilityPct, bucketize, loadUptimeSamples, type UptimeBucket } from '@/lib/uptime';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function tone(b: UptimeBucket): string {
  if (b.total === 0) return 'bg-white/10';
  const ratio = b.ok / b.total;
  if (ratio === 1) return 'bg-emerald-400';
  if (ratio >= 0.5) return 'bg-amber-400';
  return 'bg-rose-500';
}

function label(b: UptimeBucket): string {
  const when = new Date(b.start).toISOString().slice(0, 16).replace('T', ' ');
  if (b.total === 0) return `${when} UTC — no samples`;
  return `${when} UTC — ${b.ok}/${b.total} healthy`;
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(v >= 99.95 ? 2 : 1)}%`;
}

function Strip({ title, buckets, pct }: { title: string; buckets: UptimeBucket[]; pct: number | null }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="uppercase tracking-wider text-white/40">{title}</span>
        <span className="font-mono text-emerald-200">{fmtPct(pct)}</span>
      </div>
      <div className="mt-2 flex gap-[2px]">
        {buckets.map((b) => (
          <span key={b.start} title={label(b)} className={`h-6 flex-1 rounded-sm ${tone(b)}`} />
        ))}
      </div>
    </div>
  );
}

export async function UptimeHistory() {
  const now = Date.now();
  let samples: Awaited<ReturnType<typeof loadUptimeSamples>> = [];
  let error: string | null = null;
  try {
    samples = await loadUptimeSamples(now - 7 * DAY_MS);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const latest = samples.at(-1);

  return (
    <div className="rounded-2xl border border-white/10 bg-[#07120f] p-5">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-white/40">Uptime history</div>
        {latest ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              latest.ok ? 'bg-emerald-400/15 text-emerald-200' : 'bg-rose-500/15 text-rose-200'
            }`}
          >
            {latest.ok ? 'operational' : 'degraded'} · {new Date(latest.at).toISOString().slice(11, 16)} UTC
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="mt-3 text-xs text-rose-300">History unavailable: {error}</p>
      ) : samples.length === 0 ? (
        <p className="mt-3 text-xs text-white/50">
          Collecting samples — the telemetry cron records chain health every 15 minutes.
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          <Strip title="Last 24 hours (hourly)" buckets={bucketize(samples, HOUR_MS, 24, now)} pct={availabilityPct(samples, now - DAY_MS, now)} />
          <Strip title="Last 7 days (6h)" buckets={bucketize(samples, 6 * HOUR_MS, 28, now)} pct={availabilityPct(samples, now - 7 * DAY_MS, now)} />
          <p className="text-[11px] text-white/40">
            {samples.length} samples · healthy = RPC reachable, factory decodes, head block &lt; 120s old; missed 15-min samples count as downtime.{' '}
            <a href="/api/v1/uptime" className="underline decoration-white/20 hover:text-white/70">JSON</a>
          </p>
        </div>
      )}
    </div>
  );
}
