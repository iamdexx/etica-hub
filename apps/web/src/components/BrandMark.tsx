import { cn } from '@/lib/utils';

/**
 * Hub-and-spoke motif from the EticaHub mark, as a scalable SVG. The ring of
 * nodes can rotate slowly while the centre stays fixed, so it doubles as a
 * decorative backdrop behind heroes.
 */
export function BrandMark({
  className,
  animate = false,
  stroke = 'currentColor',
}: {
  className?: string;
  animate?: boolean;
  stroke?: string;
}) {
  const nodes = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return { x: 100 + 78 * Math.cos(a), y: 100 + 78 * Math.sin(a) };
  });

  return (
    <svg viewBox="0 0 200 200" aria-hidden="true" className={cn('text-brand-accent', className)}>
      <g
        className={cn(animate && 'animate-spin-slow')}
        style={{ transformOrigin: '100px 100px' }}
        fill="none"
        stroke={stroke}
      >
        <circle cx="100" cy="100" r="78" strokeWidth="3" opacity="0.7" />
        {nodes.map((n, i) => (
          <g key={i}>
            <line x1="100" y1="100" x2={n.x} y2={n.y} strokeWidth="3" opacity="0.55" />
            <circle cx={n.x} cy={n.y} r="11" fill="currentColor" stroke="none" opacity="0.95" />
          </g>
        ))}
      </g>
      <circle cx="100" cy="100" r="34" fill="#f4fbf6" stroke={stroke} strokeWidth="3" />
      <text
        x="100"
        y="113"
        textAnchor="middle"
        fontFamily="var(--font-geist-sans), system-ui, sans-serif"
        fontWeight="800"
        fontSize="40"
        fill="#0b3b27"
      >
        E
      </text>
    </svg>
  );
}
