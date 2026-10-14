import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type HeroTone =
  | 'emerald'
  | 'cyan'
  | 'indigo'
  | 'lime'
  | 'fuchsia'
  | 'amber'
  | 'sky'
  | 'neutral';

const GLOW: Record<HeroTone, string> = {
  emerald: 'rgba(85,194,138,0.28)',
  cyan: 'rgba(34,211,238,0.22)',
  indigo: 'rgba(129,140,248,0.22)',
  lime: 'rgba(163,230,53,0.2)',
  fuchsia: 'rgba(217,70,239,0.2)',
  amber: 'rgba(251,191,36,0.2)',
  sky: 'rgba(56,189,248,0.22)',
  neutral: 'rgba(255,255,255,0.12)',
};

const EYEBROW: Record<HeroTone, string> = {
  emerald: 'text-brand-glow/90 border-brand-accent/30 bg-brand-accent/10',
  cyan: 'text-cyan-200 border-cyan-400/30 bg-cyan-400/10',
  indigo: 'text-indigo-200 border-indigo-400/30 bg-indigo-400/10',
  lime: 'text-lime-200 border-lime-400/30 bg-lime-400/10',
  fuchsia: 'text-fuchsia-200 border-fuchsia-400/30 bg-fuchsia-400/10',
  amber: 'text-amber-200 border-amber-400/30 bg-amber-400/10',
  sky: 'text-sky-200 border-sky-400/30 bg-sky-400/10',
  neutral: 'text-white/70 border-white/15 bg-white/5',
};

const DOT: Record<HeroTone, string> = {
  emerald: 'bg-brand-glow',
  cyan: 'bg-cyan-300',
  indigo: 'bg-indigo-300',
  lime: 'bg-lime-300',
  fuchsia: 'bg-fuchsia-300',
  amber: 'bg-amber-300',
  sky: 'bg-sky-300',
  neutral: 'bg-white/70',
};

export function Eyebrow({
  tone = 'emerald',
  children,
  live = true,
  className,
}: {
  tone?: HeroTone;
  children: ReactNode;
  live?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-eyebrow',
        EYEBROW[tone],
        className,
      )}
    >
      {live ? (
        <span className={cn('relative inline-block h-1.5 w-1.5 rounded-full', DOT[tone])}>
          <span className={cn('absolute inset-0 animate-pulse-ring rounded-full', DOT[tone])} />
        </span>
      ) : null}
      {children}
    </span>
  );
}

/**
 * Shared page opener: eyebrow, display headline, lede, actions and an optional
 * aside (telemetry, chart, live card). The tone is a soft glow behind the
 * headline, not a coloured block, so every page shares one structure.
 */
export function PageHero({
  tone = 'emerald',
  eyebrow,
  title,
  description,
  actions,
  aside,
  children,
  size = 'lg',
  className,
}: {
  tone?: HeroTone;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  size?: 'lg' | 'md';
  className?: string;
}) {
  return (
    <section className={cn('relative', className)}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-24 -top-24 h-72 w-[34rem] rounded-full blur-3xl"
        style={{ background: `radial-gradient(closest-side, ${GLOW[tone]}, transparent)` }}
      />
      <div
        className={cn(
          'relative grid gap-8',
          aside ? 'lg:grid-cols-[1.05fr_0.95fr] lg:items-center' : '',
        )}
      >
        <div className="space-y-5" data-stagger>
          {eyebrow ? (
            <div>
              <Eyebrow tone={tone}>{eyebrow}</Eyebrow>
            </div>
          ) : null}
          <h1
            className={cn(
              'display max-w-3xl',
              size === 'lg'
                ? 'text-4xl sm:text-5xl md:text-6xl'
                : 'text-3xl sm:text-4xl md:text-5xl',
            )}
          >
            {title}
          </h1>
          {description ? <p className="lede max-w-2xl">{description}</p> : null}
          {children}
          {actions ? <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div> : null}
        </div>
        {aside ? <div className="animate-fade-up [animation-delay:200ms]">{aside}</div> : null}
      </div>
    </section>
  );
}

export function SectionTitle({
  eyebrow,
  title,
  action,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h2 className="mt-1 text-xl font-semibold tracking-tight text-white md:text-2xl">
          {title}
        </h2>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
