import Image from 'next/image';
import Link from 'next/link';
import { GITHUB_URL, NAV_GROUPS, TELEGRAM_URL } from '@/lib/nav';

interface ExternalLink {
  label: string;
  href: string;
}

function aggregatorLinks(): ExternalLink[] {
  const out: ExternalLink[] = [];
  const cg = process.env.NEXT_PUBLIC_COINGECKO_COIN_ID;
  if (cg) out.push({ label: 'CoinGecko', href: `https://www.coingecko.com/en/coins/${cg}` });
  const cmc = process.env.NEXT_PUBLIC_CMC_SLUG;
  if (cmc)
    out.push({ label: 'CoinMarketCap', href: `https://coinmarketcap.com/currencies/${cmc}/` });
  const ds = process.env.NEXT_PUBLIC_DEXSCREENER_PAIR;
  if (ds) out.push({ label: 'DEX Screener', href: `https://dexscreener.com/etica/${ds}` });
  const gt = process.env.NEXT_PUBLIC_GECKOTERMINAL_POOL;
  if (gt)
    out.push({ label: 'GeckoTerminal', href: `https://www.geckoterminal.com/etica/pools/${gt}` });
  out.push({ label: 'DefiLlama', href: 'https://defillama.com/protocol/eticahub' });
  return out;
}

const MORE: ExternalLink[] = [
  { label: 'Research by disease', href: '/labs/diseases' },
  { label: 'Research feed', href: '/labs/feed.xml' },
  { label: 'Pair analytics', href: '/explorer/pairs' },
  { label: 'Contracts', href: '/explorer/contracts' },
];

export function SiteFooter() {
  const external = aggregatorLinks();
  const year = new Date().getFullYear();

  return (
    <footer className="mx-auto mt-20 w-full max-w-7xl px-4 pb-10 sm:px-5 md:px-6 lg:px-8">
      <div className="hairline mb-10" />
      <div className="grid gap-10 lg:grid-cols-[1.3fr_repeat(4,1fr)]">
        <div className="max-w-sm space-y-4">
          <Link href="/" className="inline-flex items-center gap-2.5">
            <Image
              src="/brand/eticahub-mark-64.png"
              alt=""
              width={28}
              height={28}
              className="h-7 w-7"
            />
            <span className="text-base font-semibold tracking-tight text-white">EticaHub</span>
          </Link>
          <p className="text-sm leading-6 text-white/50">
            Non-custodial DEX, liquid staking, Hyperlane bridge and an autonomous AI protein lab,
            built on the Etica execution layer. Chain 61803.
          </p>
          <div className="flex flex-wrap gap-2">
            <a
              href={TELEGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="chip hover:border-white/25 hover:text-white"
            >
              Telegram
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="chip hover:border-white/25 hover:text-white"
            >
              GitHub
            </a>
            {external.map((l) => (
              <a
                key={l.href}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className="chip hover:border-white/25 hover:text-white"
              >
                {l.label}
              </a>
            ))}
          </div>
        </div>

        {NAV_GROUPS.map((g) => (
          <div key={g.label}>
            <div className="eyebrow">{g.label}</div>
            <ul className="mt-3 space-y-2 text-sm">
              {g.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-white/60 transition-colors hover:text-white">
                    {l.label}
                  </Link>
                </li>
              ))}
              {g.label === 'Explore'
                ? MORE.slice(2).map((l) => (
                    <li key={l.href}>
                      <Link
                        href={l.href}
                        className="text-white/60 transition-colors hover:text-white"
                      >
                        {l.label}
                      </Link>
                    </li>
                  ))
                : null}
              {g.label === 'Research'
                ? MORE.slice(0, 2).map((l) => (
                    <li key={l.href}>
                      <Link
                        href={l.href}
                        className="text-white/60 transition-colors hover:text-white"
                      >
                        {l.label}
                      </Link>
                    </li>
                  ))
                : null}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-10 flex flex-col gap-2 border-t border-white/[0.06] pt-5 text-xs text-white/40 sm:flex-row sm:items-center sm:justify-between">
        <p>© {year} EticaHub · community-built, independent of the Etica Protocol core team</p>
        <p className="num">RPC eticamainnet.eticaprotocol.org · chain 61803</p>
      </div>
    </footer>
  );
}
