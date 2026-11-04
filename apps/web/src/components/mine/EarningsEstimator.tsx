'use client';

import { useEffect, useState } from 'react';

interface CoinEarnings {
  priceUsd: number | null;
  networkHashrate: number;
  secondsPerReward: number;
  coinsPerDayPerUnit: number;
  usdPerDayPerUnit: number | null;
  unit: 'MH/s' | 'kH/s';
}

interface MinerEarnings {
  updatedAt: string;
  egaz: CoinEarnings | null;
  eti: CoinEarnings | null;
}

const KEY = 'eticahub-mine.estimator';

function fmt(n: number, maxFrac = 2): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
}

function usd(n: number | null): string {
  if (n === null) return '—';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function hash(h: number): string {
  if (h >= 1e9) return `${fmt(h / 1e9)} GH/s`;
  if (h >= 1e6) return `${fmt(h / 1e6)} MH/s`;
  if (h >= 1e3) return `${fmt(h / 1e3)} kH/s`;
  return `${fmt(h)} H/s`;
}

/** Live per-device earnings: ETI on the CPU, EGAZ on the GPU, from network difficulty and our price API. */
export function EarningsEstimator() {
  const [data, setData] = useState<MinerEarnings | null>(null);
  const [failed, setFailed] = useState(false);
  const [cpuKh, setCpuKh] = useState(2);
  const [gpuMh, setGpuMh] = useState(30);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { cpuKh?: number; gpuMh?: number } | null;
      if (saved?.cpuKh) setCpuKh(saved.cpuKh);
      if (saved?.gpuMh) setGpuMh(saved.gpuMh);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify({ cpuKh, gpuMh })); } catch { /* ignore */ }
  }, [cpuKh, gpuMh]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/miner/earnings')
        .then((r) => r.json())
        .then((j: MinerEarnings) => { if (alive) { setData(j); setFailed(false); } })
        .catch(() => { if (alive) setFailed(true); });
    void load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const eti = data?.eti ?? null;
  const egaz = data?.egaz ?? null;
  const etiCoins = eti ? eti.coinsPerDayPerUnit * cpuKh : null;
  const egazCoins = egaz ? egaz.coinsPerDayPerUnit * gpuMh : null;
  const etiUsd = eti?.usdPerDayPerUnit != null ? eti.usdPerDayPerUnit * cpuKh : null;
  const egazUsd = egaz?.usdPerDayPerUnit != null ? egaz.usdPerDayPerUnit * gpuMh : null;
  const total = etiUsd !== null || egazUsd !== null ? (etiUsd ?? 0) + (egazUsd ?? 0) : null;

  return (
    <section className="surface space-y-4 p-5 md:p-6" aria-labelledby="mine-earn">
      <h2 id="mine-earn" className="text-xl font-semibold">What your machine earns</h2>
      <p className="text-sm text-white/65">
        Live from network difficulty and EticaHub prices, before the 0.5% pool fee and your power bill. The miner runs
        both at once: ETI on the CPU, EGAZ on the GPU. Type what your hardware does.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-white/60">CPU, RandomX (kH/s)</span>
          <input
            type="number" min={0.1} step={0.5} value={cpuKh} inputMode="decimal"
            onChange={(e) => setCpuKh(Math.max(0, Number(e.target.value) || 0))}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono"
          />
          <span className="block text-xs text-white/50">Laptop 1–3 · desktop 4–10 · Ryzen 9 / Threadripper 15–40</span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-white/60">GPU, etchash (MH/s)</span>
          <input
            type="number" min={1} step={1} value={gpuMh} inputMode="decimal"
            onChange={(e) => setGpuMh(Math.max(0, Number(e.target.value) || 0))}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono"
          />
          <span className="block text-xs text-white/50">Laptop GPU 10–20 · RTX 3060 / RX 6600 ~30 · RTX 3080 ~95</span>
        </label>
      </div>
      <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-white/60">ETI / day (CPU)</dt>
          <dd className="font-mono text-lg">{etiCoins === null ? (failed ? '—' : '…') : fmt(etiCoins, 3)}</dd>
          <dd className="text-xs text-white/50">{usd(etiUsd)} · network {eti ? hash(eti.networkHashrate) : '—'}</dd>
        </div>
        <div>
          <dt className="text-white/60">EGAZ / day (GPU)</dt>
          <dd className="font-mono text-lg">{egazCoins === null ? (failed ? '—' : '…') : fmt(egazCoins, 2)}</dd>
          <dd className="text-xs text-white/50">{usd(egazUsd)} · network {egaz ? hash(egaz.networkHashrate) : '—'}</dd>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-white/60">Both, per day</dt>
          <dd className="font-mono text-lg">{usd(total)}</dd>
          <dd className="text-xs text-white/50">
            ETI {eti?.priceUsd != null ? usd(eti.priceUsd) : '—'} · EGAZ {egaz?.priceUsd != null ? usd(egaz.priceUsd) : '—'}
          </dd>
        </div>
      </dl>
    </section>
  );
}
