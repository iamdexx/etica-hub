'use client';

import { useMemo, useState } from 'react';
import {
  createWalletClient,
  custom,
  isAddress,
  type Address,
  type Hash,
} from 'viem';
import {
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  TREASURY_ADDRESS,
  eticaMainnet,
} from '@etica-hub/shared';

const BURN_WALLET = '0x000000000000000000000000000000000000dEaD' as Address;
const ADMIN_ADDRESS = (
  process.env.NEXT_PUBLIC_TREASURY_DEPLOYER_ADMIN_ADDRESS ?? TREASURY_ADDRESS
) as Address;

const DEFAULT_ABI = `[
  {
    "inputs": [
      {"internalType":"address","name":"treasury_","type":"address"},
      {"internalType":"address","name":"burnWallet_","type":"address"},
      {"internalType":"address","name":"router_","type":"address"},
      {"internalType":"address","name":"stetxVault_","type":"address"},
      {"internalType":"address","name":"eti_","type":"address"},
      {"internalType":"address","name":"egaz_","type":"address"},
      {"internalType":"address","name":"stetx_","type":"address"},
      {"internalType":"uint256","name":"intervalSeconds_","type":"uint256"},
      {"internalType":"uint256","name":"maxSlippageBps_","type":"uint256"}
    ],
    "stateMutability":"nonpayable",
    "type":"constructor"
  }
]`;

const prefill = {
  treasury: TREASURY_ADDRESS,
  burnWallet: BURN_WALLET,
  router: DEPLOYMENTS[61803].swapRouter,
  stetxVault: DEPLOYMENTS[61803].stakedETX,
  etx: DEPLOYMENTS[61803].etx,
  eti: EXTERNAL_ADDRESSES[61803].eti,
  egaz: DEPLOYMENTS[61803].wegaz,
  stetx: DEPLOYMENTS[61803].stakedETX,
  intervalSeconds: '2700',
  slippageBps: '300',
};

function HiddenLanding() {
  return (
    <main className="min-h-screen bg-[#070b16] px-6 py-20 text-white">
      <section className="mx-auto max-w-3xl rounded-3xl border border-white/10 bg-white/[0.06] p-10 text-center shadow-2xl">
        <p className="text-sm uppercase tracking-[0.45em] text-emerald-300/80">EticaHub</p>
        <h1 className="mt-4 text-5xl font-black tracking-tight md:text-7xl">Maintenance</h1>
        <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-white/65">
          Nothing public is exposed at this endpoint.
        </p>
      </section>
    </main>
  );
}

export default function TreasuryDeployerPage() {
  const [connected, setConnected] = useState('');
  const [status, setStatus] = useState('Ready.');
  const [abiText, setAbiText] = useState(DEFAULT_ABI);
  const [bytecode, setBytecode] = useState('');
  const [form, setForm] = useState(prefill);

  const isUnlocked = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('deployer') === '1' || window.location.hash === '#deployer';
  }, []);

  function log(message: string) {
    setStatus((current) => `${current}\n${message}`);
  }

  function setField(key: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function assertAddress(value: string, label: string): Address {
    if (!isAddress(value)) throw new Error(`${label} is not a valid address.`);
    return value as Address;
  }

  async function getWalletClient() {
    if (typeof window === 'undefined' || !(window as any).ethereum) {
      throw new Error('MetaMask or another injected wallet is required.');
    }

    const [account] = (await (window as any).ethereum.request({
      method: 'eth_requestAccounts',
    })) as Address[];

    setConnected(account);

    if (account.toLowerCase() !== ADMIN_ADDRESS.toLowerCase()) {
      throw new Error(`Connected wallet is not the deployer admin (${ADMIN_ADDRESS}).`);
    }

    try {
      await (window as any).ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0xf16b' }],
      });
    } catch (error: any) {
      if (error?.code !== 4902) throw error;
      await (window as any).ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: '0xf16b',
            chainName: 'Etica Mainnet',
            nativeCurrency: { name: 'EGAZ', symbol: 'EGAZ', decimals: 18 },
            rpcUrls: [
              'https://eticamainnet.eticascan.org',
              'https://eticamainnet.eticaprotocol.org',
            ],
            blockExplorerUrls: ['https://eticascan.org'],
          },
        ],
      });
    }

    return createWalletClient({
      account,
      chain: eticaMainnet,
      transport: custom((window as any).ethereum),
    });
  }

  async function connectOnly() {
    try {
      setStatus('Ready.');
      await getWalletClient();
      log('Admin wallet connected on Etica mainnet.');
    } catch (error: any) {
      log(`ERROR: ${error?.message ?? String(error)}`);
    }
  }

  async function deploy() {
    try {
      setStatus('Starting deploy checks...');
      const client = await getWalletClient();

      const treasury = assertAddress(form.treasury, 'Treasury wallet');
      const burnWallet = assertAddress(form.burnWallet, 'Burn wallet');
      const router = assertAddress(form.router, 'Router');
      const stetxVault = assertAddress(form.stetxVault, 'stETX vault');
      const eti = assertAddress(form.eti, 'ETI token');
      const egaz = assertAddress(form.egaz, 'Wrapped EGAZ');
      const stetx = assertAddress(form.stetx, 'stETX token');

      const interval = BigInt(form.intervalSeconds);
      const slippageBps = BigInt(form.slippageBps);
      if (interval !== 2700n) throw new Error('Interval must be 2700 seconds.');
      if (slippageBps > 1000n) throw new Error('Slippage over 10% is blocked.');
      if (!bytecode.startsWith('0x') || bytecode.length < 10) {
        throw new Error('Paste the compiled contract bytecode first.');
      }

      const abi = JSON.parse(abiText);
      log('Submitting deployment transaction...');

      const hash: Hash = await client.deployContract({
        abi,
        bytecode: bytecode as `0x${string}`,
        args: [treasury, burnWallet, router, stetxVault, eti, egaz, stetx, interval, slippageBps],
      });

      log(`Deploy transaction sent: ${hash}`);
      log('Open the transaction in your Etica explorer and wait for confirmation.');
    } catch (error: any) {
      log(`ERROR: ${error?.message ?? String(error)}`);
    }
  }

  if (!isUnlocked) return <HiddenLanding />;

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100 md:px-8">
      <section className="mx-auto max-w-5xl rounded-3xl border border-white/10 bg-slate-900/80 p-6 shadow-2xl md:p-8">
        <div className="flex flex-col gap-3 border-b border-white/10 pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.4em] text-emerald-300">Hidden admin deployer</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight md:text-5xl">
              Treasury AutoBuyer Deploy
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
              Prefilled from EticaHub status constants. Only the configured admin wallet can deploy from this UI.
            </p>
          </div>
          <button
            onClick={connectOnly}
            className="rounded-xl bg-emerald-400 px-5 py-3 text-sm font-black text-slate-950 hover:bg-emerald-300"
          >
            Connect MetaMask
          </button>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Field label="Connected wallet" value={connected || 'Not connected'} readOnly />
          <Field label="Admin wallet" value={ADMIN_ADDRESS} readOnly />
          <Field label="ETX treasury wallet" value={form.treasury} onChange={(v) => setField('treasury', v)} />
          <Field label="Burn wallet" value={form.burnWallet} onChange={(v) => setField('burnWallet', v)} />
          <Field label="Router" value={form.router} onChange={(v) => setField('router', v)} />
          <Field label="stETX vault / v3" value={form.stetxVault} onChange={(v) => setField('stetxVault', v)} />
          <Field label="ETX token" value={form.etx} onChange={(v) => setField('etx', v)} />
          <Field label="ETI token" value={form.eti} onChange={(v) => setField('eti', v)} />
          <Field label="Wrapped EGAZ" value={form.egaz} onChange={(v) => setField('egaz', v)} />
          <Field label="stETX token" value={form.stetx} onChange={(v) => setField('stetx', v)} />
          <Field label="Cycle interval seconds" value={form.intervalSeconds} onChange={(v) => setField('intervalSeconds', v)} />
          <Field label="Max slippage bps" value={form.slippageBps} onChange={(v) => setField('slippageBps', v)} />
        </div>

        <label className="mt-6 block text-sm font-bold text-slate-200">Contract ABI JSON</label>
        <textarea
          value={abiText}
          onChange={(event) => setAbiText(event.target.value)}
          className="mt-2 h-44 w-full rounded-2xl border border-white/10 bg-slate-950 p-4 font-mono text-xs text-slate-100 outline-none focus:border-emerald-300"
        />

        <label className="mt-6 block text-sm font-bold text-slate-200">Compiled contract bytecode</label>
        <textarea
          value={bytecode}
          onChange={(event) => setBytecode(event.target.value)}
          placeholder="0x..."
          className="mt-2 h-32 w-full rounded-2xl border border-white/10 bg-slate-950 p-4 font-mono text-xs text-slate-100 outline-none focus:border-emerald-300"
        />

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            onClick={deploy}
            className="rounded-xl bg-blue-500 px-5 py-3 text-sm font-black text-white hover:bg-blue-400"
          >
            Deploy contract
          </button>
          <button
            onClick={() => setStatus('Ready.')}
            className="rounded-xl bg-white/10 px-5 py-3 text-sm font-black text-white hover:bg-white/15"
          >
            Clear status
          </button>
        </div>

        <pre className="mt-6 min-h-28 whitespace-pre-wrap rounded-2xl bg-black p-4 text-xs leading-5 text-emerald-200">
          {status}
        </pre>
      </section>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-sm font-bold text-slate-200">{label}</span>
      <input
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
        className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-3 font-mono text-xs text-slate-100 outline-none focus:border-emerald-300 disabled:opacity-60"
      />
    </label>
  );
}
