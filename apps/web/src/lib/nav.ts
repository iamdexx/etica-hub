export interface NavLink {
  href: string;
  label: string;
  desc: string;
}

export interface NavGroup {
  label: string;
  links: NavLink[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Trade',
    links: [
      { href: '/swap', label: 'Swap', desc: 'ETX-routed spot swaps' },
      { href: '/trade', label: 'Trade', desc: 'Limit · stop · DCA · grid' },
      { href: '/pool', label: 'Pool', desc: 'Add and manage liquidity' },
      { href: '/stake', label: 'Stake', desc: 'ETX → stETX vault' },
      { href: '/farms', label: 'Farms', desc: 'Fee-backed LP emissions' },
      { href: '/bridge', label: 'Bridge', desc: 'USDC ⇄ USDC.e over Hyperlane' },
    ],
  },
  {
    label: 'Research',
    links: [
      { href: '/labs', label: 'Labs', desc: 'AI protein design & folding' },
      { href: '/labs/archive', label: 'Archive', desc: 'Verified discoveries' },
      { href: '/research', label: 'Proposals', desc: 'On-chain governance research' },
      { href: '/research-markets', label: 'Markets', desc: 'Research-token launchpad' },
    ],
  },
  {
    label: 'Explore',
    links: [
      { href: '/explorer', label: 'Explorer', desc: 'Blocks · txs · contracts' },
      { href: '/tokens', label: 'Tokens', desc: 'Prices and contracts' },
      { href: '/pools', label: 'Pools', desc: 'Reserves and TVL' },
      { href: '/status', label: 'Status', desc: 'Live protocol health' },
    ],
  },
  {
    label: 'Docs',
    links: [
      { href: '/network', label: 'Wallet setup', desc: 'Etica network and token settings' },
      { href: '/whitepaper', label: 'Whitepaper', desc: 'Protocol specification v2.1' },
      { href: '/api', label: 'API', desc: 'Public endpoints and feeds' },
      { href: '/tutorials', label: 'Tutorials', desc: 'Step-by-step video guides' },
    ],
  },
];

export const ALL_LINKS: NavLink[] = NAV_GROUPS.flatMap((g) => g.links);

/** Where to go after each page; longest-prefix match on the pathname. */
export const NEXT_UP: Record<string, string[]> = {
  '/swap': ['/pool', '/trade', '/stake'],
  '/trade': ['/swap', '/explorer', '/research-markets'],
  '/pool': ['/farms', '/pools', '/swap'],
  '/stake': ['/farms', '/pool', '/swap'],
  '/farms': ['/stake', '/pool', '/explorer'],
  '/bridge': ['/tutorials', '/swap', '/status'],
  '/labs': ['/labs/archive', '/research', '/research-markets'],
  '/labs/archive': ['/labs', '/research-markets', '/research'],
  '/research': ['/research-markets', '/labs', '/whitepaper'],
  '/research-markets': ['/trade', '/labs', '/swap'],
  '/explorer': ['/tokens', '/pools', '/status'],
  '/tokens': ['/pools', '/swap', '/explorer'],
  '/pools': ['/pool', '/tokens', '/explorer'],
  '/status': ['/explorer', '/bridge', '/api'],
  '/whitepaper': ['/swap', '/labs', '/research'],
  '/api': ['/status', '/explorer', '/whitepaper'],
  '/tutorials': ['/bridge', '/swap', '/pool'],
  '/network': ['/tutorials', '/bridge', '/swap'],
};

export function nextUpFor(pathname: string): NavLink[] {
  const keys = Object.keys(NEXT_UP).sort((a, b) => b.length - a.length);
  const key = keys.find((k) => pathname === k || pathname.startsWith(k + '/'));
  if (!key) return [];
  return NEXT_UP[key]!.map((href) => ALL_LINKS.find((l) => l.href === href)).filter(
    (l): l is NavLink => Boolean(l),
  );
}

export const TELEGRAM_URL = 'https://t.me/EticaHubPortal';
export const GITHUB_URL = 'https://github.com/iamdexx/etica-hub';
