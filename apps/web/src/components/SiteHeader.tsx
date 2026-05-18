'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ConnectButton } from './ConnectButton';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/labs', label: 'Labs' },
  { href: '/swap', label: 'Swap' },
  { href: '/trade', label: 'Trade' },
  { href: '/pool', label: 'Pool' },
  { href: '/stake', label: 'Stake' },
  { href: '/farms', label: 'Farms' },
  { href: '/research', label: 'Research' },
  { href: '/bridge', label: 'Bridge' },
  { href: '/explorer', label: 'Explorer' },
  { href: '/whitepaper', label: 'Whitepaper' },
  { href: '/status', label: 'Status' },
];

const TELEGRAM_URL = 'https://t.me/EticaHubPortal';

function TelegramLink() {
  return (
    <a
      href={TELEGRAM_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Join EticaHub on Telegram"
      title="EticaHub on Telegram"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/75 transition-colors hover:border-[#229ED9]/50 hover:bg-[#229ED9]/10 hover:text-[#7cc4e8]"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="h-4 w-4"
        fill="currentColor"
      >
        <path d="M20.665 3.717 2.953 10.55c-1.21.486-1.203 1.161-.222 1.462l4.545 1.418 10.517-6.63c.497-.303.95-.14.577.19l-8.52 7.693h-.002l.002.003-.314 4.693c.46 0 .663-.211.922-.46l2.22-2.16 4.592 3.39c.848.467 1.457.227 1.668-.787l3.018-14.207c.31-1.244-.473-1.808-1.285-1.438Z" />
      </svg>
    </a>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {open ? (
        <>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="6" y1="18" x2="18" y2="6" />
        </>
      ) : (
        <>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </>
      )}
    </svg>
  );
}

export function SiteHeader() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close drawer on route change
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Lock body scroll while drawer is open
  useEffect(() => {
    if (drawerOpen) {
      const previous = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = previous;
      };
    }
  }, [drawerOpen]);

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-[#020806]/88 backdrop-blur-md supports-[backdrop-filter]:bg-[#020806]/72">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-2 px-3 py-2.5 sm:px-4 md:gap-3 md:px-5 md:py-3">
        <Link href="/" className="flex min-w-0 items-center gap-2">
          <span className="inline-block h-5 w-5 shrink-0 rounded-full bg-brand-accent" />
          <span className="truncate text-base font-semibold tracking-tight sm:text-lg">EticaHub</span>
          <span className="hidden rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-emerald-300 sm:inline">
            live · mainnet
          </span>
        </Link>

        <nav className="hidden items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.035] px-1 py-1 lg:flex">
          {NAV.map((item) => {
            const active = isActive(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'rounded-full px-2 py-1.5 text-[13px] transition-colors',
                  active
                    ? 'bg-brand-accent text-brand-ink'
                    : 'text-white/65 hover:bg-white/5 hover:text-white',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <TelegramLink />
          <ConnectButton />
          <button
            type="button"
            aria-label={drawerOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((v) => !v)}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/80 transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white lg:hidden"
          >
            <MenuIcon open={drawerOpen} />
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 top-[57px] z-40 lg:hidden" aria-modal="true" role="dialog">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 cursor-default bg-black/50 backdrop-blur-sm"
          />
          <nav
            aria-label="Primary navigation"
            className="relative max-h-[calc(100vh-57px)] overflow-y-auto border-b border-white/10 bg-[#020806]/95 px-3 py-3 shadow-2xl sm:px-4"
          >
            <div className="mx-auto grid w-full max-w-7xl gap-1">
              {NAV.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'flex items-center rounded-xl border px-4 py-3 text-sm font-medium transition-colors',
                      active
                        ? 'border-brand-accent/60 bg-brand-accent/15 text-brand-accent'
                        : 'border-white/10 bg-white/[0.03] text-white/80 hover:border-white/20 hover:bg-white/8 hover:text-white',
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
