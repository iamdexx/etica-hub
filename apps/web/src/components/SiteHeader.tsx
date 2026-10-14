'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ConnectButton } from './ConnectButton';
import { NAV_GROUPS, TELEGRAM_URL, type NavGroup } from '@/lib/nav';
import { cn } from '@/lib/utils';

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M20.665 3.717 2.953 10.55c-1.21.486-1.203 1.161-.222 1.462l4.545 1.418 10.517-6.63c.497-.303.95-.14.577.19l-8.52 7.693h-.002l.002.003-.314 4.693c.46 0 .663-.211.922-.46l2.22-2.16 4.592 3.39c.848.467 1.457.227 1.668-.787l3.018-14.207c.31-1.244-.473-1.808-1.285-1.438Z" />
    </svg>
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
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      {open ? (
        <>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="6" y1="18" x2="18" y2="6" />
        </>
      ) : (
        <>
          <line x1="4" y1="8" x2="20" y2="8" />
          <line x1="4" y1="16" x2="20" y2="16" />
        </>
      )}
    </svg>
  );
}

function groupActive(group: NavGroup, pathname: string) {
  return group.links.some((l) => pathname === l.href || pathname.startsWith(l.href + '/'));
}

function DesktopGroup({ group, pathname }: { group: NavGroup; pathname: string }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = groupActive(group, pathname);

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(true);
  };
  const hide = () => {
    timer.current = setTimeout(() => setOpen(false), 120);
  };

  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'relative rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors',
          active ? 'text-white' : 'text-white/60 hover:text-white',
        )}
      >
        {group.label}
        <span
          className={cn(
            'absolute inset-x-3.5 -bottom-[7px] h-px rounded-full bg-brand-glow transition-opacity',
            active ? 'opacity-100' : 'opacity-0',
          )}
        />
      </button>
      {open ? (
        <div role="menu" className="absolute left-1/2 top-full z-50 w-72 -translate-x-1/2 pt-3">
          <div className="surface animate-menu-in p-1.5">
            {group.links.map((l) => {
              const isActive = pathname === l.href || pathname.startsWith(l.href + '/');
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className={cn(
                    'flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-white/[0.06]',
                    isActive && 'bg-brand-accent/10',
                  )}
                >
                  <span
                    className={cn(
                      'mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full',
                      isActive ? 'bg-brand-glow' : 'bg-white/20',
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-white">{l.label}</span>
                    <span className="block truncate text-xs text-white/50">{l.desc}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SiteHeader() {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => setDrawerOpen(false), [pathname]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  return (
    <header
      className={cn(
        'sticky top-0 z-40 border-b transition-[background-color,border-color] duration-300',
        scrolled || drawerOpen
          ? 'border-white/[0.08] bg-ink-900/85 backdrop-blur-xl'
          : 'border-transparent bg-transparent',
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-5 md:px-6 lg:px-8">
        <Link
          href="/"
          className="group flex min-w-0 items-center gap-2.5"
          aria-label="EticaHub home"
        >
          <span className="relative grid h-9 w-9 shrink-0 place-items-center">
            <span className="absolute inset-0 rounded-full bg-brand-accent/20 blur-md transition-opacity group-hover:opacity-100 opacity-60" />
            <Image
              src="/brand/eticahub-mark-192.png"
              alt=""
              width={36}
              height={36}
              priority
              className="relative h-9 w-9 transition-transform duration-500 group-hover:rotate-[60deg]"
            />
          </span>
          <span className="truncate text-[17px] font-semibold tracking-tight text-white">
            EticaHub
          </span>
          <span className="chip-live hidden sm:inline-flex">
            <span className="live-dot" />
            Mainnet
          </span>
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-1 lg:flex">
          {NAV_GROUPS.map((g) => (
            <DesktopGroup key={g.label} group={g} pathname={pathname} />
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <a
            href={TELEGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="EticaHub on Telegram"
            className="hidden h-9 w-9 place-items-center rounded-full border border-white/[0.07] bg-white/[0.04] text-white/70 transition-colors hover:border-[#229ED9]/50 hover:bg-[#229ED9]/10 hover:text-[#7cc4e8] sm:grid"
          >
            <TelegramIcon className="h-4 w-4" />
          </a>
          <ConnectButton />
          <button
            type="button"
            aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((v) => !v)}
            className="grid h-9 w-9 place-items-center rounded-full border border-white/[0.07] bg-white/[0.04] text-white/80 transition-colors hover:border-white/25 hover:text-white lg:hidden"
          >
            <MenuIcon open={drawerOpen} />
          </button>
        </div>
      </div>

      {drawerOpen ? (
        <div
          className="fixed inset-x-0 bottom-0 top-16 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm"
          />
          <nav
            aria-label="Primary"
            className="animate-sheet-in relative max-h-full overflow-y-auto border-b border-white/[0.08] bg-ink-900/95 px-4 pb-6 pt-3 shadow-2xl backdrop-blur-xl sm:px-5"
          >
            <div className="mx-auto grid w-full max-w-7xl gap-5 sm:grid-cols-2">
              {NAV_GROUPS.map((g) => (
                <div key={g.label}>
                  <div className="eyebrow px-1 pb-2">{g.label}</div>
                  <div className="grid gap-1">
                    {g.links.map((l) => {
                      const isActive = pathname === l.href || pathname.startsWith(l.href + '/');
                      return (
                        <Link
                          key={l.href}
                          href={l.href}
                          onClick={() => setDrawerOpen(false)}
                          className={cn(
                            'flex items-center justify-between rounded-xl px-3 py-3 transition-colors',
                            isActive
                              ? 'bg-brand-accent/10 text-white'
                              : 'text-white/80 hover:bg-white/[0.05] hover:text-white',
                          )}
                        >
                          <span>
                            <span className="block text-[15px] font-medium">{l.label}</span>
                            <span className="block text-xs text-white/45">{l.desc}</span>
                          </span>
                          <span className={cn('text-white/30', isActive && 'text-brand-glow')}>
                            →
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="mx-auto mt-5 flex w-full max-w-7xl items-center gap-2">
              <a
                href={TELEGRAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-ghost flex-1"
              >
                <TelegramIcon className="h-4 w-4" /> Telegram
              </a>
              <Link href="/status" onClick={() => setDrawerOpen(false)} className="btn-tone flex-1">
                <span className="live-dot" /> Status
              </Link>
            </div>
          </nav>
        </div>
      ) : null}
    </header>
  );
}
