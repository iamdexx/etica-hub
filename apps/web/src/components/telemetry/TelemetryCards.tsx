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
  default: 'border-white/10 bg-white/[0.03]',
  emerald: 'border-emerald-400/20 bg-emerald-400/[0.06]',
  amber: 'border-amber-400/20 bg-amber-400/[0.06]',
  sky: 'border-sky-400/20 bg-sky-400/[0.06]',
  cyan: 'border-cyan-400/20 bg-cyan-400/[0.06]',
  indigo: 'border-indigo-400/20 bg-indigo-400/[0.06]',
  lime: 'border-lime-400/20 bg-lime-400/[0.06]',
  fuchsia: 'border-fuchsia-400/20 bg-fuchsia-400/[0.06]',
  rose: 'border-rose-400/20 bg-rose-400/[0.06]',
};

export interface TelemetryMetric {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
}

export function MetricCard({ label, value, detail, tone = 'default' }: TelemetryMetric) {
  return (
    <div className={cn('rounded-xl border p-3 transition-colors', toneClasses[tone])}>
      <div className="text-[10px] uppercase tracking-[0.16em] text-white/35">{label}</div>
      <div className="mt-1.5 text-sm font-semibold leading-5 text-white/90 sm:text-[15px]">
        {value}
      </div>
      {detail ? (
        <div className="mt-1 text-[11px] leading-4 text-white/45">{detail}</div>
      ) : null}
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
    <div className={cn('rounded-2xl border border-white/10 bg-black/25 p-4', className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-[0.18em] text-white/40">{title}</div>
        {badge ? <div>{badge}</div> : null}
      </div>

      <MetricGrid metrics={metrics} className="mt-3" />

      {description ? (
        <p className="mt-3 text-xs leading-5 text-white/45">{description}</p>
      ) : null}
    </div>
  );
}

export function SourceBadge({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <span
      className={cn(
        'rounded-full border px-2.5 py-1 text-[11px] tracking-wide text-white/75',
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
    <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[11px] font-medium text-white/55">
      Coming soon
    </span>
  );
}
