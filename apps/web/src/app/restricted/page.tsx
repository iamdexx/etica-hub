import Link from 'next/link';

export const metadata = {
  title: 'Not available in your region · EticaHub',
  robots: { index: false, follow: false },
};

/**
 * Compliance notice surfaced when the edge middleware detects a request
 * from a restricted jurisdiction (currently: United States) hitting one of
 * the gated surfaces (`/stake`, `/farms`). The same geo signal is read by
 * `/swap` and `/pool` to hide stETX from token pickers, hide the stETX/ETX
 * stableswap LP card, and filter stETX-containing positions out of the
 * positions list. There is no "exit only" affordance — the entire stETX
 * surface is suppressed from the frontend for visitors in restricted
 * regions.
 *
 * The page is intentionally information-only: no wallet wiring, no chain
 * RPC calls, no contract reads. The smart contracts themselves remain
 * permissionless on-chain; this is a frontend access policy.
 */
export default function RestrictedPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 py-10">
      <div className="rounded-2xl border border-amber-400/30 bg-amber-500/[0.06] p-6">
        <h1 className="text-2xl font-semibold tracking-tight text-amber-200">
          Not available in your region
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-white/70">
          Based on your IP address, you appear to be visiting from a region
          where EticaHub does not currently offer access to stETX or to
          yield-bearing surfaces. The following are not available on this
          frontend:
        </p>
        <ul className="mt-3 space-y-1.5 text-sm leading-relaxed text-white/70">
          <li>
            <code className="rounded bg-white/5 px-1.5 py-0.5">/stake</code> —
            the stETX liquid-staking vault.
          </li>
          <li>
            <code className="rounded bg-white/5 px-1.5 py-0.5">/farms</code> —
            LP-staking pools.
          </li>
          <li>
            stETX as a swap token on{' '}
            <code className="rounded bg-white/5 px-1.5 py-0.5">/swap</code>.
          </li>
          <li>
            The stETX/ETX stableswap LP card and stETX pairs on{' '}
            <code className="rounded bg-white/5 px-1.5 py-0.5">/pool</code>.
          </li>
        </ul>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        <h2 className="text-base font-semibold text-white">
          What is available
        </h2>
        <ul className="mt-3 space-y-2 text-sm text-white/70">
          <li>
            <Link href="/swap" className="text-brand-accent hover:underline">
              /swap
            </Link>{' '}
            — EGAZ, ETI, ETX, and ERC20 trades. stETX is not selectable.
          </li>
          <li>
            <Link href="/pool" className="text-brand-accent hover:underline">
              /pool
            </Link>{' '}
            — V2 liquidity for non-stETX pairs.
          </li>
          <li>
            <Link href="/trade" className="text-brand-accent hover:underline">
              /trade
            </Link>{' '}
            — intent-based limit / stop / DCA orders.
          </li>
          <li>
            <Link href="/bridge" className="text-brand-accent hover:underline">
              /bridge
            </Link>{' '}
            — cross-chain ETX bridge (Etica ↔ Ethereum, BNB).
          </li>
          <li>
            <Link
              href="/explorer"
              className="text-brand-accent hover:underline"
            >
              /explorer
            </Link>{' '}
            — chain explorer, address pages, contract source verification.
          </li>
          <li>
            <Link
              href="/whitepaper"
              className="text-brand-accent hover:underline"
            >
              /whitepaper
            </Link>{' '}
            — protocol design, tokenomics, security model.
          </li>
        </ul>
      </div>
    </div>
  );
}
