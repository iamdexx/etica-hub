/**
 * Launch flow for a new research-token market. Walks the researcher through:
 *   1. Connect wallet + switch to Etica mainnet (61803)
 *   2. Upload token image to IPFS (via /api/research-markets/upload-image)
 *      OR paste an existing IPFS / HTTPS URI
 *   3. Fill out token metadata (name, symbol, description, socials,
 *      evidence reference) — evidence is required to anchor the scientific
 *      claim to a DOI / PDB / arXiv / EticaLabs run id / ORCID
 *   4. Approve ETX for the launch toll (100 ETX by default)
 *   5. Call EticaResearchMarkets.launch(metadata) — singleton deploys
 *      the ResearchToken, transfers the toll, initializes the bonding curve
 *
 * Auto-Sourcify verification of the deployed token is wired in a follow-up
 * PR; the ABI is intentionally deterministic so a single canonical metadata
 * bundle covers every launch.
 */
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseError,
  decodeEventLog,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import {
  useAccount,
  useChainId,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import Link from 'next/link';
import { eticaMainnet } from '@etica-hub/shared/chains';
import { DEPLOYMENTS, abis, isSupportedChainId } from '@etica-hub/shared';
import { useResearchMarketsAddress, useResearchMarketsConfig, resolveImageURI } from '@/lib/research-markets';

type Step =
  | 'idle'
  | 'uploading'
  | 'approving'
  | 'approved'
  | 'launching'
  | 'launched';

const MAX_UINT256 = (1n << 256n) - 1n;

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function LaunchForm() {
  const { address: connected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const singleton = useResearchMarketsAddress();
  const config = useResearchMarketsConfig();

  const etx = useMemo<Address | null>(() => {
    if (!isSupportedChainId(chainId)) return null;
    const a = DEPLOYMENTS[chainId].etx;
    return a === '0x0000000000000000000000000000000000000000' ? null : a;
  }, [chainId]);

  // ─── Metadata form ───
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [imageURI, setImageURI] = useState('');
  const [evidenceURI, setEvidenceURI] = useState('');
  const [website, setWebsite] = useState('');
  const [telegram, setTelegram] = useState('');
  const [xUrl, setXUrl] = useState('');

  // ─── Image upload ───
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // ─── Flow state ───
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [deployedToken, setDeployedToken] = useState<Address | null>(null);

  // Allowance reads + writes
  const { data: allowance } = useReadContract({
    address: etx ?? undefined,
    abi: abis.erc20Abi,
    functionName: 'allowance',
    args: connected && singleton ? [connected, singleton] : undefined,
    query: { enabled: !!connected && !!singleton && !!etx, refetchInterval: 10_000 },
  });

  const launchToll = config?.launchTollEtx ?? 0n;
  const needsApproval = (allowance as bigint | undefined) !== undefined
    ? (allowance as bigint) < launchToll
    : true;

  const {
    writeContractAsync: writeApprove,
    data: approveTxHash,
    reset: resetApprove,
  } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveConfirmed } =
    useWaitForTransactionReceipt({ hash: approveTxHash });

  const {
    writeContractAsync: writeLaunch,
    data: launchTxHash,
    reset: resetLaunch,
  } = useWriteContract();
  const { isLoading: launchConfirming, data: launchReceipt } =
    useWaitForTransactionReceipt({ hash: launchTxHash });

  useEffect(() => {
    if (approveConfirmed && step === 'approving') setStep('approved');
  }, [approveConfirmed, step]);

  // Parse Launched(token, researcher, ...) event to surface the deployed
  // ResearchToken address.
  useEffect(() => {
    if (!launchReceipt || step !== 'launching') return;
    for (const log of launchReceipt.logs) {
      try {
        const parsed = decodeEventLog({
          abi: abis.eticaResearchMarketsAbi,
          data: log.data,
          topics: log.topics,
        });
        if (parsed.eventName === 'Launched') {
          const args = parsed.args as unknown as { token: Address };
          setDeployedToken(args.token);
          break;
        }
      } catch {
        // skip unrelated logs
      }
    }
    setStep('launched');
  }, [launchReceipt, step]);

  // ─── Handlers ───
  async function handleEnsureChain() {
    if (chainId !== eticaMainnet.id) {
      await switchChainAsync({ chainId: eticaMainnet.id });
    }
  }

  async function handleImageUpload(file: File) {
    setUploadError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/research-markets/upload-image', {
        method: 'POST',
        body: fd,
      });
      const json = (await res.json()) as { uri?: string; error?: string };
      if (!res.ok || !json.uri) {
        throw new Error(json.error || `Upload failed (${res.status})`);
      }
      setImageURI(json.uri);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      setUploadError(message);
    } finally {
      setUploading(false);
    }
  }

  async function handleApprove() {
    if (!etx || !singleton) return;
    setError(null);
    setStep('approving');
    try {
      await writeApprove({
        address: etx,
        abi: abis.erc20Abi,
        functionName: 'approve',
        args: [singleton, MAX_UINT256],
      });
    } catch (err) {
      const message = err instanceof BaseError ? err.shortMessage : String(err);
      setError(`Approval failed: ${message}`);
      setStep('idle');
    }
  }

  async function handleLaunch() {
    if (!singleton) return;
    setError(null);
    setStep('launching');
    try {
      await writeLaunch({
        address: singleton,
        abi: abis.eticaResearchMarketsAbi,
        functionName: 'launch',
        args: [
          {
            name: name.trim(),
            symbol: symbol.trim(),
            imageURI: imageURI.trim(),
            description: description.trim(),
            website: website.trim(),
            telegram: telegram.trim(),
            xUrl: xUrl.trim(),
            evidenceURI: evidenceURI.trim(),
          },
        ],
      });
    } catch (err) {
      const message = err instanceof BaseError ? err.shortMessage : String(err);
      setError(`Launch failed: ${message}`);
      setStep('idle');
    }
  }

  function handleReset() {
    setName('');
    setSymbol('');
    setDescription('');
    setImageURI('');
    setEvidenceURI('');
    setWebsite('');
    setTelegram('');
    setXUrl('');
    setError(null);
    setUploadError(null);
    setDeployedToken(null);
    setStep('idle');
    resetApprove();
    resetLaunch();
  }

  // ─── Validation ───
  const symbolValid = /^[A-Z0-9]{2,10}$/.test(symbol.trim());
  const nameValid = name.trim().length >= 2 && name.trim().length <= 64;
  const descValid = description.trim().length >= 10 && description.trim().length <= 1000;
  const imageValid = imageURI.startsWith('ipfs://') || imageURI.startsWith('https://') || imageURI.startsWith('http://');
  const evidenceValid = evidenceURI.trim().length >= 4;
  const formValid = nameValid && symbolValid && descValid && imageValid && evidenceValid;

  // ─── Success state ───
  if (step === 'launched' && deployedToken) {
    return (
      <div className="space-y-6 rounded-xl border border-emerald-700/40 bg-emerald-500/10 p-6">
        <div>
          <h3 className="text-lg font-semibold text-emerald-200">Token launched</h3>
          <p className="mt-1 text-sm text-emerald-100/80">
            The ResearchToken is live and the bonding curve is initialised. Buyers can now
            trade against the shared 5M ETX pool.
          </p>
        </div>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div className="rounded border border-emerald-700/30 bg-zinc-950/40 p-3">
            <dt className="text-xs text-emerald-300/80">Token address</dt>
            <dd className="mt-1 break-all font-mono text-xs text-emerald-100">{deployedToken}</dd>
          </div>
          <div className="rounded border border-emerald-700/30 bg-zinc-950/40 p-3">
            <dt className="text-xs text-emerald-300/80">Token symbol</dt>
            <dd className="mt-1 font-mono text-sm text-emerald-100">${symbol}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-3">
          <Link
            href={`/research-markets/${deployedToken}`}
            className="rounded-lg border border-emerald-600 bg-emerald-600/20 px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-600/30"
          >
            View on launchpad →
          </Link>
          <Link
            href="/research-markets"
            className="rounded-lg border border-zinc-700 bg-zinc-800/50 px-4 py-2 text-sm font-semibold text-zinc-200 transition hover:bg-zinc-800"
          >
            Back to markets
          </Link>
          <button
            type="button"
            onClick={handleReset}
            className="rounded-lg border border-zinc-700 bg-zinc-800/50 px-4 py-2 text-sm font-semibold text-zinc-200 transition hover:bg-zinc-800"
          >
            Launch another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Connection + chain gate */}
      {!connected ? (
        <div className="rounded-xl border border-amber-700/40 bg-amber-500/10 p-4 text-amber-200">
          Connect your wallet to launch a research token.
        </div>
      ) : !isSupportedChainId(chainId) || chainId !== eticaMainnet.id ? (
        <div className="flex items-center justify-between rounded-xl border border-amber-700/40 bg-amber-500/10 p-4 text-amber-200">
          <span className="text-sm">Switch to Etica mainnet (chain id 61803) to launch.</span>
          <button
            type="button"
            onClick={handleEnsureChain}
            disabled={switching}
            className="rounded-lg border border-amber-600 bg-amber-600/20 px-3 py-1.5 text-xs font-semibold text-amber-100 transition hover:bg-amber-600/30 disabled:opacity-50"
          >
            {switching ? 'Switching…' : 'Switch chain'}
          </button>
        </div>
      ) : !singleton ? (
        <div className="rounded-xl border border-red-700/40 bg-red-500/10 p-4 text-red-200">
          EticaResearchMarkets singleton is not deployed on this chain. Treasury can deploy it
          via <Link href="/deploy/research-markets" className="underline">/deploy/research-markets</Link>.
        </div>
      ) : null}

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h3 className="text-base font-semibold text-zinc-100">Token metadata</h3>
        <p className="mt-1 text-xs text-zinc-500">
          All fields stored on-chain as immutable strings on the deployed ResearchToken.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Token name"
            required
            value={name}
            onChange={setName}
            placeholder="Spike RBD binder #14"
            maxLength={64}
            error={name.length > 0 && !nameValid ? 'Must be 2-64 characters.' : null}
          />
          <Field
            label="Symbol"
            required
            value={symbol}
            onChange={(v) => setSymbol(v.toUpperCase())}
            placeholder="RBD14"
            maxLength={10}
            error={symbol.length > 0 && !symbolValid ? 'Uppercase letters/digits, 2-10 chars.' : null}
          />
        </div>

        <div className="mt-4">
          <Field
            label="Description"
            required
            value={description}
            onChange={setDescription}
            placeholder="Short alpha-helical peptide that binds spike RBD with predicted Kd ~50 nM. Folded via NVIDIA ESMFold, plDDT 87."
            maxLength={1000}
            textarea
            error={description.length > 0 && !descValid ? 'Must be 10-1000 characters.' : null}
          />
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-zinc-300">
              Token image <span className="text-red-400">*</span>
            </label>
            <p className="mt-1 text-[11px] text-zinc-500">
              Upload PNG/JPEG/WebP/GIF (≤2 MB) — gets pinned to IPFS. Or paste an existing
              ipfs:// or https:// URI below.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                disabled={uploading}
                className="text-xs text-zinc-400 file:mr-3 file:rounded file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-zinc-200 hover:file:bg-zinc-700"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImageUpload(file);
                }}
              />
              {uploading && <span className="text-xs text-zinc-400">Uploading…</span>}
              {imageURI && (
                <div className="flex items-center gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={resolveImageURI(imageURI)}
                    alt="preview"
                    className="h-10 w-10 rounded border border-zinc-700 object-cover"
                  />
                  <span className="break-all text-[10px] text-zinc-500">{imageURI}</span>
                </div>
              )}
            </div>
            {uploadError && (
              <p className="mt-2 text-[11px] text-red-400">{uploadError}</p>
            )}
          </div>
          <Field
            label="… or paste IPFS/HTTPS URI"
            value={imageURI}
            onChange={setImageURI}
            placeholder="ipfs://bafy… or https://…"
            mono
            error={imageURI.length > 0 && !imageValid ? 'Must start with ipfs://, http://, or https://' : null}
          />
        </div>

        <div className="mt-4">
          <Field
            label="Evidence reference"
            required
            value={evidenceURI}
            onChange={setEvidenceURI}
            placeholder="10.1234/foo, arXiv:2401.00001, PDB:7QO7, EticaLabs:run-abc, or ORCID:0000-0000-0000-0000"
            mono
            error={evidenceURI.length > 0 && !evidenceValid ? 'Provide DOI / arXiv / PDB / LabsRun / ORCID identifier.' : null}
          />
        </div>

        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-medium text-zinc-400 hover:text-zinc-200">
            Optional socials
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Website" value={website} onChange={setWebsite} placeholder="https://…" />
            <Field label="Telegram" value={telegram} onChange={setTelegram} placeholder="https://t.me/…" />
            <Field label="X (Twitter)" value={xUrl} onChange={setXUrl} placeholder="https://x.com/…" />
          </div>
        </details>
      </div>

      {/* Toll + actions */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h3 className="text-base font-semibold text-zinc-100">Launch toll</h3>
        <div className="mt-3 flex items-baseline justify-between">
          <span className="text-sm text-zinc-400">Singleton charges</span>
          <span className="font-mono text-lg text-zinc-100">
            {formatUnits(launchToll, 18)} ETX
          </span>
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">
          Toll accrues to the shared pool — it strengthens every other market, not the treasury.
          Singleton: {singleton ? shortAddress(singleton) : '—'}
        </p>

        {error && (
          <p className="mt-3 break-all rounded border border-red-700/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          {needsApproval && step !== 'launching' && step !== 'launched' ? (
            <button
              type="button"
              disabled={
                !connected ||
                chainId !== eticaMainnet.id ||
                !singleton ||
                step === 'approving' ||
                approveConfirming
              }
              onClick={handleApprove}
              className="rounded-lg border border-sky-600 bg-sky-600/20 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-600/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {step === 'approving' || approveConfirming
                ? 'Approving…'
                : '1. Approve ETX toll'}
            </button>
          ) : null}
          <button
            type="button"
            disabled={
              !connected ||
              chainId !== eticaMainnet.id ||
              !singleton ||
              needsApproval ||
              !formValid ||
              step === 'launching' ||
              launchConfirming
            }
            onClick={handleLaunch}
            className="rounded-lg border border-emerald-600 bg-emerald-600/20 px-4 py-2 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-600/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {step === 'launching' || launchConfirming ? 'Launching…' : '2. Launch token'}
          </button>
          {(name || symbol || description || imageURI || evidenceURI) && (
            <button
              type="button"
              onClick={handleReset}
              className="text-xs text-zinc-400 underline hover:text-zinc-200"
            >
              Reset form
            </button>
          )}
        </div>

        {!formValid && (
          <p className="mt-3 text-[11px] text-zinc-500">
            Fill out name, symbol, description, image, and evidence reference to enable launch.
          </p>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
  maxLength,
  textarea,
  mono,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  textarea?: boolean;
  mono?: boolean;
  error?: string | null;
}) {
  const className = `mt-1.5 w-full rounded-md border bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 ${
    error ? 'border-red-700/60 focus:ring-red-700' : 'border-zinc-700 focus:ring-sky-600'
  } ${mono ? 'font-mono text-xs' : ''}`;
  return (
    <div>
      <label className="text-xs font-medium text-zinc-300">
        {label} {required && <span className="text-red-400">*</span>}
      </label>
      {textarea ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          rows={3}
          className={className}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          className={className}
        />
      )}
      {error && <p className="mt-1 text-[10px] text-red-400">{error}</p>}
    </div>
  );
}
