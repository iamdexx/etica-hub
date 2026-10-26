'use client';

import { useEffect, useMemo, useState } from 'react';

import { CopyBlock } from '@/components/node/CopyBlock';

const STRATUM_HOST = 'pool.eticahub.com';
const STRATUM_PORT = 8008;
const API = 'https://pool.eticahub.com/api';
const PLACEHOLDER = '0xYOURWALLET';

const MINERS: { id: string; name: string; gpu: string; cmd: (w: string) => string; url: string }[] = [
  {
    id: 'lolminer', name: 'lolMiner', gpu: 'NVIDIA + AMD', url: 'https://github.com/Lolliedieb/lolMiner-releases/releases',
    cmd: (w) => `lolMiner --algo ETCHASH --pool ${STRATUM_HOST}:${STRATUM_PORT} --user ${w}.rig1`,
  },
  {
    id: 'trex', name: 'T-Rex', gpu: 'NVIDIA', url: 'https://github.com/trexminer/T-Rex/releases',
    cmd: (w) => `t-rex -a etchash -o stratum+tcp://${STRATUM_HOST}:${STRATUM_PORT} -u ${w} -p x -w rig1`,
  },
  {
    id: 'gminer', name: 'GMiner', gpu: 'NVIDIA + AMD', url: 'https://github.com/develsoftware/GMinerRelease/releases',
    cmd: (w) => `miner --algo etchash --server ${STRATUM_HOST}:${STRATUM_PORT} --user ${w}.rig1`,
  },
  {
    id: 'rigel', name: 'Rigel', gpu: 'NVIDIA', url: 'https://github.com/rigelminer/rigel/releases',
    cmd: (w) => `rigel -a etchash -o stratum+tcp://${STRATUM_HOST}:${STRATUM_PORT} -u ${w} -w rig1`,
  },
  {
    id: 'srb', name: 'SRBMiner-Multi', gpu: 'AMD + NVIDIA + CPU', url: 'https://github.com/doktor83/SRBMiner-Multi/releases',
    cmd: (w) => `SRBMiner-MULTI --algorithm etchash --pool ${STRATUM_HOST}:${STRATUM_PORT} --wallet ${w} --worker rig1`,
  },
];

interface PoolStats {
  hashrate?: number;
  minersTotal?: number;
  workersTotal?: number;
  maturedTotal?: number;
  nodes?: { height?: string; difficulty?: string }[];
}

interface AccountStats {
  stats?: { balance?: number; paid?: number; immature?: number; blocksFound?: number; lastShare?: number };
  currentHashrate?: number;
  hashrate?: number;
  workersTotal?: number;
  paymentsTotal?: number;
}

const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
const fmtHash = (h?: number) => {
  if (!h) return '0 H/s';
  const u = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s'];
  let i = 0;
  while (h >= 1000 && i < u.length - 1) { h /= 1000; i++; }
  return `${h.toFixed(i ? 2 : 0)} ${u[i]}`;
};
const shannon = (v?: number) => (v === undefined ? '—' : `${(v / 1e9).toFixed(4)} EGAZ`);

export function MineWithUs() {
  const [wallet, setWallet] = useState('');
  const [minerId, setMinerId] = useState(MINERS[0].id);
  const [pool, setPool] = useState<PoolStats | null>(null);
  const [poolErr, setPoolErr] = useState(false);
  const [account, setAccount] = useState<AccountStats | null | 'none'>(null);

  const miner = useMemo(() => MINERS.find((m) => m.id === minerId) ?? MINERS[0], [minerId]);
  const w = wallet.trim();
  const valid = isAddress(w);
  const command = miner.cmd(valid ? w : PLACEHOLDER);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API}/stats`).then((r) => r.json()).then((j) => { if (alive) { setPool(j); setPoolErr(false); } }).catch(() => { if (alive) setPoolErr(true); });
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    if (!valid) { setAccount(null); return; }
    let alive = true;
    fetch(`${API}/accounts/${w.toLowerCase()}`)
      .then((r) => (r.ok ? r.json() : 'none'))
      .then((j) => { if (alive) setAccount(j as AccountStats | 'none'); })
      .catch(() => { if (alive) setAccount('none'); });
    return () => { alive = false; };
  }, [w, valid]);

  const height = pool?.nodes?.[0]?.height;

  return (
    <div className="space-y-8">
      <section className="surface space-y-4 p-5 md:p-6" aria-labelledby="mine-pool">
        <h2 id="mine-pool" className="text-xl font-semibold">Pool, live</h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 text-sm">
          <div><dt className="text-white/60">Pool hashrate</dt><dd className="font-mono text-lg">{poolErr ? '—' : fmtHash(pool?.hashrate)}</dd></div>
          <div><dt className="text-white/60">Miners</dt><dd className="font-mono text-lg">{pool?.minersTotal ?? '—'}</dd></div>
          <div><dt className="text-white/60">Blocks found</dt><dd className="font-mono text-lg">{pool?.maturedTotal ?? '—'}</dd></div>
          <div><dt className="text-white/60">Height</dt><dd className="font-mono text-lg">{height ? Number(height).toLocaleString('en-US') : '—'}</dd></div>
        </dl>
        <p className="text-sm text-white/65">Fee 0.5%, PPLNS, payouts every 20 minutes once you reach 0.5 EGAZ. Stratum: {STRATUM_HOST}:{STRATUM_PORT}</p>
      </section>

      <section className="surface space-y-4 p-5 md:p-6" aria-labelledby="mine-start">
        <h2 id="mine-start" className="text-xl font-semibold">Start mining in 3 steps</h2>
        <label className="block space-y-1 text-sm">
          <span className="text-white/75">1. Your Etica wallet (where EGAZ is paid)</span>
          <input
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder="0x..."
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-400/60"
          />
          {w && !valid ? <span className="text-xs text-amber-300">That is not a 0x address (40 hex characters).</span> : null}
        </label>
        <div className="space-y-1 text-sm">
          <span className="text-white/75">2. Your miner software</span>
          <div className="flex flex-wrap gap-2">
            {MINERS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMinerId(m.id)}
                className={`${m.id === minerId ? 'btn-tone' : 'btn-ghost'} px-3 py-1.5 text-xs`}
              >
                {m.name} <span className="text-white/50">· {m.gpu}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-white/55">
            No miner yet? <a className="underline" href={miner.url} rel="noreferrer" target="_blank">Download {miner.name}</a>, unzip it, open a terminal in that folder.
          </p>
        </div>
        <div className="space-y-1 text-sm">
          <span className="text-white/75">3. Paste this and press Enter</span>
          <CopyBlock label={`${miner.name} command`} value={command} />
          {!valid ? <p className="text-xs text-white/55">Enter your wallet above and the command fills itself in.</p> : null}
        </div>
      </section>

      {valid ? (
        <section className="surface space-y-3 p-5 md:p-6" aria-labelledby="mine-me">
          <h2 id="mine-me" className="text-xl font-semibold">Your stats</h2>
          {account === null ? (
            <p className="text-sm text-white/65">Loading…</p>
          ) : account === 'none' ? (
            <p className="text-sm text-white/65">No shares from this wallet yet. Stats appear a few minutes after your miner connects.</p>
          ) : (
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 text-sm">
              <div><dt className="text-white/60">Hashrate (30m)</dt><dd className="font-mono">{fmtHash(account.currentHashrate)}</dd></div>
              <div><dt className="text-white/60">Workers</dt><dd className="font-mono">{account.workersTotal ?? 0}</dd></div>
              <div><dt className="text-white/60">Unpaid</dt><dd className="font-mono">{shannon(account.stats?.balance)}</dd></div>
              <div><dt className="text-white/60">Paid</dt><dd className="font-mono">{shannon(account.stats?.paid)}</dd></div>
            </dl>
          )}
        </section>
      ) : null}
    </div>
  );
}
