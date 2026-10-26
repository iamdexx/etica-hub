'use client';

import { useEffect, useMemo, useState } from 'react';

import { CopyBlock } from '@/components/node/CopyBlock';

const STRATUM_HOST = 'pool.eticahub.com';
const STRATUM_PORT = 8008;
const API = 'https://pool.eticahub.com/api';
const ETI_HOST = 'etipool.eticahub.com';
const ETI_API = 'https://etipool.eticahub.com/api/v2/pool';
const PLACEHOLDER = '0xYOURWALLET';
const APP_VERSION = '0.1.3';
const APP_BASE = `https://github.com/iamdexx/etica-hub/releases/download/miner-v${APP_VERSION}/EticaHub.Miner_${APP_VERSION}_`;
type Platform = 'windows' | 'mac-arm' | 'mac-intel' | 'linux' | 'phone' | 'unknown';
const DOWNLOADS: Record<Exclude<Platform, 'phone' | 'unknown'>, { label: string; file: string; note: string }> = {
  windows: { label: 'Windows', file: 'x64-setup.exe', note: 'Run the installer. If Windows shows "protected your PC", click More info, then Run anyway.' },
  'mac-arm': { label: 'Mac (Apple Silicon, M1 or newer)', file: 'aarch64.dmg', note: 'Open the .dmg and drag the app to Applications. First launch: right-click the app, Open.' },
  'mac-intel': { label: 'Mac (Intel)', file: 'x64.dmg', note: 'Open the .dmg and drag the app to Applications. First launch: right-click the app, Open.' },
  linux: { label: 'Linux', file: 'amd64.AppImage', note: 'Make it executable (chmod +x) and run it.' },
};

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|Android/i.test(ua)) return 'phone';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return macIsIntel() ? 'mac-intel' : 'mac-arm';
  if (/Linux/i.test(ua)) return 'linux';
  return 'unknown';
}

// Browsers hide the CPU on Macs; the WebGL renderer string is the usual tell ("Apple M2" vs "Intel Iris").
function macIsIntel(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? String(gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    if (/Intel|AMD|Radeon/i.test(renderer)) return true;
    if (/Apple/i.test(renderer)) return false;
  } catch { /* fall through */ }
  return false;
}

type Coin = 'ETI' | 'EGAZ';

// eticapool ports are starting-difficulty tiers; pick by CPU size.
const ETI_PORTS = [
  { port: 3333, label: 'up to 4 threads' },
  { port: 5555, label: '5 to 12 threads' },
  { port: 7777, label: '13 to 32 threads' },
  { port: 9999, label: '32+ threads' },
];

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

const ETI_MINERS: { id: string; name: string; gpu: string; cmd: (w: string, port: number) => string; url: string }[] = [
  {
    id: 'xmrig', name: 'XMRig', gpu: 'any CPU',
    cmd: (w, port) => `xmrig -o ${ETI_HOST}:${port} -u ${w}.rig1 -p x -a rx/0 -k`,
    url: 'https://github.com/xmrig/xmrig/releases',
  },
  {
    id: 'srb-cpu', name: 'SRBMiner-Multi', gpu: 'any CPU',
    cmd: (w, port) => `SRBMiner-MULTI --algorithm randomx --pool ${ETI_HOST}:${port} --wallet ${w} --worker rig1`,
    url: 'https://github.com/doktor83/SRBMiner-Multi/releases',
  },
];

interface EtiOverview {
  poolStatus?: { blockNumber?: number; poolFeesMetrics?: { miningRewardFormatted?: string } };
  totalHashrate?: number;
  minersCount?: number;
  activeMiners?: number;
}

interface EtiMiner {
  minerData?: { avgHashrate?: number; shares?: number; workers?: number; alltimeTokenBalance?: string; tokensReceived?: string } | null;
}

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
const eti = (v?: string | number) => (v === undefined ? '—' : `${(Number(v) / 1e18).toFixed(4)} ETI`);

export function MineWithUs() {
  const [wallet, setWallet] = useState('');
  const [coin, setCoin] = useState<Coin>('ETI');
  const [minerId, setMinerId] = useState(MINERS[0].id);
  const [etiMinerId, setEtiMinerId] = useState(ETI_MINERS[0].id);
  const [etiPort, setEtiPort] = useState(ETI_PORTS[0].port);
  const [etiPool, setEtiPool] = useState<EtiOverview | null>(null);
  const [etiAccount, setEtiAccount] = useState<EtiMiner | null | 'none'>(null);
  const [platform, setPlatform] = useState<Platform>('unknown');
  useEffect(() => { setPlatform(detectPlatform()); }, []);
  const primary = platform === 'phone' || platform === 'unknown' ? null : DOWNLOADS[platform];
  const [pool, setPool] = useState<PoolStats | null>(null);
  const [poolErr, setPoolErr] = useState(false);
  const [account, setAccount] = useState<AccountStats | null | 'none'>(null);

  const miner = useMemo(() => MINERS.find((m) => m.id === minerId) ?? MINERS[0], [minerId]);
  const etiMiner = useMemo(() => ETI_MINERS.find((m) => m.id === etiMinerId) ?? ETI_MINERS[0], [etiMinerId]);
  const w = wallet.trim();
  const valid = isAddress(w);
  const command = coin === 'EGAZ' ? miner.cmd(valid ? w : PLACEHOLDER) : etiMiner.cmd(valid ? w : PLACEHOLDER, etiPort);
  const minerName = coin === 'EGAZ' ? miner.name : etiMiner.name;
  const minerUrl = coin === 'EGAZ' ? miner.url : etiMiner.url;

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API}/stats`).then((r) => r.json()).then((j) => { if (alive) { setPool(j); setPoolErr(false); } }).catch(() => { if (alive) setPoolErr(true); });
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${ETI_API}/overview`).then((r) => r.json()).then((j) => { if (alive) setEtiPool(j); }).catch(() => { /* keep last */ });
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    if (!valid) { setEtiAccount(null); return; }
    let alive = true;
    fetch(`${ETI_API}/miner/${w.toLowerCase()}`)
      .then((r) => (r.ok ? r.json() : 'none'))
      .then((j) => { if (alive) setEtiAccount(j && (j as EtiMiner).minerData ? (j as EtiMiner) : 'none'); })
      .catch(() => { if (alive) setEtiAccount('none'); });
    return () => { alive = false; };
  }, [w, valid]);

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
      <section className="surface space-y-4 p-5 md:p-6" aria-labelledby="mine-app">
        <h2 id="mine-app" className="text-xl font-semibold">Easiest: the EticaHub Miner app</h2>
        <p className="text-sm text-white/65">
          One download for Windows, Mac and Linux. Open it, paste your wallet, press Mine. It mines ETI on your CPU and EGAZ on your GPU at the same time, and shows your hashrate and earnings. Nothing to configure.
        </p>
        {primary ? (
          <div className="space-y-2">
            <a href={APP_BASE + primary.file} className="btn-tone inline-block px-5 py-3 text-base font-semibold">Download for {primary.label}</a>
            <p className="text-xs text-white/55">{primary.note}</p>
            {platform === 'mac-arm' || platform === 'mac-intel' ? (
              <p className="text-xs text-white/55">
                Not sure which Mac? Apple menu, About This Mac: Apple M1 to M4 means Apple Silicon, otherwise Intel.{' '}
                <a className="underline" href={APP_BASE + DOWNLOADS[platform === 'mac-arm' ? 'mac-intel' : 'mac-arm'].file}>
                  Get the {platform === 'mac-arm' ? 'Intel' : 'Apple Silicon'} version instead
                </a>
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-amber-200/90">
            {platform === 'phone' ? 'Mining needs a computer. Open eticahub.com/mine on your PC or Mac and the download button appears there.' : 'Pick your system below.'}
          </p>
        )}
        <details className="text-xs text-white/55">
          <summary className="cursor-pointer">{primary ? 'Not your system? Other downloads' : 'All downloads'}</summary>
          <ul className="mt-2 space-y-1">
            {(Object.keys(DOWNLOADS) as (keyof typeof DOWNLOADS)[]).map((k) => (
              <li key={k}><a className="underline" href={APP_BASE + DOWNLOADS[k].file}>{DOWNLOADS[k].label}</a></li>
            ))}
            <li><a className="underline" href={APP_BASE + 'amd64.deb'}>Linux (.deb)</a></li>
          </ul>
        </details>
        <p className="text-xs text-white/45">Free, open source (apps/miner in the EticaHub repo), v{APP_VERSION}. Unsigned build, so your system asks once before the first run.</p>
      </section>

      <section className="surface space-y-4 p-5 md:p-6" aria-labelledby="mine-pool">
        <h2 id="mine-pool" className="text-xl font-semibold">Pools, live</h2>
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div><dt className="text-white/60">ETI miners</dt><dd className="font-mono">{etiPool ? etiPool.activeMiners ?? etiPool.minersCount ?? 0 : '—'}</dd></div>
          <div><dt className="text-white/60">ETI pool hashrate</dt><dd className="font-mono">{etiPool?.totalHashrate !== undefined ? fmtHash(etiPool.totalHashrate) : '—'}</dd></div>
          <div><dt className="text-white/60">ETI per solve</dt><dd className="font-mono">{etiPool?.poolStatus?.poolFeesMetrics?.miningRewardFormatted ? `${Number(etiPool.poolStatus.poolFeesMetrics.miningRewardFormatted).toFixed(2)} ETI` : '—'}</dd></div>
          <div><dt className="text-white/60">ETI stratum</dt><dd className="font-mono">{ETI_HOST}:3333</dd></div>
        </div>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 text-sm">
          <div><dt className="text-white/60">Pool hashrate</dt><dd className="font-mono text-lg">{poolErr ? '—' : fmtHash(pool?.hashrate)}</dd></div>
          <div><dt className="text-white/60">Miners</dt><dd className="font-mono text-lg">{pool?.minersTotal ?? '—'}</dd></div>
          <div><dt className="text-white/60">Blocks found</dt><dd className="font-mono text-lg">{pool?.maturedTotal ?? '—'}</dd></div>
          <div><dt className="text-white/60">Height</dt><dd className="font-mono text-lg">{height ? Number(height).toLocaleString('en-US') : '—'}</dd></div>
        </dl>
        <p className="text-sm text-white/65">Two pools, both 0.5% fee. ETI is mined with CPUs (RandomX) and paid per solve through the pool contract. EGAZ is the coin Etica blocks pay (2 EGAZ per block), mined with GPUs (etchash), PPLNS, payouts every 20 minutes once you reach 0.5 EGAZ. EGAZ stratum: {STRATUM_HOST}:{STRATUM_PORT}</p>
      </section>

      <section className="surface space-y-4 p-5 md:p-6" aria-labelledby="mine-start">
        <h2 id="mine-start" className="text-xl font-semibold">Or run a miner yourself</h2>
        <div className="flex gap-2" role="tablist" aria-label="Coin">
          {(['ETI', 'EGAZ'] as Coin[]).map((c) => (
            <button key={c} type="button" role="tab" aria-selected={coin === c} onClick={() => setCoin(c)} className={`${coin === c ? 'btn-tone' : 'btn-ghost'} px-4 py-1.5 text-sm`}>
              {c} <span className="text-white/50">· {c === 'ETI' ? 'CPU' : 'GPU'}</span>
            </button>
          ))}
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-white/75">1. Your Etica wallet (where {coin} is paid)</span>
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
            {(coin === 'EGAZ' ? MINERS : ETI_MINERS).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => (coin === 'EGAZ' ? setMinerId(m.id) : setEtiMinerId(m.id))}
                className={`${m.id === (coin === 'EGAZ' ? minerId : etiMinerId) ? 'btn-tone' : 'btn-ghost'} px-3 py-1.5 text-xs`}
              >
                {m.name} <span className="text-white/50">· {m.gpu}</span>
              </button>
            ))}
          </div>
          {coin === 'ETI' ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {ETI_PORTS.map((p) => (
                <button key={p.port} type="button" onClick={() => setEtiPort(p.port)} className={`${p.port === etiPort ? 'btn-tone' : 'btn-ghost'} px-3 py-1.5 text-xs`}>
                  port {p.port} <span className="text-white/50">· {p.label}</span>
                </button>
              ))}
            </div>
          ) : null}
          <p className="text-xs text-white/55">
            No miner yet? <a className="underline" href={minerUrl} rel="noreferrer" target="_blank">Download {minerName}</a>, unzip it, open a terminal in that folder.
          </p>
        </div>
        <div className="space-y-1 text-sm">
          <span className="text-white/75">3. Paste this and press Enter</span>
          <CopyBlock label={`${minerName} command`} value={command} />
          {!valid ? <p className="text-xs text-white/55">Enter your wallet above and the command fills itself in.</p> : null}
        </div>
      </section>

      {valid ? (
        <section className="surface space-y-3 p-5 md:p-6" aria-labelledby="mine-me">
          <h2 id="mine-me" className="text-xl font-semibold">Your stats</h2>
          <h3 className="text-sm font-semibold text-white/80">ETI</h3>
          {etiAccount === null ? (
            <p className="text-sm text-white/65">Loading…</p>
          ) : etiAccount === 'none' ? (
            <p className="text-sm text-white/65">No ETI shares from this wallet yet.</p>
          ) : (
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 text-sm">
              <div><dt className="text-white/60">Hashrate</dt><dd className="font-mono">{fmtHash(etiAccount.minerData?.avgHashrate)}</dd></div>
              <div><dt className="text-white/60">Workers</dt><dd className="font-mono">{etiAccount.minerData?.workers ?? 0}</dd></div>
              <div><dt className="text-white/60">Unpaid</dt><dd className="font-mono">{eti(Math.max(0, Number(etiAccount.minerData?.alltimeTokenBalance ?? 0) - Number(etiAccount.minerData?.tokensReceived ?? 0)))}</dd></div>
              <div><dt className="text-white/60">Paid</dt><dd className="font-mono">{eti(etiAccount.minerData?.tokensReceived ?? 0)}</dd></div>
            </dl>
          )}
          <h3 className="pt-2 text-sm font-semibold text-white/80">EGAZ</h3>
          {account === null ? (
            <p className="text-sm text-white/65">Loading…</p>
          ) : account === 'none' ? (
            <p className="text-sm text-white/65">No EGAZ shares from this wallet yet. Stats appear a few minutes after your miner connects.</p>
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
