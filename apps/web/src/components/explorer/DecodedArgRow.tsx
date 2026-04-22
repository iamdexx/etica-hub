import Link from 'next/link';
import { formatUnits, isAddress, type Address } from 'viem';
import { addressLabel, shortAddress, shortHash } from '@/lib/explorer';
import { isTokenAmountArg, tokenMeta, type DecodedArg } from '@/lib/explorerAbi';

interface DecodedArgRowProps {
  arg: DecodedArg;
  /**
   * The calldata recipient (for `decodeCall`) or log emitter (for
   * `decodeLog`). When the contract is a known ERC-20 we annotate uint256
   * "amount"-ish args with "(1.5 ETX)" alongside the raw bigint.
   */
  contractAddress?: Address | string | null;
}

/**
 * Renders a single decoded arg inside a dl-style grid:
 *
 *   | type · name | value |
 *
 * Arrays are rendered one per line. Values get light context-aware
 * formatting:
 *   - addresses become links to /explorer/address/...
 *   - bigints get a decimal-formatted hint for known tokens
 *   - bytes-type args are shortened
 *
 * Everything else falls through to `String(value)`. Keep this a server
 * component so it doesn't ship any JS to the client.
 */
export function DecodedArgRow({ arg, contractAddress }: DecodedArgRowProps) {
  return (
    <div className="grid gap-1 border-b border-white/5 py-2 last:border-b-0 md:grid-cols-[180px_1fr] md:gap-4">
      <div className="text-xs text-white/45">
        <span className="font-mono text-white/60">{arg.name}</span>
        <span className="ml-2 text-white/30">{arg.type}</span>
      </div>
      <div className="break-all font-mono text-xs text-white/80">
        {renderValue(arg, contractAddress)}
      </div>
    </div>
  );
}

function renderValue(arg: DecodedArg, contractAddress?: Address | string | null) {
  const v = arg.value;
  if (arg.type.endsWith('[]') && Array.isArray(v)) {
    const baseType = arg.type.slice(0, -2);
    return (
      <ul className="space-y-1">
        {v.map((item, i) => (
          <li key={i}>
            {renderScalar(item, baseType, arg.name, contractAddress)}
          </li>
        ))}
      </ul>
    );
  }
  return renderScalar(v, arg.type, arg.name, contractAddress);
}

function renderScalar(
  value: unknown,
  type: string,
  argName: string,
  contractAddress?: Address | string | null,
): React.ReactNode {
  if (value == null) return <span className="text-white/40">null</span>;

  if (type === 'address' && typeof value === 'string' && isAddress(value, { strict: false })) {
    const label = addressLabel(value);
    return (
      <Link href={`/explorer/address/${value}`} className="text-brand-accent hover:underline">
        {label ? `${label} · ${shortAddress(value, 4)}` : value}
      </Link>
    );
  }

  if (type === 'bool') {
    return <span>{value ? 'true' : 'false'}</span>;
  }

  if (type.startsWith('bytes') && typeof value === 'string') {
    return <span>{shortHash(value, 10)}</span>;
  }

  if (typeof value === 'bigint') {
    const raw = value.toString();
    if (isTokenAmountArg({ name: argName, type, value })) {
      const meta = tokenMeta(contractAddress ?? null);
      if (meta) {
        return (
          <span>
            <span>{raw}</span>
            <span className="ml-2 text-white/50">
              ({formatTokenHuman(value, meta.decimals)} {meta.symbol})
            </span>
          </span>
        );
      }
    }
    return <span>{raw}</span>;
  }

  if (typeof value === 'string') return <span>{value}</span>;

  // Tuples / structs — viem returns them as arrays or objects. Best-effort
  // readable rendering; the raw-hex section below the decoded view is the
  // authoritative source of truth if this ever looks wrong.
  try {
    return (
      <span>
        {JSON.stringify(value, (_k, val) =>
          typeof val === 'bigint' ? val.toString() : val,
        )}
      </span>
    );
  } catch {
    return <span className="text-white/40">{String(value)}</span>;
  }
}

function formatTokenHuman(wei: bigint, decimals: number): string {
  const full = formatUnits(wei, decimals);
  const [int, frac = ''] = full.split('.');
  const shortFrac = frac.slice(0, 6).replace(/0+$/, '');
  return shortFrac ? `${int}.${shortFrac}` : int;
}
