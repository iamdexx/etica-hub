import Link from 'next/link';

const MODULES = [
  {
    href: '/explorer',
    title: 'EticaHub Scan',
    subtitle: 'Explorer · charts · contracts',
    body: 'Etherscan-style Etica explorer with live blocks, transactions, tokens, pairs, candlestick charts, deploy tools, and contract verification in one scanner-grade terminal.',
    cta: 'Open explorer',
    accent: 'from-emerald-400/35 to-cyan-700/10',
  },
  {
    href: '/explorer/pairs',
    title: 'Pair Analytics',
    subtitle: 'Markets · OHLC · liquidity',
    body: 'Real market panels for Etica pairs with OHLC candles, volume bars, spread/depth cards, and terminal-style chart controls surfaced from the Explorer.',
    cta: 'View pairs',
    accent: 'from-lime-500/30 to-emerald-700/10',
  },
  {
    href: '/swap',
    title: 'EticaSwap',
    subtitle: 'On-chain DEX · live',
    body: 'Swap EGAZ, ETI, ETX, and stETX on Etica Mainnet with ETX as the shared hub asset.',
    cta: 'Open swap',
    accent: 'from-emerald-500/30 to-emerald-700/10',
  },
  {
    href: '/stake',
    title: 'Stake ETX',
    subtitle: 'stETX liquid staking vault',
    body: 'Deposit ETX, receive stETX, and capture protocol-fee harvest appreciation through the vault exchange rate.',
    cta: 'Open stake',
    accent: 'from-indigo-500/30 to-indigo-700/10',
  },
  {
    href: '/farms',
    title: 'LP Farms',
    subtitle: 'Emission-weighted LP staking',
    body: 'Stake LP positions and route protocol-backed emissions into liquidity strategies.',
    cta: 'Open farms',
    accent: 'from-emerald-500/30 to-teal-700/10',
  },
  {
    href: '/trade/ETI',
    title: 'Trading',
    subtitle: 'Limit · Stop · DCA · Grid',
    body: 'Non-custodial execution surfaces with advanced order strategies and Infinity routing.',
    cta: 'Open trading',
    accent: 'from-amber-500/30 to-amber-700/10',
  },
  {
    href: '/research',
    title: 'Research Hub',
    subtitle: 'Open-science governance',
    body: 'Index on-chain proposals, inspect IPFS research, and track governance activity.',
    cta: 'Browse research',
    accent: 'from-sky-500/30 to-sky-700/10',
  },
  {
    href: '/bridge',
    title: 'EticaBridge',
    subtitle: 'Cross-chain ETI routing',
    body: 'Lock ETI on Etica and bridge into the wider EVM ecosystem through Hyperlane rails.',
    cta: 'Open bridge',
    accent: 'from-fuchsia-500/30 to-fuchsia-700/10',
  },
];

const SCAN_METRICS = [
  ['Scanner', 'Blocks · txs · accounts'],
  ['Markets', 'Tokens · pairs · OHLC'],
  ['Contracts', 'Deploy · verify · inspect'],
];

export default function Home() {
  return (
    <div className="space-y-10 md:space-y-12">
      <section className="grid gap-5 lg:grid-cols-[1fr_0.78fr] lg:items-center">
        <div className="space-y-4">
          <p className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-emerald-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
            Live on Etica Mainnet · chain 61803
          </p>

          <h1 className="max-w-4xl text-4xl font-semibold tracking-tight md:text-6xl">
            EticaHub is a <span className="text-brand-accent">scanner-grade protocol terminal.</span>
          </h1>

          <p className="max-w-2xl text-base text-white/70 md:text-lg">
            Trade, stake, farm, bridge, govern, and inspect Etica from one integrated execution interface with live explorer tooling, market analytics, and protocol telemetry.
          </p>

          <div className="flex flex-wrap gap-2 pt-1">
            <Link
              href="/explorer"
              className="rounded-full bg-brand-accent px-4 py-2 text-sm font-medium text-brand-ink hover:opacity-90"
            >
              Open Explorer
            </Link>

            <Link
              href="/explorer/pairs"
              className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-sm font-medium text-emerald-200 hover:border-emerald-300/50 hover:text-white"
            >
              Pair analytics
            </Link>

            <Link
              href="/swap"
              className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-white/90 hover:border-white/30 hover:text-white"
            >
              Open swap
            </Link>
          </div>
        </div>

        <Link
          href="/explorer"
          className="group overflow-hidden rounded-3xl border border-emerald-400/20 bg-[#06110e] shadow-2xl shadow-emerald-950/20 transition-colors hover:border-emerald-300/40"
        >
          <div className="border-b border-white/10 bg-[radial-gradient(circle_at_top,rgba(52,211,153,0.22),transparent_42%)] p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-emerald-300/70">EticaHub Scan</div>
                <div className="mt-1 text-2xl font-semibold text-white">Explorer Terminal</div>
              </div>

              <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200">
                Live
              </span>
            </div>

            <div className="mt-5 grid gap-2 sm:grid-cols-3">
              {SCAN_METRICS.map(([label, value]) => (
                <div key={label} className="rounded-xl border border-white/10 bg-black/25 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
                  <div className="mt-1 text-xs text-white/75">{value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="p-5">
            <div className="rounded-xl border border-white/10 bg-black/30 p-4">
              <div className="grid gap-2 sm:grid-cols-3">
                <Metric label="Pairs tracked" value="Live" />
                <Metric label="Contracts" value="Verified" />
                <Metric label="Explorer mode" value="Realtime" />
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2 text-xs text-white/55">
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Candles</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Tokens</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Pairs</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Verify</span>
            </div>
          </div>
        </Link>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {MODULES.map((m) => (
          <Link
            key={m.href}
            href={m.href}
            className={`group relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b ${m.accent} p-5 transition-colors hover:border-white/20`}
          >
            <div className="mb-4 text-[11px] uppercase tracking-wider text-white/50">{m.subtitle}</div>
            <div className="text-xl font-semibold">{m.title}</div>
            <p className="mt-2 min-h-[4rem] text-sm leading-6 text-white/70">{m.body}</p>
            <div className="mt-5 text-sm text-brand-accent group-hover:underline">{m.cta} →</div>
          </Link>
        ))}
      </section>

      <section className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-5 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-wider text-white/50">Whitepaper</div>
          <div className="text-xl font-semibold">Read the EticaHub v1 design</div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/70">
            ETX tokenomics, hub-and-spoke DEX rules, governance structure, and protocol architecture documentation.
          </p>
        </div>

        <Link
          href="/whitepaper"
          className="shrink-0 rounded-full border border-white/15 bg-white/5 px-5 py-2 text-sm font-medium text-white/90 hover:border-white/30 hover:text-white"
        >
          Read whitepaper
        </Link>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
      <div className="mt-1 text-sm font-medium text-white/80">{value}</div>
    </div>
  );
}
