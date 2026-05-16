interface AggregatorLink {
  label: string;
  href: string;
}

function aggregatorLinks(): AggregatorLink[] {
  const out: AggregatorLink[] = [];
  const cg = process.env.NEXT_PUBLIC_COINGECKO_COIN_ID;
  if (cg) out.push({ label: 'CoinGecko', href: `https://www.coingecko.com/en/coins/${cg}` });

  const cmc = process.env.NEXT_PUBLIC_CMC_SLUG;
  if (cmc) out.push({ label: 'CoinMarketCap', href: `https://coinmarketcap.com/currencies/${cmc}/` });

  const ds = process.env.NEXT_PUBLIC_DEXSCREENER_PAIR;
  if (ds) out.push({ label: 'DEX Screener', href: `https://dexscreener.com/etica/${ds}` });

  const gt = process.env.NEXT_PUBLIC_GECKOTERMINAL_POOL;
  if (gt) out.push({ label: 'GeckoTerminal', href: `https://www.geckoterminal.com/etica/pools/${gt}` });

  return out;
}

export function SiteFooter() {
  const links = aggregatorLinks();
  const year = new Date().getFullYear();

  return (
    <footer className="mx-auto mt-10 w-full max-w-7xl border-t border-white/5 px-3 py-6 text-xs text-white/45 sm:px-4 md:px-5 lg:px-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1">
          <p className="text-white/55">
            © {year} EticaHub · non-custodial DeFi on Etica Protocol (chain 61803)
          </p>
          <p className="max-w-2xl leading-5 text-white/35">
            DEX, staking, governance research, farming, bridging, and liquidity infrastructure built directly on the Etica execution layer.
          </p>
        </div>

        {links.length > 0 && (
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {links.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-white/55 transition-colors hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </footer>
  );
}
