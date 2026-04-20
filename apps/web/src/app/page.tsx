import Link from 'next/link';

const MODULES = [
  {
    href: '/swap',
    title: 'EticaSwap',
    subtitle: 'On-chain DEX',
    body:
      'First Uniswap V2–style AMM on Etica mainnet. Swap ETI/EGAZ and any ERC20 deployed on Etica. 0.30% fee.',
    cta: 'Open swap',
    accent: 'from-emerald-500/30 to-emerald-700/10',
  },
  {
    href: '/research',
    title: 'Research Hub',
    subtitle: 'Open-science proposal viewer',
    body:
      'Index every on-chain research proposal, render its IPFS content, track voter activity, and tip researchers directly in ETI.',
    cta: 'Browse research',
    accent: 'from-sky-500/30 to-sky-700/10',
  },
  {
    href: '/bridge',
    title: 'EticaBridge',
    subtitle: 'ETI ↔ Ethereum',
    body:
      'Lock ETI on Etica, mint wETI on Ethereum. Unlocks Uniswap, 1inch, and the wider EVM DeFi universe for Etica assets.',
    cta: 'Open bridge',
    accent: 'from-fuchsia-500/30 to-fuchsia-700/10',
  },
];

export default function Home() {
  return (
    <div className="space-y-14">
      <section className="space-y-4">
        <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase tracking-wider text-white/70">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-accent" />
          Building on Etica mainnet · chain 61803
        </p>
        <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">
          The missing infrastructure for the <span className="text-brand-accent">Etica ecosystem.</span>
        </h1>
        <p className="max-w-2xl text-lg text-white/70">
          EticaHub brings three things Etica doesn&apos;t have yet: an on-chain AMM, a searchable
          research hub for every proposal, and a bridge to Ethereum. One site, one wallet, one
          place to support open-source medical research.
        </p>
      </section>

      <section className="grid gap-6 md:grid-cols-3">
        {MODULES.map((m) => (
          <Link
            key={m.href}
            href={m.href}
            className={`group relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b ${m.accent} p-6 transition-colors hover:border-white/20`}
          >
            <div className="mb-6 text-xs uppercase tracking-wider text-white/50">{m.subtitle}</div>
            <div className="text-2xl font-semibold">{m.title}</div>
            <p className="mt-2 min-h-[4.5rem] text-sm text-white/70">{m.body}</p>
            <div className="mt-6 text-sm text-brand-accent group-hover:underline">{m.cta} →</div>
          </Link>
        ))}
      </section>
    </div>
  );
}
