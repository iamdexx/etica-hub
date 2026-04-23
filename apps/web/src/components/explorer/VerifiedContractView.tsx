import type { VerifiedContract } from '@/lib/verified';

/**
 * GitHub repository the verified manifests are committed to. We link the
 * raw JSON back to this repo (pinned to `VERCEL_GIT_COMMIT_SHA` when
 * available, otherwise `main`) so any third party can cross-check our
 * sources without having to trust eticahub.com specifically — the
 * manifest they see rendered here is byte-identical to the file in the
 * public repo.
 */
const MANIFEST_REPO = 'iamdexx/etica-hub';
const MANIFEST_PATH_PREFIX = 'apps/web/public/verified';

function manifestRawUrl(address: `0x${string}`): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || 'main';
  return `https://raw.githubusercontent.com/${MANIFEST_REPO}/${sha}/${MANIFEST_PATH_PREFIX}/${address.toLowerCase()}.json`;
}

/**
 * Server-rendered "Contract" section for the explorer address page.
 *
 * Renders the three pieces an etherscan-style verified contract tab needs:
 *   - Header: contract name + compiler + optimizer + match strength
 *   - Source code: one collapsible `<details>` per file, with the primary
 *     source file (one whose key matches the contract name) open by default
 *   - ABI: pretty-printed JSON, collapsed by default
 *
 * Kept pure-server so the full source can be shipped in the initial HTML
 * without any client JS, matching the rest of the explorer.
 */
export function VerifiedContractView({ manifest }: { manifest: VerifiedContract }) {
  const sourceEntries = Object.entries(manifest.sources);
  // Heuristic: the "primary" source is the one whose path ends in
  // `/<ContractName>.sol`. Falls back to the first entry so something is
  // always open.
  const primaryIndex = Math.max(
    0,
    sourceEntries.findIndex(([path]) =>
      path.toLowerCase().endsWith(`/${manifest.name.toLowerCase()}.sol`),
    ),
  );

  return (
    <section className="rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.02] p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300">
              <span aria-hidden>✓</span> Verified
            </span>
            <h2 className="text-lg font-semibold">{manifest.name}</h2>
          </div>
          <p className="mt-1 text-xs text-white/50">
            Compiled with solc {manifest.compilerVersion}
            {' · '}
            optimizer {manifest.optimizer.enabled ? 'on' : 'off'}
            {manifest.optimizer.enabled
              ? ` (${manifest.optimizer.runs.toLocaleString()} runs)`
              : ''}
            {' · '}
            evm {manifest.evmVersion}
          </p>
        </div>
        <div className="text-right text-[10px] uppercase tracking-wider text-white/40">
          <div>bytecode match</div>
          <div className="text-white/70">{matchBadge(manifest.bytecodeMatch)}</div>
        </div>
      </div>

      {manifest.notes ? (
        <p className="mb-4 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs text-white/60">
          {manifest.notes}
        </p>
      ) : null}

      <div className="mb-4">
        <div className="mb-2 text-xs uppercase tracking-wider text-white/50">
          Source code · {sourceEntries.length} file{sourceEntries.length === 1 ? '' : 's'}
        </div>
        <div className="space-y-2">
          {sourceEntries.map(([path, { content }], i) => (
            <details
              key={path}
              className="rounded-lg border border-white/5 bg-black/30"
              open={i === primaryIndex}
            >
              <summary className="cursor-pointer px-3 py-2 font-mono text-[11px] text-white/70 hover:text-white">
                {path}
              </summary>
              <pre className="max-h-[32rem] overflow-auto border-t border-white/5 px-3 py-2 font-mono text-[11px] leading-relaxed text-white/80">
                {content}
              </pre>
            </details>
          ))}
        </div>
      </div>

      <details className="rounded-lg border border-white/5 bg-black/30">
        <summary className="cursor-pointer px-3 py-2 text-xs uppercase tracking-wider text-white/50 hover:text-white/70">
          Contract ABI · {manifest.abi.length} entr{manifest.abi.length === 1 ? 'y' : 'ies'}
        </summary>
        <pre className="max-h-[32rem] overflow-auto border-t border-white/5 px-3 py-2 font-mono text-[11px] leading-relaxed text-white/75">
          {JSON.stringify(manifest.abi, null, 2)}
        </pre>
      </details>

      <p className="mt-3 text-[10px] text-white/35">
        Verified {new Date(manifest.verifiedAt).toISOString().slice(0, 10)} against on-chain runtime
        bytecode.{' '}
        <a
          href={manifestRawUrl(manifest.address)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-emerald-300/70 underline decoration-emerald-300/30 underline-offset-2 hover:text-emerald-200 hover:decoration-emerald-300/70"
        >
          Cross-verify manifest on GitHub ↗
        </a>
      </p>
    </section>
  );
}

function matchBadge(match: VerifiedContract['bytecodeMatch']): string {
  switch (match) {
    case 'exact':
      return 'exact';
    case 'with-immutables':
      return 'match (immutables masked)';
    case 'with-metadata-hash':
      return 'match (metadata stripped)';
  }
}
