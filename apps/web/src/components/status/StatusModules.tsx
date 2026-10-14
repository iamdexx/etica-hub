import Link from 'next/link';
import type { ReactNode } from 'react';
import { BRIDGE_ROLES, USDC_WARP_ROUTE } from '@etica-hub/shared';
import {
  fmtAge,
  fmtAmount,
  loadAutomation,
  loadBridge,
  loadChain,
  loadDex,
  loadIndexer,
  loadLabs,
  loadStaking,
  type ModuleState,
} from '@/lib/status/modules';

const STATE_PILL: Record<ModuleState, string> = {
  ok: 'bg-emerald-400/15 text-emerald-200',
  warn: 'bg-amber-400/15 text-amber-200',
  down: 'bg-rose-500/15 text-rose-200',
  na: 'bg-white/10 text-white/50',
};
const STATE_LABEL: Record<ModuleState, string> = {
  ok: 'operational',
  warn: 'degraded',
  down: 'down',
  na: 'unavailable',
};

type Row = readonly [label: string, value: ReactNode, hint?: string];

export function ModuleCard({
  title,
  href,
  hrefLabel = 'Open',
  state,
  note,
  rows,
  children,
}: {
  title: string;
  href: string;
  hrefLabel?: string;
  state: ModuleState;
  note?: ReactNode;
  rows?: Row[];
  children?: ReactNode;
}) {
  return (
    <section className="surface flex h-full flex-col p-4">
      <header className="flex items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-eyebrow text-white/45">{title}</div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] ${STATE_PILL[state]}`}>
          {STATE_LABEL[state]}
        </span>
      </header>
      {rows ? (
        <dl className="mt-3 divide-y divide-white/[0.05]">
          {rows.map(([label, value, hint]) => (
            <div key={label} className="flex items-baseline justify-between gap-3 py-1.5">
              <dt className="text-xs text-white/55">
                {label}
                {hint ? <span className="ml-1 text-white/30">· {hint}</span> : null}
              </dt>
              <dd className="font-mono text-xs tabular-nums text-white/90 text-right">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
      <footer className="mt-auto flex items-center justify-between gap-3 pt-3 text-[11px]">
        <span className="text-white/40">{note}</span>
        <Link href={href} className="whitespace-nowrap text-brand-glow/80 hover:text-brand-glow">
          {hrefLabel} →
        </Link>
      </footer>
    </section>
  );
}

export function ModuleSkeleton({ title }: { title: string }) {
  return (
    <div className="surface animate-pulse p-4">
      <div className="text-[11px] uppercase tracking-eyebrow text-white/45">{title}</div>
      <div className="mt-4 space-y-3">
        <div className="h-3 w-full rounded bg-white/[0.05]" />
        <div className="h-3 w-5/6 rounded bg-white/[0.05]" />
        <div className="h-3 w-2/3 rounded bg-white/[0.05]" />
      </div>
    </div>
  );
}

function ErrorCard({ title, href, error }: { title: string; href: string; error: unknown }) {
  return (
    <ModuleCard title={title} href={href} state="na" note="Live read failed">
      <p className="mt-3 break-anywhere text-xs text-rose-300">
        {error instanceof Error ? error.message : String(error)}
      </p>
    </ModuleCard>
  );
}

/* ------------------------------------------------------------------ */

export async function ChainModule() {
  try {
    const h = await loadChain();
    return (
      <ModuleCard
        title="Etica chain · RPC"
        href="/explorer"
        hrefLabel="Explorer"
        state={h.ok ? 'ok' : h.headBlockNumber ? 'warn' : 'down'}
        note={h.errors[0] ?? `Stale after ${h.staleThresholdSeconds}s`}
        rows={[
          [
            'Head block',
            h.headBlockNumber ? `#${Number(h.headBlockNumber).toLocaleString()}` : '—',
          ],
          ['Head age', h.headAgeSeconds != null ? `${h.headAgeSeconds}s` : '—'],
          ['RPC latency', `${h.responseTimeMs} ms`],
          ['Chain id', String(h.chainId)],
          ['Swap pairs', h.pairCount != null ? String(h.pairCount) : '—'],
        ]}
      />
    );
  } catch (err) {
    return <ErrorCard title="Etica chain · RPC" href="/explorer" error={err} />;
  }
}

export async function DexModule() {
  try {
    const d = await loadDex();
    return (
      <ModuleCard
        title="EticaSwap"
        href="/pools"
        hrefLabel="Pools"
        state={d.usdcePool ? 'ok' : 'warn'}
        note="Hub-and-spoke AMM, ETX on one side"
        rows={[
          ['Pairs', d.pairCount.toString()],
          [
            'USDC.e / ETX',
            d.usdcePool
              ? `${fmtAmount(d.usdcePool.usdce, 6)} USDC.e · ${fmtAmount(d.usdcePool.etx, 18, 0)} ETX`
              : 'not found',
            'USD anchor',
          ],
          [
            'stETX / ETX stableswap',
            d.stableswap
              ? `${fmtAmount(d.stableswap.stEtx, 18, 0)} stETX · ${fmtAmount(d.stableswap.etx, 18, 0)} ETX`
              : '—',
          ],
        ]}
      />
    );
  } catch (err) {
    return <ErrorCard title="EticaSwap" href="/pools" error={err} />;
  }
}

export async function StakingModule() {
  try {
    const s = await loadStaking();
    return (
      <ModuleCard
        title="Staking · Farms"
        href="/stake"
        hrefLabel="Stake"
        state="ok"
        note="stETX is an ERC-4626 vault; rate only rises"
        rows={[
          ['ETX staked', `${fmtAmount(s.totalAssets, 18, 0)} ETX`],
          ['stETX supply', `${fmtAmount(s.totalShares, 18, 0)} stETX`],
          ['Exchange rate', `${fmtAmount(s.rate, 18, 4)} ETX / stETX`],
          ['Farm pools', s.farmPools != null ? s.farmPools.toString() : '—'],
          ['Alloc points', s.farmAllocPoint != null ? s.farmAllocPoint.toString() : '—'],
        ]}
      />
    );
  } catch (err) {
    return <ErrorCard title="Staking · Farms" href="/stake" error={err} />;
  }
}

const EGAZ_FLOOR = 2n * 10n ** 18n;
const ETH_FLOOR = 5n * 10n ** 15n;

export async function BridgeModule() {
  try {
    const b = await loadBridge();
    if (!b.live) {
      return (
        <ModuleCard title="USDC bridge" href="/bridge" state="na" note="Warp route not deployed" />
      );
    }
    const backed =
      b.usdcLocked != null && b.usdceSupply != null ? b.usdcLocked >= b.usdceSupply : null;
    const agentsFunded =
      b.keeperEgaz >= EGAZ_FLOOR &&
      b.relayerEgaz >= EGAZ_FLOOR &&
      (b.relayerEth == null || b.relayerEth >= ETH_FLOOR);
    const state: ModuleState =
      backed === false ? 'down' : !agentsFunded ? 'warn' : backed == null ? 'warn' : 'ok';
    return (
      <ModuleCard
        title="USDC bridge · Hyperlane"
        href="/bridge"
        hrefLabel="Bridge"
        state={state}
        note={
          b.ethereumError
            ? `Ethereum read failed: ${b.ethereumError}`
            : backed
              ? 'Fully collateralised'
              : 'Collateral unknown'
        }
        rows={[
          [
            'USDC locked',
            b.usdcLocked != null ? `${fmtAmount(b.usdcLocked, 6)} USDC` : '—',
            'Ethereum',
          ],
          [
            'USDC.e supply',
            b.usdceSupply != null
              ? `${fmtAmount(b.usdceSupply, 6)} ${USDC_WARP_ROUTE.symbol}`
              : '—',
            'Etica',
          ],
          ['Keeper EGAZ', `${fmtAmount(b.keeperEgaz, 18, 2)}`, 'fees → gas'],
          ['Relayer EGAZ', `${fmtAmount(b.relayerEgaz, 18, 2)}`],
          ['Relayer ETH', b.relayerEth != null ? fmtAmount(b.relayerEth, 18, 4) : '—'],
          ['Validator EGAZ', `${fmtAmount(b.validatorEgaz, 18, 2)}`, '1-of-1'],
        ]}
      />
    );
  } catch (err) {
    return <ErrorCard title="USDC bridge · Hyperlane" href="/bridge" error={err} />;
  }
}

export async function LabsModule() {
  try {
    const l = await loadLabs();
    const ageMs = l.stats.lastCompletedAt ? Date.now() - l.stats.lastCompletedAt : null;
    const state: ModuleState = ageMs == null ? 'warn' : ageMs > 24 * 3600_000 ? 'warn' : 'ok';
    return (
      <ModuleCard
        title="EticaLabs"
        href="/labs/archive"
        hrefLabel="Archive"
        state={state}
        note="Autopilot runs every 5 min via GitHub Actions"
        rows={[
          ['Last discovery', fmtAge(ageMs)],
          ['Queue pending', l.pending != null ? String(l.pending) : '—'],
          ['Archived research', l.stats.totalResearch.toLocaleString()],
          [
            'Proteins · folds',
            `${l.stats.totalProteins.toLocaleString()} · ${l.stats.totalFolds.toLocaleString()}`,
          ],
          [
            'Diseases · minted',
            `${l.stats.totalDiseases.toLocaleString()} · ${l.stats.totalMinted.toLocaleString()}`,
          ],
        ]}
      />
    );
  } catch (err) {
    return <ErrorCard title="EticaLabs" href="/labs/archive" error={err} />;
  }
}

export async function IndexerModule() {
  try {
    const i = await loadIndexer();
    if (!i.cursor) {
      return (
        <ModuleCard
          title="Explorer indexer"
          href="/explorer"
          state="na"
          note="cursor.json unreachable"
        />
      );
    }
    const ageMs = Date.now() - Date.parse(i.cursor.updatedAt);
    const lag = i.headBlock != null ? Number(i.headBlock) - i.cursor.lastBlock : null;
    const state: ModuleState = ageMs > 45 * 60_000 ? 'warn' : 'ok';
    return (
      <ModuleCard
        title="Explorer indexer"
        href="/explorer"
        hrefLabel="Explorer"
        state={state}
        note="Transfers + syncs pushed to the data-index branch every 10 min"
        rows={[
          ['Last run', fmtAge(ageMs)],
          ['Indexed block', `#${i.cursor.lastBlock.toLocaleString()}`],
          ['Blocks behind head', lag != null ? lag.toLocaleString() : '—'],
          ['Runs', i.cursor.runs.toLocaleString()],
          [
            'Transfers · syncs',
            `${i.cursor.cumulative.transfers.toLocaleString()} · ${i.cursor.cumulative.syncs.toLocaleString()}`,
          ],
        ]}
      />
    );
  } catch (err) {
    return <ErrorCard title="Explorer indexer" href="/explorer" error={err} />;
  }
}

export async function AutomationModule() {
  const runs = await loadAutomation();
  const failed = runs.filter(
    (r) => r.conclusion && r.conclusion !== 'success' && r.conclusion !== 'skipped',
  );
  const unknown = runs.filter((r) => r.error);
  const state: ModuleState =
    unknown.length === runs.length ? 'na' : failed.length > 0 ? 'warn' : 'ok';
  return (
    <ModuleCard
      title="Automation · GitHub Actions"
      href="https://github.com/iamdexx/etica-hub/actions"
      hrefLabel="Actions"
      state={state}
      note={
        unknown[0]?.error ? `GitHub API: ${unknown[0].error}` : 'Last run per cron, cached 15 min'
      }
    >
      <ul className="mt-3 divide-y divide-white/[0.05]">
        {runs.map((r) => {
          const ok = r.conclusion === 'success';
          const running = r.status === 'in_progress' || r.status === 'queued';
          const dot = r.error
            ? 'bg-white/20'
            : running
              ? 'bg-sky-300'
              : ok
                ? 'bg-brand-glow'
                : 'bg-rose-300';
          return (
            <li key={r.label} className="flex items-center justify-between gap-3 py-1.5 text-xs">
              <span className="flex items-center gap-2 text-white/70">
                <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                {r.label}
                <span className="text-white/30">· {r.every}</span>
              </span>
              <span className="font-mono tabular-nums text-white/60">
                {r.error
                  ? '—'
                  : running
                    ? 'running'
                    : fmtAge(r.updatedAt ? Date.now() - Date.parse(r.updatedAt) : null)}
              </span>
            </li>
          );
        })}
      </ul>
    </ModuleCard>
  );
}

export function RolesNote() {
  return (
    <p className="text-[11px] text-white/35">
      Bridge roles: owner {BRIDGE_ROLES.owner.slice(0, 8)}… · keeper{' '}
      {BRIDGE_ROLES.keeper.slice(0, 8)}… · guardian {BRIDGE_ROLES.guardian.slice(0, 8)}…
    </p>
  );
}
