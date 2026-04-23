/**
 * Banner shown at the top of every operator-only page (/deploy/*, /admin/*,
 * /seed/*) to set expectations for a casual visitor:
 *
 *   - these pages call live on-chain writes,
 *   - deploying a "clone" contract from here does NOT affect the canonical
 *     EticaHub deployment — that's pinned in `packages/shared/src/addresses.ts`
 *     and wired into the app at build time,
 *   - writes are gated by the actual contract permissions (onlyOwner,
 *     onlyKeeper, etc.), not by this UI being hidden.
 *
 * Keeps these tools accessible for protocol maintainers without needing the
 * Vercel env-var flag dance while being honest with everyone else about what
 * the page is and isn't.
 */
export function OperatorBanner() {
  return (
    <div className="mb-6 rounded-2xl border border-amber-400/25 bg-amber-400/5 p-4 text-xs text-amber-100/80">
      <div className="mb-1 uppercase tracking-wider text-amber-200/80">Operator-only tool</div>
      <p>
        This page is a maintenance tool for EticaHub protocol operators. It fires real on-chain
        transactions from your connected wallet. Contracts &ldquo;deployed&rdquo; from here are your
        own fresh instances &mdash; they are <em>not</em> the canonical EticaHub contracts. The
        authoritative deployment addresses are pinned in{' '}
        <span className="font-mono">packages/shared/src/addresses.ts</span> and are the only ones
        the app reads from. If you&apos;re just here to swap, stake, farm, or trade, you want the
        main nav above &mdash; not this page.
      </p>
    </div>
  );
}
