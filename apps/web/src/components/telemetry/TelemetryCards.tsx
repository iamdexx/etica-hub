import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Tone =
  | 'default'
  | 'emerald'
  | 'amber'
  | 'sky'
  | 'cyan'
  | 'indigo'
  | 'lime'
  | 'fuchsia'
  | 'rose';

const toneClasses: Record<Tone, string> = {
  default: 'border-white/[0.07] bg-white/[0.025] text-white/70',
  emerald: 'border-brand-accent/25 bg-brand-accent/[0.08] text-brand-glow',
  amber: 'border-amber-400/25 bg-amber-400/[0.08] text-amber-200',
  sky: 'border-sky-400/25 bg-sky-400/[0.08] text-sky-200',
  cyan: 'border-cyan-400/25 bg-cyan-400/[0.08] text-cyan-200',
  indigo: 'border-indigo-400/25 bg-indigo-400/[0.08] text-indigo-200',
  lime: 'border-lime-400/25 bg-lime-400/[0.08] text-lime-200',
  fuchsia: 'border-fuchsia-400/25 bg-fuchsia-400/[0.08] text-fuchsia-200',
  rose: 'border-rose-400/25 bg-rose-400/[0.08] text-rose-200',
};

const accentBar: Record<Tone, string> = {
  default: 'bg-white/15',
  emerald: 'bg-brand-glow',
  amber: 'bg-amber-300',
  sky: 'bg-sky-300',
  cyan: 'bg-cyan-300',
  indigo: 'bg-indigo-300',
  lime: 'bg-lime-300',
  fuchsia: 'bg-fuchsia-300',
  rose: 'bg-rose-300',
};

export interface TelemetryMetric {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
}

export function MetricCard({ label, value, detail, tone = 'default' }: TelemetryMetric) {
  return (
    <div className="surface-2 relative overflow-hidden p-3.5 pl-4">
      <span className={cn('absolute inset-y-3 left-0 w-px rounded-full', accentBar[tone])} />
      <div className="text-[10px] uppercase tracking-eyebrow text-white/40">{label}</div>
      <div className="num mt-1.5 text-[15px] font-semibold leading-5 text-white sm:text-base">
        {value}
      </div>
      {detail ? <div className="mt-1 text-[11px] leading-4 text-white/45">{detail}</div> : null}
    </div>
  );
}

export function MetricGrid({
  metrics,
  className,
}: {
  metrics: TelemetryMetric[];
  className?: string;
}) {
  return (
    <div className={cn('grid grid-cols-2 gap-2 lg:grid-cols-2 xl:grid-cols-4', className)}>
      {metrics.map((metric) => (
        <MetricCard key={metric.label} {...metric} />
      ))}
    </div>
  );
}

export function TelemetrySection({
  title,
  badge,
  description,
  metrics,
  className,
}: {
  title: string;
  badge?: ReactNode;
  description?: ReactNode;
  metrics: TelemetryMetric[];
  className?: string;
}) {
  return (
    <div className={cn('surface p-4 md:p-5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="text-[11px] uppercase tracking-eyebrow text-white/45">{title}</div>
        {badge ? <div className="shrink-0">{badge}</div> : null}
      </div>
      <MetricGrid metrics={metrics} className="mt-3" />
      {description ? <p className="mt-3 text-xs leading-5 text-white/45">{description}</p> : null}
    </div>
  );
}

export function SourceBadge({ children, tone = 'default' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-block whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] tracking-wide',
        toneClasses[tone],
      )}
    >
      {children}
    </span>
  );
}

export function UnavailableMetric({
  reason = 'backend analytics coming soon',
}: {
  reason?: string;
}) {
  return (
    <span title={reason} className="chip text-white/55">
      Coming soon
    </span>
  );
}
