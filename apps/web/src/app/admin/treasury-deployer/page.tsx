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
import treasuryAutoBuyerArtifact from '@/lib/treasury-autobuyer-artifact.json';

const BURN_WALLET = '0x000000000000000000000000000000000000dEaD' as Address;
const TREASURY_KEEPER_ADDRESS = '0x195D37D2Aad52D63AcC4C6Ee22B9893f6CdACc2f' as Address;
const ADMIN_ADDRESS = (
  process.env.NEXT_PUBLIC_TREASURY_DEPLOYER_ADMIN_ADDRESS ?? TREASURY_ADDRESS
) as Address;

const prefill = {
  owner: ADMIN_ADDRESS,
  treasury: TREASURY_ADDRESS,
  keeper: TREASURY_KEEPER_ADDRESS,
  burnWallet: BURN_WALLET,
  router: DEPLOYMENTS[61803].swapRouter,
  etx: DEPLOYMENTS[61803].etx,
  eti: EXTERNAL_ADDRESSES[61803].eti,
  egaz: DEPLOYMENTS[61803].wegaz,
  stetx: DEPLOYMENTS[61803].stakedETX,
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
  const [form, setForm] = useState(prefill);
  const [deployedAddress, setDeployedAddress] = useState('');

  const isUnlocked = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('deployer') === '1' || window.location.hash === '#deployer';
  }, []);

  const artifactReady =
    typeof treasuryAutoBuyerArtifact.bytecode === 'string' &&
    treasuryAutoBuyerArtifact.bytecode.startsWith('0x') &&
    treasuryAutoBuyerArtifact.bytecode.length > 10;

  const autobuyerAddress = deployedAddress || '0x_DEPLOYED_TREASURY_AUTOBUYER_ADDRESS';
  const cronConfig = `Treasury AutoBuyer cron setup\n\nNetwork: Etica Mainnet\nChain ID: 61803\nAutoBuyer contract: ${autobuyerAddress}\nKeeper wallet: ${form.keeper}\nKeeper role: calls executeCycle() only\nKeeper reimbursement: native EGAZ only\nGas behavior: keeper reward is intentionally above expected gas so the keeper EGAZ balance should slowly increase over time\nDefault keeper reward: 0.05% of each cycle budget\nMax keeper reward cap: 0.5% of each cycle budget\n\nCron env values to set after deployment:\nAUTOBUYER_ADDRESS=${autobuyerAddress}\nAUTOBUYER_KEEPER_ADDRESS=${form.keeper}\nAUTOBUYER_RPC_URL=https://rpc2.etica-stats.org\nAUTOBUYER_DRY_RUN=false\n\nSecret value you add yourself, never in chat:\nAUTOBUYER_PRIVATE_KEY=<private key for ${form.keeper}>\n\nTreasury safety:\n- never use the treasury private key for cron\n- keeper receives only native EGAZ reimbursement\n- all ETX, ETI, WEGAZ, and stETX dust returns to treasury\n- LP is minted directly to the burn wallet`;

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

  async function copyCronConfig() {
    await navigator.clipboard.writeText(cronConfig);
    log('Copied keeper cron setup.');
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
              'https://rpc2.etica-stats.org',
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

      if (!artifactReady) {
        throw new Error(
          'TreasuryAutoBuyer artifact is not built yet. The artifact workflow must commit real bytecode before deployment.',
        );
      }

      const owner = assertAddress(form.owner, 'Owner/admin wallet');
      const treasury = assertAddress(form.treasury, 'Treasury wallet');
      const burnWallet = assertAddress(form.burnWallet, 'Burn wallet');
      const etx = assertAddress(form.etx, 'ETX token');
      const eti = assertAddress(form.eti, 'ETI token');
      const egaz = assertAddress(form.egaz, 'Wrapped EGAZ');
      const stetx = assertAddress(form.stetx, 'stETX token');
      const router = assertAddress(form.router, 'Router');
      assertAddress(form.keeper, 'Keeper wallet');

      log('Submitting deployment transaction...');

      const hash: Hash = await client.deployContract({
        abi: treasuryAutoBuyerArtifact.abi,
        bytecode: treasuryAutoBuyerArtifact.bytecode as `0x${string}`,
        args: [owner, treasury, burnWallet, etx, eti, egaz, stetx, router],
      });

      log(`Deploy transaction sent: ${hash}`);
      log('After confirmation, paste the deployed contract address into the AutoBuyer field below.');
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
              Deploys the cron-ready TreasuryAutoBuyer. The keeper wallet is prefilled and receives only native EGAZ gas reimbursement.
            </p>
          </div>
          <button
            onClick={connectOnly}
            className="rounded-xl bg-emerald-400 px-5 py-3 text-sm font-black text-slate-950 hover:bg-emerald-300"
          >
            Connect MetaMask
          </button>
        </div>

        {!artifactReady ? (
          <div className="mt-6 rounded-2xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-100">
            TreasuryAutoBuyer artifact is not built yet. The artifact workflow must replace the artifact shell with real bytecode before deployment.
          </div>
        ) : null}

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Field label="Connected wallet" value={connected || 'Not connected'} readOnly />
          <Field label="Owner/admin wallet" value={form.owner} onChange={(v) => setField('owner', v)} />
          <Field label="ETX treasury wallet" value={form.treasury} onChange={(v) => setField('treasury', v)} />
          <Field label="Keeper wallet" value={form.keeper} onChange={(v) => setField('keeper', v)} />
          <Field label="Burn wallet" value={form.burnWallet} onChange={(v) => setField('burnWallet', v)} />
          <Field label="Router" value={form.router} onChange={(v) => setField('router', v)} />
          <Field label="ETX token" value={form.etx} onChange={(v) => setField('etx', v)} />
          <Field label="ETI token" value={form.eti} onChange={(v) => setField('eti', v)} />
          <Field label="Wrapped EGAZ" value={form.egaz} onChange={(v) => setField('egaz', v)} />
          <Field label="stETX token / v3" value={form.stetx} onChange={(v) => setField('stetx', v)} />
          <Field label="Artifact" value={artifactReady ? 'Ready: ABI + bytecode loaded' : 'Missing bytecode'} readOnly />
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            onClick={deploy}
            disabled={!artifactReady}
            className="rounded-xl bg-blue-500 px-5 py-3 text-sm font-black text-white hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
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

        <section className="mt-8 rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.35em] text-emerald-200">Keeper cron</p>
              <h2 className="mt-2 text-2xl font-black">Automation setup</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-emerald-50/80">
                The keeper address is prefilled. The contract reimburses successful calls in native EGAZ, with the reward set to slowly increase the keeper gas balance over time.
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <Field label="Deployed AutoBuyer" value={deployedAddress} onChange={setDeployedAddress} />
            <Field label="Chain ID" value="61803" readOnly />
            <Field label="Keeper wallet" value={form.keeper} readOnly />
            <Field label="Keeper reward" value="Native EGAZ, slowly gas-positive" readOnly />
          </div>

          <pre className="mt-5 whitespace-pre-wrap rounded-2xl bg-black/70 p-4 text-xs leading-5 text-emerald-100">
            {cronConfig}
          </pre>
          <button
            onClick={copyCronConfig}
            className="mt-4 rounded-xl bg-white/10 px-5 py-3 text-sm font-black text-white hover:bg-white/15"
          >
            Copy keeper cron setup
          </button>
        </section>

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
