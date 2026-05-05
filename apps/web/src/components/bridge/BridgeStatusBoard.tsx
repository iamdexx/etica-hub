'use client';

import { useEffect, useState } from 'react';
import { createPublicClient, formatUnits, http, type Address } from 'viem';
import {
  abis,
  BRIDGE_ETICA_DEPLOYMENT,
  BRIDGE_REMOTE_DEPLOYMENTS,
  eticaMainnet,
  isBridgeLive,
  isBridgeRemoteLive,
  type BridgeRemoteDomain,
} from '@etica-hub/shared';

const ZERO = '0x0000000000000000000000000000000000000000';

interface EticaStats {
  locked: bigint;
  cap: bigint;
  paused: boolean;
  insuranceTotal: bigint;
}

interface RemoteStats {
  minted: bigint;
  cap: bigint;
  paused: boolean;
  lastHeartbeatAt: bigint;
  heartbeatTimeoutSeconds: bigint;
}

const REMOTE_RPC: Record<BridgeRemoteDomain, string> = {
  1: 'https://cloudflare-eth.com',
  56: 'https://bsc-dataseed.binance.org',
};

function fmtEtx(amount: bigint): string {
  if (amount === 0n) return '0';
  return Number(formatUnits(amount, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function pct(num: bigint, den: bigint): string {
  if (den === 0n) return '—';
  const n = Number((num * 10000n) / den) / 100;
  return `${n.toFixed(1)}%`;
}

export function BridgeStatusBoard() {
  const [etica, setEtica] = useState<EticaStats | null>(null);
  const [remotes, setRemotes] = useState<Partial<Record<BridgeRemoteDomain, RemoteStats>>>({});
  const live = isBridgeLive();

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const eticaClient = createPublicClient({ chain: eticaMainnet, transport: http() });
    const vault = BRIDGE_ETICA_DEPLOYMENT.bridgeVault;
    const insurance = BRIDGE_ETICA_DEPLOYMENT.bridgeInsuranceFund;

    void (async () => {
      try {
        const [locked, cap, paused, insuranceTotal] = await Promise.all([
          eticaClient.readContract({ address: vault, abi: abis.bridgeVaultAbi, functionName: 'locked' }),
          eticaClient.readContract({ address: vault, abi: abis.bridgeVaultAbi, functionName: 'tvlCap' }),
          eticaClient.readContract({ address: vault, abi: abis.bridgeVaultAbi, functionName: 'paused' }),
          insurance !== ZERO
            ? eticaClient.readContract({
                address: insurance,
                abi: abis.bridgeInsuranceFundAbi,
                functionName: 'totalAssets',
              })
            : Promise.resolve(0n),
        ]);
        if (!cancelled) setEtica({ locked, cap, paused, insuranceTotal });
      } catch {
        // Reads silently fail on chains that aren't reachable — UI falls back to "unknown".
      }
    })();

    for (const domainStr of Object.keys(BRIDGE_REMOTE_DEPLOYMENTS)) {
      const domain = Number(domainStr) as BridgeRemoteDomain;
      if (!isBridgeRemoteLive(domain)) continue;
      const minter = BRIDGE_REMOTE_DEPLOYMENTS[domain].bridgeMinter as Address;
      const remoteClient = createPublicClient({ transport: http(REMOTE_RPC[domain]) });
      void (async () => {
        try {
          const [minted, cap, paused, lastHeartbeatAt, heartbeatTimeout] = await Promise.all([
            remoteClient.readContract({ address: minter, abi: abis.bridgeMinterAbi, functionName: 'minted' }),
            remoteClient.readContract({ address: minter, abi: abis.bridgeMinterAbi, functionName: 'tvlCap' }),
            remoteClient.readContract({ address: minter, abi: abis.bridgeMinterAbi, functionName: 'paused' }),
            remoteClient.readContract({
              address: minter,
              abi: abis.bridgeMinterAbi,
              functionName: 'lastHeartbeatAt',
            }),
            remoteClient.readContract({
              address: minter,
              abi: abis.bridgeMinterAbi,
              functionName: 'heartbeatTimeout',
            }),
          ]);
          if (!cancelled) {
            setRemotes((prev) => ({
              ...prev,
              [domain]: {
                minted,
                cap,
                paused,
                lastHeartbeatAt: BigInt(lastHeartbeatAt),
                heartbeatTimeoutSeconds: BigInt(heartbeatTimeout),
              },
            }));
          }
        } catch {
          // Remote chain unreachable — leave as undefined and UI shows "unknown".
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [live]);

  if (!live) {
    return (
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm text-amber-200/80">
        <div className="text-base font-semibold text-amber-100">Bridge launches with mainnet deploy</div>
        <p className="mt-1 text-amber-200/70">
          Contracts are written, audited internally, and ready to ship. The deploy walkthrough lives at{' '}
          <code className="font-mono text-amber-100">docs/BRIDGE_DEPLOY_WALKTHROUGH.md</code>. Once
          addresses are wired into <code className="font-mono text-amber-100">packages/shared</code>, this
          page lights up with live TVL, pending claims, and deposit / claim / burn flows.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="text-xs uppercase tracking-widest text-white/40">Etica side</div>
        <div className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Locked" value={etica ? `${fmtEtx(etica.locked)} ETX` : '…'} />
          <Stat label="TVL cap" value={etica ? `${fmtEtx(etica.cap)} ETX` : '…'} />
          <Stat label="Utilisation" value={etica ? pct(etica.locked, etica.cap) : '…'} />
          <Stat
            label="Status"
            value={etica ? (etica.paused ? 'Paused' : 'Open') : '…'}
            tone={etica?.paused ? 'warn' : 'ok'}
          />
        </div>
        <div className="mt-3 text-xs text-white/40">
          Insurance backstop: {etica ? `${fmtEtx(etica.insuranceTotal)} ETX` : '…'}
        </div>
      </div>

      {(Object.keys(BRIDGE_REMOTE_DEPLOYMENTS) as unknown as string[]).map((domainStr) => {
        const domain = Number(domainStr) as BridgeRemoteDomain;
        const r = BRIDGE_REMOTE_DEPLOYMENTS[domain];
        const stats = remotes[domain];
        const isLive = isBridgeRemoteLive(domain);
        const heartbeatStale =
          stats && Number(stats.lastHeartbeatAt) > 0
            ? Date.now() / 1000 - Number(stats.lastHeartbeatAt) > Number(stats.heartbeatTimeoutSeconds)
            : false;
        return (
          <div key={domain} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex items-baseline justify-between">
              <div className="text-xs uppercase tracking-widest text-white/40">{r.chainName}</div>
              <span
                className={`text-xs ${
                  !isLive
                    ? 'text-white/40'
                    : stats?.paused
                      ? 'text-amber-300'
                      : heartbeatStale
                        ? 'text-amber-300'
                        : 'text-emerald-300'
                }`}
              >
                {!isLive ? 'Not deployed' : stats?.paused ? 'Paused' : heartbeatStale ? 'Heartbeat stale' : 'Live'}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Stat label="Minted" value={isLive ? (stats ? `${fmtEtx(stats.minted)} wETX` : '…') : '—'} />
              <Stat label="TVL cap" value={isLive ? (stats ? `${fmtEtx(stats.cap)} wETX` : '…') : '—'} />
              <Stat
                label="Utilisation"
                value={isLive ? (stats ? pct(stats.minted, stats.cap) : '…') : '—'}
              />
              <Stat
                label="Last heartbeat"
                value={
                  isLive
                    ? stats
                      ? Number(stats.lastHeartbeatAt) > 0
                        ? `${Math.max(0, Math.floor(Date.now() / 1000 - Number(stats.lastHeartbeatAt)) / 60).toFixed(0)} m ago`
                        : 'never'
                      : '…'
                    : '—'
                }
                tone={heartbeatStale ? 'warn' : undefined}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  const valueClass = tone === 'warn' ? 'text-amber-300' : tone === 'ok' ? 'text-emerald-300' : 'text-white';
  return (
    <div>
      <div className="text-xs text-white/40">{label}</div>
      <div className={`mt-0.5 font-medium tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
