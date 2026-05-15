'use client';

import { useMemo, useState } from 'react';

type SubmitState = 'idle' | 'submitting' | 'polling' | 'success' | 'error';

interface SourcifyResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  status?: number;
}

function extractVerificationId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  const direct = record.verificationId;
  if (typeof direct === 'string') return direct;
  const nested = record.result;
  if (nested && typeof nested === 'object') {
    const nestedId = (nested as Record<string, unknown>).verificationId;
    if (typeof nestedId === 'string') return nestedId;
  }
  return null;
}

function extractStatus(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  for (const key of ['status', 'statusMessage', 'message']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  const nested = record.result;
  if (nested && typeof nested === 'object') {
    for (const key of ['status', 'statusMessage', 'message']) {
      const value = (nested as Record<string, unknown>)[key];
      if (typeof value === 'string') return value;
    }
  }
  return null;
}

function looksSuccessful(result: unknown): boolean {
  const text = JSON.stringify(result ?? {}).toLowerCase();
  return text.includes('perfect') || text.includes('partial') || text.includes('verified') || text.includes('success');
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function SourcifyVerifyForm({ defaultAddress = '' }: { defaultAddress?: string }) {
  const [address, setAddress] = useState(defaultAddress);
  const [chainId, setChainId] = useState('61803');
  const [compilerVersion, setCompilerVersion] = useState('');
  const [contractIdentifier, setContractIdentifier] = useState('');
  const [creationTransactionHash, setCreationTransactionHash] = useState('');
  const [stdJsonInput, setStdJsonInput] = useState('');
  const [state, setState] = useState<SubmitState>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [rawResult, setRawResult] = useState<unknown>(null);

  const canSubmit = useMemo(
    () =>
      address.trim().length > 0 &&
      chainId.trim().length > 0 &&
      compilerVersion.trim().length > 0 &&
      contractIdentifier.trim().length > 0 &&
      stdJsonInput.trim().length > 0 &&
      state !== 'submitting' &&
      state !== 'polling',
    [address, chainId, compilerVersion, contractIdentifier, stdJsonInput, state],
  );

  async function poll(id: string) {
    setState('polling');
    setMessage('Verification submitted. Polling Sourcify for match status...');
    for (let i = 0; i < 12; i++) {
      await sleep(i < 3 ? 1500 : 3000);
      const response = await fetch(`/api/explorer/sourcify/verify?verificationId=${encodeURIComponent(id)}`, {
        cache: 'no-store',
      });
      const json = (await response.json()) as SourcifyResponse;
      setRawResult(json.result ?? json);
      const statusText = extractStatus(json.result ?? json);
      if (statusText) setMessage(statusText);
      if (json.ok && looksSuccessful(json.result)) {
        setState('success');
        setMessage('Contract verified through Sourcify. Open the contract page to view verified source and ABI data.');
        return;
      }
      const resultText = JSON.stringify(json.result ?? json).toLowerCase();
      if (!json.ok || resultText.includes('error') || resultText.includes('failed')) {
        setState('error');
        setMessage(json.error ?? statusText ?? 'Sourcify returned a failed verification status.');
        return;
      }
    }
    setState('polling');
    setMessage('Verification is still processing. Keep this verification ID and refresh status shortly.');
  }

  async function submit() {
    setState('submitting');
    setMessage(null);
    setVerificationId(null);
    setRawResult(null);

    let parsedStdJson: unknown;
    try {
      parsedStdJson = JSON.parse(stdJsonInput);
    } catch {
      setState('error');
      setMessage('Standard JSON compiler input must be valid JSON.');
      return;
    }

    const response = await fetch('/api/explorer/sourcify/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: address.trim(),
        chainId: chainId.trim(),
        compilerVersion: compilerVersion.trim(),
        contractIdentifier: contractIdentifier.trim(),
        creationTransactionHash: creationTransactionHash.trim(),
        stdJsonInput: parsedStdJson,
      }),
    });

    const json = (await response.json()) as SourcifyResponse;
    setRawResult(json.result ?? json);
    if (!response.ok || !json.ok) {
      setState('error');
      setMessage(json.error ?? 'Sourcify verification request failed.');
      return;
    }

    const id = extractVerificationId(json.result);
    if (id) {
      setVerificationId(id);
      await poll(id);
      return;
    }

    if (looksSuccessful(json.result)) {
      setState('success');
      setMessage('Contract verified through Sourcify.');
      return;
    }

    setState('success');
    setMessage('Verification request accepted by Sourcify.');
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Verification request</h2>
          <p className="mt-1 text-sm text-white/55">Etica mainnet defaults to chain 61803.</p>
        </div>
        <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/60">
          Powered by Sourcify
        </div>
      </div>

      <div className="grid gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Contract address">
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="0x..."
              className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder-white/35 focus:border-brand-accent focus:outline-none"
            />
          </Field>

          <Field label="Chain ID">
            <input
              value={chainId}
              onChange={(event) => setChainId(event.target.value)}
              className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder-white/35 focus:border-brand-accent focus:outline-none"
            />
          </Field>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Compiler version">
            <input
              value={compilerVersion}
              onChange={(event) => setCompilerVersion(event.target.value)}
              placeholder="v0.8.24+commit.e11b9ed9"
              className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder-white/35 focus:border-brand-accent focus:outline-none"
            />
          </Field>

          <Field label="Contract identifier">
            <input
              value={contractIdentifier}
              onChange={(event) => setContractIdentifier(event.target.value)}
              placeholder="contracts/MyContract.sol:MyContract"
              className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder-white/35 focus:border-brand-accent focus:outline-none"
            />
          </Field>
        </div>

        <Field label="Creation transaction hash (optional)">
          <input
            value={creationTransactionHash}
            onChange={(event) => setCreationTransactionHash(event.target.value)}
            placeholder="0x..."
            className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder-white/35 focus:border-brand-accent focus:outline-none"
          />
        </Field>

        <Field label="Standard JSON compiler input">
          <textarea
            rows={18}
            value={stdJsonInput}
            onChange={(event) => setStdJsonInput(event.target.value)}
            placeholder='{"language":"Solidity","sources":{...},"settings":{...}}'
            className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-4 font-mono text-xs text-white placeholder-white/30 focus:border-brand-accent focus:outline-none"
          />
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 p-4">
          <div className="max-w-2xl text-xs leading-5 text-white/50">
            Verification submissions are forwarded through the EticaHub Explorer API layer to
            Sourcify. Matching contracts automatically gain verified status inside explorer pages.
          </div>

          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="rounded-xl bg-brand-accent px-5 py-3 text-sm font-semibold text-brand-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {state === 'submitting' ? 'Submitting...' : state === 'polling' ? 'Checking...' : 'Submit verification'}
          </button>
        </div>

        {message ? (
          <div
            className={
              state === 'error'
                ? 'rounded-2xl border border-rose-400/25 bg-rose-400/10 p-4 text-sm text-rose-200'
                : state === 'success'
                  ? 'rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-4 text-sm text-emerald-200'
                  : 'rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-200'
            }
          >
            <div>{message}</div>
            {verificationId ? (
              <div className="mt-2 break-all font-mono text-xs opacity-75">Verification ID: {verificationId}</div>
            ) : null}
            {state === 'success' && address ? (
              <a href={`/explorer/address/${address}`} className="mt-3 inline-block text-xs underline underline-offset-4">
                Open contract page →
              </a>
            ) : null}
          </div>
        ) : null}

        {rawResult ? (
          <details className="rounded-xl border border-white/10 bg-black/30">
            <summary className="cursor-pointer px-3 py-2 text-xs uppercase tracking-wider text-white/45 hover:text-white/70">
              Raw Sourcify response
            </summary>
            <pre className="max-h-80 overflow-auto border-t border-white/10 px-3 py-3 font-mono text-[11px] leading-relaxed text-white/65">
              {JSON.stringify(rawResult, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <div className="text-xs uppercase tracking-wider text-white/45">{label}</div>
      {children}
    </label>
  );
}
