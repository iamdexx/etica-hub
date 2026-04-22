'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ConnectButton } from './ConnectButton';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/swap', label: 'Swap' },
  { href: '/trade', label: 'Trade' },
  { href: '/pool', label: 'Pool' },
  { href: '/research', label: 'Research' },
  { href: '/bridge', label: 'Bridge' },
  { href: '/explorer', label: 'Explorer' },
  { href: '/whitepaper', label: 'Whitepaper' },
  { href: '/status', label: 'Status' },
];

export function SiteHeader() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + '/');
  return (
    <header className="sticky top-0 z-20 border-b border-white/5 bg-black/40 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-4">
        <Link href="/" className="flex items-center gap-2">
          <span className="inline-block h-6 w-6 rounded-full bg-brand-accent" />
          <span className="text-lg font-semibold tracking-tight">EticaHub</span>
          <span className="hidden rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300 sm:inline">
            live · mainnet
          </span>
        </Link>

        <nav className="hidden items-center gap-1 rounded-full border border-white/10 bg-white/5 px-1 py-1 md:flex">
          {NAV.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'rounded-full px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-brand-accent text-brand-ink'
                    : 'text-white/70 hover:bg-white/5 hover:text-white',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <ConnectButton />
      </div>

      {/* Mobile nav: visible only below md, horizontally scrollable so all
          links fit on narrow screens without hiding anything behind a menu. */}
      <nav
        aria-label="Primary navigation"
        className="border-t border-white/5 md:hidden"
      >
        <div className="mx-auto flex w-full max-w-6xl gap-1 overflow-x-auto px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {NAV.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'shrink-0 rounded-full border px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'border-brand-accent bg-brand-accent text-brand-ink'
                    : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
  );
}
