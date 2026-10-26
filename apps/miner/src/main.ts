import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';

type Hardware = {
  cpu_name: string;
  cpu_threads: number;
  ram_gb: number;
  gpus: string[];
  gpu_supported: boolean;
  os: string;
};
type Status = {
  cpu_running: boolean;
  gpu_running: boolean;
  cpu_hashrate: number;
  gpu_hashrate: number;
  cpu_shares: number;
  gpu_shares: number;
  log: string[];
};

const ETI_API = 'https://etipool.eticahub.com/api/v2/pool/miner/';
const EGAZ_API = 'https://pool.eticahub.com/api/accounts/';
const WALLET_KEY = 'eticahub-miner.wallet';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const wallet = $<HTMLInputElement>('wallet');
const cpuOn = $<HTMLInputElement>('cpuOn');
const gpuOn = $<HTMLInputElement>('gpuOn');
const intensity = $<HTMLSelectElement>('intensity');
const mineBtn = $<HTMLButtonElement>('mine');
const status = $('status');
const progress = $<HTMLProgressElement>('progress');
const stats = $('stats');
const logEl = $('log');

const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
let mining = false;
let poll: number | undefined;
let logLines: string[] = [];

function setStatus(text: string, err = false) {
  status.textContent = text;
  status.classList.toggle('err', err);
}

function appendLog(lines: string[]) {
  if (!lines.length) return;
  logLines = logLines.concat(lines).slice(-300);
  logEl.textContent = logLines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

function fmtHash(h: number, unit: 'H/s' | 'MH/s') {
  if (unit === 'MH/s') return `${h.toFixed(2)} MH/s`;
  if (h >= 1e6) return `${(h / 1e6).toFixed(2)} MH/s`;
  if (h >= 1e3) return `${(h / 1e3).toFixed(1)} kH/s`;
  return `${h.toFixed(0)} H/s`;
}

const fromWei = (v: unknown, decimals: number) => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : 0;
  return Number.isFinite(n) ? n / 10 ** decimals : 0;
};
const fmt = (n: number) => (n >= 100 ? n.toFixed(1) : n.toFixed(3));

function updateButton() {
  const ok = isAddress(wallet.value.trim()) && (cpuOn.checked || gpuOn.checked);
  mineBtn.disabled = !ok && !mining;
  wallet.classList.toggle('bad', wallet.value.length > 0 && !isAddress(wallet.value.trim()));
  if (!mining) setStatus(ok ? 'Ready. Press Mine.' : 'Enter a wallet to start.');
}

async function loadHardware() {
  try {
    const hw = await invoke<Hardware>('detect_hardware');
    $('cpuInfo').textContent = `${hw.cpu_name}, ${hw.cpu_threads} threads`;
    if (hw.gpu_supported) {
      $('gpuInfo').textContent = hw.gpus.join(', ');
    } else {
      $('gpuInfo').textContent =
        hw.os === 'macos' ? 'Mac GPUs are not supported for etchash' : hw.gpus.length ? `${hw.gpus.join(', ')} (not supported)` : 'no GPU found';
      gpuOn.checked = false;
      gpuOn.disabled = true;
    }
  } catch (e) {
    $('cpuInfo').textContent = String(e);
  }
  updateButton();
}

async function poolEarnings(w: string) {
  const addr = w.toLowerCase();
  let etiUnpaid = 0, etiPaid = 0, egazUnpaid = 0, egazPaid = 0;
  try {
    const r = await invoke<{ minerData?: Record<string, unknown> }>('fetch_json', { url: ETI_API + addr });
    const m = r.minerData ?? {};
    etiPaid = fromWei(m.tokensReceived, 18);
    etiUnpaid = Math.max(0, fromWei(m.alltimeTokenBalance, 18) - etiPaid);
  } catch { /* no shares yet */ }
  try {
    const r = await invoke<{ stats?: Record<string, unknown> }>('fetch_json', { url: EGAZ_API + addr });
    const s = r.stats ?? {};
    egazUnpaid = fromWei(s.balance, 9) + fromWei(s.immature, 9);
    egazPaid = fromWei(s.paid, 9);
  } catch { /* no shares yet */ }
  $('unpaid').textContent = `${fmt(etiUnpaid)} ETI / ${fmt(egazUnpaid)} EGAZ`;
  $('paid').textContent = `${fmt(etiPaid)} ETI / ${fmt(egazPaid)} EGAZ`;
}

let earningsTick = 0;
async function refresh() {
  try {
    const s = await invoke<Status>('miner_status');
    appendLog(s.log);
    $('cpuHr').textContent = fmtHash(s.cpu_hashrate, 'H/s');
    $('gpuHr').textContent = fmtHash(s.gpu_hashrate, 'MH/s');
    $('shares').textContent = String(s.cpu_shares + s.gpu_shares);
    const parts: string[] = [];
    if (cpuOn.checked) parts.push(s.cpu_running ? 'ETI mining' : 'ETI stopped');
    if (gpuOn.checked && !gpuOn.disabled) parts.push(s.gpu_running ? 'EGAZ mining' : 'EGAZ stopped');
    setStatus(parts.join(' / ') || 'Mining');
    if (earningsTick++ % 10 === 0) void poolEarnings(wallet.value.trim());
  } catch (e) {
    setStatus(String(e), true);
  }
}

async function start() {
  const w = wallet.value.trim();
  if (!isAddress(w)) return;
  localStorage.setItem(WALLET_KEY, w);
  mineBtn.disabled = true;
  setStatus('Getting the miner engines ready...');
  progress.hidden = false;
  progress.value = 0;
  try {
    await invoke('start_mining', {
      wallet: w,
      cpu: cpuOn.checked,
      gpu: gpuOn.checked && !gpuOn.disabled,
      cpuPercent: Number(intensity.value),
    });
    mining = true;
    mineBtn.textContent = 'Stop';
    mineBtn.classList.add('stop');
    stats.hidden = false;
    earningsTick = 0;
    poll = window.setInterval(refresh, 3000);
    void refresh();
  } catch (e) {
    setStatus(String(e), true);
  } finally {
    progress.hidden = true;
    mineBtn.disabled = false;
    for (const el of [wallet, cpuOn, gpuOn, intensity]) el.disabled = mining || (el === gpuOn && gpuOn.disabled);
  }
}

async function stop() {
  if (poll) window.clearInterval(poll);
  await invoke('stop_mining');
  mining = false;
  mineBtn.textContent = 'Mine';
  mineBtn.classList.remove('stop');
  for (const el of [wallet, cpuOn, intensity]) el.disabled = false;
  setStatus('Stopped.');
  updateButton();
}

mineBtn.addEventListener('click', () => (mining ? void stop() : void start()));
wallet.addEventListener('input', updateButton);
cpuOn.addEventListener('change', updateButton);
gpuOn.addEventListener('change', updateButton);
$('openMine').addEventListener('click', (e) => {
  e.preventDefault();
  void openUrl('https://eticahub.com/mine');
});

void listen<string>('log', (e) => appendLog([e.payload]));
void listen<number>('progress', (e) => { progress.value = e.payload; });

wallet.value = localStorage.getItem(WALLET_KEY) ?? '';
void loadHardware();
