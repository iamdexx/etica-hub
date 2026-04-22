interface AggregatorLink {
  label: string;
  href: string;
}

function aggregatorLinks(): AggregatorLink[] {
  const out: AggregatorLink[] = [];
  const cg = process.env.NEXT_PUBLIC_COINGECKO_COIN_ID;
  if (cg) out.push({ label: 'Listed on CoinGecko', href: `https://www.coingecko.com/en/coins/${cg}` });
  const cmc = process.env.NEXT_PUBLIC_CMC_SLUG;
  if (cmc) out.push({ label: 'Listed on CoinMarketCap', href: `https://coinmarketcap.com/currencies/${cmc}/` });
  const ds = process.env.NEXT_PUBLIC_DEXSCREENER_PAIR;
  if (ds) out.push({ label: 'Live on DEX Screener', href: `https://dexscreener.com/etica/${ds}` });
  const gt = process.env.NEXT_PUBLIC_GECKOTERMINAL_POOL;
  if (gt) out.push({ label: 'Live on GeckoTerminal', href: `https://www.geckoterminal.com/etica/pools/${gt}` });
  return out;
}

export function SiteFooter() {
  const links = aggregatorLinks();
  const year = new Date().getFullYear();

  return (
    <footer className="mx-auto mt-16 w-full max-w-6xl border-t border-white/5 px-4 py-8 text-sm text-white/50">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <p>
          © {year} EticaHub · non-custodial DeFi on Etica Protocol (chain 61803)
        </p>
        {links.length > 0 && (
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {links.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white/60 hover:text-white hover:underline"
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
