'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { nextUpFor } from '@/lib/nav';

export function NextUp() {
  const pathname = usePathname();
  const links = nextUpFor(pathname);
  if (!links.length) return null;

  return (
    <section
      aria-label="Continue to"
      className="mx-auto mt-16 w-full max-w-7xl px-4 sm:px-5 md:px-6 lg:px-8"
    >
      <div className="hairline mb-6" />
      <div className="flex items-baseline justify-between gap-4">
        <div className="eyebrow">Continue</div>
        <Link href="/" className="text-xs text-white/40 transition-colors hover:text-white/80">
          All modules →
        </Link>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3" data-stagger>
        {links.map((l, i) => (
          <Link
            key={l.href}
            href={l.href}
            className="surface surface-hover group flex items-center justify-between gap-4 px-5 py-4"
          >
            <div className="min-w-0">
              <div className="text-[11px] font-mono text-white/35">0{i + 1}</div>
              <div className="mt-1 text-base font-semibold text-white">{l.label}</div>
              <div className="mt-0.5 truncate text-xs text-white/50">{l.desc}</div>
            </div>
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/[0.07] text-white/60 transition-all group-hover:border-brand-accent/50 group-hover:bg-brand-accent/10 group-hover:text-brand-glow">
              →
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
