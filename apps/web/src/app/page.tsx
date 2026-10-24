import Link from 'next/link';
import { BrandMark } from '@/components/BrandMark';
import { ChainPulse } from '@/components/ChainPulse';
import { Eyebrow, SectionTitle } from '@/components/PageHero';
import { TvlBanner } from '@/components/TvlBanner';
import { MarketVolumeStrip } from '@/components/MarketVolumeStrip';
import { AddNetworkButton } from '@/components/network/AddNetworkButton';
import { AddTokenButton } from '@/components/network/AddTokenButton';

const PILLARS = [
  {
    href: '/labs',
    eyebrow: 'Etica Labs',
    title: 'An autonomous AI lab that designs, folds and verifies proteins.',
    body: 'Natural-language design, multi-engine structure prediction with failover, objective verification grades, and every discovery minted on-chain.',
    cta: 'Enter the lab',
    stat: ['Verified archive', 'UniProt-grounded'],
  },
  {
    href: '/swap',
    eyebrow: 'EticaSwap',
    title: 'Hub-and-spoke liquidity with permanently locked reserves.',
    body: 'Every market routes through ETX. Initial liquidity is burned to the dead address, so floors only move up.',
    cta: 'Open swap',
    stat: ['Protocol-owned', 'POL burned'],
  },
  {
    href: '/bridge',
    eyebrow: 'EticaBridge',
    title: 'Circle USDC in, USDC.e out, secured by Hyperlane.',
    body: 'Validator-signed checkpoints, bounded releases, autonomous relayer and keeper, gas drop for first-time recipients.',
    cta: 'Bridge USDC',
    stat: ['1:1 backed', 'Ethereum ⇄ Etica'],
  },
];

const MODULES = [
  { href: '/trade', title: 'Trade', body: 'Limit, stop, DCA and grid orders, non-custodial.' },
  { href: '/pool', title: 'Pool', body: 'Add liquidity, track positions and fees earned.' },
  { href: '/stake', title: 'Stake', body: 'ETX → stETX, an appreciating vault share.' },
  { href: '/farms', title: 'Farms', body: 'Fee-backed emissions for LP positions.' },
  {
    href: '/research',
    title: 'Research',
    body: 'On-chain governance proposals with IPFS context.',
  },
  {
    href: '/research-markets',
    title: 'Markets',
    body: 'Bonding-curve launchpad for research tokens.',
  },
  { href: '/explorer', title: 'Explorer', body: 'Blocks, transactions, tokens, pairs, contracts.' },
  { href: '/status', title: 'Status', body: 'Live protocol health, straight from chain.' },
];

export default function Home() {
  return (
    <div className="space-y-20 md:space-y-28">
      <section className="relative pt-4 md:pt-10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-28 hidden h-[36rem] w-[36rem] opacity-[0.16] lg:block"
        >
          <BrandMark animate className="h-full w-full" />
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-40 top-0 h-80 w-[40rem] rounded-full bg-brand-accent/15 blur-3xl"
        />

        <div className="relative max-w-4xl space-y-7" data-stagger>
          <ChainPulse />
          <h1 className="display text-5xl sm:text-6xl md:text-7xl lg:text-[5.5rem]">
            Finance and <span className="text-gradient">discovery</span>, on one chain.
          </h1>
          <p className="lede max-w-2xl">
            EticaHub is the DEX, liquid-staking vault, Ethereum bridge and autonomous AI protein lab
            for the Etica network. Open, non-custodial, and built so every trade funds verified
            research.
          </p>
          <div className="flex flex-wrap items-center gap-2.5">
            <Link href="/labs" className="btn-primary px-5 py-2.5">
              Explore the lab
            </Link>
            <Link href="/swap" className="btn-ghost px-5 py-2.5">
              Trade on EticaSwap
            </Link>
            <Link href="/whitepaper" className="btn px-3 text-white/60 hover:text-white">
              Read the whitepaper →
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <AddNetworkButton className="btn-ghost px-4 py-2 text-sm" />
            <span className="text-white/35">then</span>
            <AddTokenButton token="ETX" />
            <AddTokenButton token="stETX" />
            <AddTokenButton token="USDC.e" />
          </div>
        </div>

        <div className="relative mt-12 grid gap-4 md:grid-cols-2" data-stagger>
          <TvlBanner />
          <MarketVolumeStrip />
        </div>
      </section>

      <section className="space-y-8">
        <SectionTitle eyebrow="What runs here" title="Three systems, one execution layer." />
        <div className="grid gap-4 lg:grid-cols-3" data-stagger>
          {PILLARS.map((p, i) => (
            <Link
              key={p.href}
              href={p.href}
              className="surface surface-hover group relative flex flex-col overflow-hidden p-6 md:p-7"
            >
              <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-brand-accent/10 blur-2xl transition-opacity duration-500 group-hover:opacity-100 opacity-0" />
              <div className="flex items-center justify-between">
                <Eyebrow live={false}>{p.eyebrow}</Eyebrow>
                <span className="num text-xs text-white/30">0{i + 1}</span>
              </div>
              <h3 className="mt-6 text-2xl font-semibold leading-tight tracking-tight text-white">
                {p.title}
              </h3>
              <p className="mt-3 text-sm leading-6 text-white/55">{p.body}</p>
              <div className="mt-auto flex items-center justify-between pt-8">
                <div className="flex flex-wrap gap-1.5">
                  {p.stat.map((s) => (
                    <span key={s} className="chip">
                      {s}
                    </span>
                  ))}
                </div>
                <span className="text-sm font-medium text-brand-glow transition-transform duration-300 group-hover:translate-x-1">
                  {p.cta} →
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="space-y-8">
        <SectionTitle
          eyebrow="Modules"
          title="Everything else on the hub."
          action={
            <Link href="/status" className="chip-live">
              <span className="live-dot" /> all systems live
            </Link>
          }
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-stagger>
          {MODULES.map((m) => (
            <Link key={m.href} href={m.href} className="surface-2 surface-hover group p-5">
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-white">{m.title}</div>
                <span className="text-white/30 transition-colors group-hover:text-brand-glow">
                  →
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-white/50">{m.body}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="surface relative overflow-hidden p-8 md:p-12">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-32 -left-20 h-72 w-72 opacity-10"
        >
          <BrandMark className="h-full w-full" />
        </div>
        <div className="relative grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
          <div className="max-w-2xl space-y-4">
            <Eyebrow live={false}>Independent · community-built</Eyebrow>
            <h2 className="display text-3xl md:text-4xl">Read how the pieces fit together.</h2>
            <p className="text-sm leading-6 text-white/55 md:text-base">
              ETX tokenomics, the hub-and-spoke DEX, stETX, the Treasury Harvester, the bridge
              security model and the Labs verification pipeline, in one specification.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/whitepaper" className="btn-primary px-5 py-2.5">
              Whitepaper v2.1
            </Link>
            <Link href="/api" className="btn-ghost px-5 py-2.5">
              Public API
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
