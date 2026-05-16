'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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

export function SiteHeader() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-[#020806]/88 backdrop-blur-md supports-[backdrop-filter]:bg-[#020806]/72">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-2 px-3 py-2.5 sm:px-4 md:gap-3 md:px-5 md:py-3">
        <Link href="/" className="flex min-w-0 items-center gap-3">
          <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full border border-cyan-300/20 bg-[#0a2940] shadow-[0_0_20px_rgba(103,232,249,0.12)]">
            <Image
              src="/etica-logo-circle.png"
              alt="EticaHub logo"
              fill
              sizes="40px"
              className="object-cover"
              priority
            />
          </div>

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
        </div>
      </div>

      <nav aria-label="Primary navigation" className="border-t border-white/10 lg:hidden">
        <div className="relative">
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-[#020806] to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-[#020806] to-transparent" />

          <div className="mx-auto flex w-full max-w-7xl gap-1 overflow-x-auto px-3 py-2 [scrollbar-width:none] [scroll-padding-inline:1rem] [&::-webkit-scrollbar]:hidden sm:px-4 md:px-5">
            {NAV.map((item) => {
              const active = isActive(item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'shrink-0 rounded-full border px-2.5 py-1 text-xs leading-5 transition-colors',
                    active
                      ? 'border-brand-accent/70 bg-brand-accent text-brand-ink shadow-none'
                      : 'border-white/10 bg-white/[0.035] text-white/62 hover:border-white/20 hover:bg-white/8 hover:text-white',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      </nav>
    </header>
  );
}
