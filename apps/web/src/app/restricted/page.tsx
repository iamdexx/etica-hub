import Link from 'next/link';

export const metadata = {
  title: 'Not available in your region · EticaHub',
  robots: { index: false, follow: false },
};

/**
 * Compliance notice surfaced when the edge middleware detects a request
 * from a restricted jurisdiction (currently: United States) hitting one of
 * the yield-bearing surfaces (`/stake`, `/farms`).
 *
 * The page is intentionally information-only: no wallet wiring, no chain
 * RPC calls, no contract reads. The smart contracts remain permissionless
 * and reachable by any direct on-chain interaction — this is a frontend
 * good-faith gate, not a protocol-level restriction.
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
          where EticaHub does not currently offer access to yield-bearing
          staking surfaces. This notice applies to the{' '}
          <code className="rounded bg-white/5 px-1.5 py-0.5">/stake</code>{' '}
          page (stETX liquid staking) and the{' '}
          <code className="rounded bg-white/5 px-1.5 py-0.5">/farms</code>{' '}
          page (staking LP tokens to earn redistributed protocol fees) only.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-white/70">
          <strong className="text-white/90">Supplying liquidity is not gated.</strong>{' '}
          Adding or removing liquidity on{' '}
          <Link href="/pool" className="text-brand-accent hover:underline">
            /pool
          </Link>{' '}
          (V2 pairs and the stableswap LP card) remains available. What is
          gated is the optional yield-bearing staking flow that consumes LP
          tokens once you already have them, not the act of supplying
          liquidity itself.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-white/70">
          The underlying EticaHub contracts are open-source, permissionless,
          and reachable by any wallet on the Etica network. This page is a
          frontend access notice, not a protocol-level restriction.
        </p>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        <h2 className="text-base font-semibold text-white">
          What you can still do here
        </h2>
        <ul className="mt-3 space-y-2 text-sm text-white/70">
          <li>
            <Link href="/swap" className="text-brand-accent hover:underline">
              /swap
            </Link>{' '}
            — trade tokens through EticaSwap.
          </li>
          <li>
            <Link href="/pool" className="text-brand-accent hover:underline">
              /pool
            </Link>{' '}
            — supply or withdraw liquidity on EticaSwap V2 pairs and the
            EticaStableSwap (V3) pool.
          </li>
          <li>
            <Link href="/trade" className="text-brand-accent hover:underline">
              /trade
            </Link>{' '}
            — intent-based limit / stop / DCA orders.
          </li>
          <li>
            <Link href="/explorer" className="text-brand-accent hover:underline">
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

      <p className="text-center text-xs text-white/40">
        If you believe you are seeing this page in error (for example, your
        IP is geolocating incorrectly), the underlying contracts can still be
        interacted with directly via any block explorer or wallet.
      </p>
    </div>
  );
}
