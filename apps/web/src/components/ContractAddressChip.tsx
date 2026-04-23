'use client';

import { useState } from 'react';
import type { Address } from 'viem';

interface Props {
  label: string;
  address: Address;
  /** Base URL for the address link. Defaults to the in-app explorer. */
  explorerBaseUrl?: string;
  className?: string;
}

/**
 * Compact, copyable contract-address badge. Renders inline as
 *
 *     [{label}  0x75d8…0334  📋  ↗]
 *
 * Copy button feedback resets after 1.2s. Explorer link opens the local
 * /explorer/address/<addr> route (full-chain read fallback covered there).
 */
export function ContractAddressChip({
  label,
  address,
  explorerBaseUrl = '/explorer/address',
  className = '',
}: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API blocked (http / permissions) — fall through silently.
    }
  }

  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-white/70 ${className}`}
    >
      <span className="text-white/45">{label}</span>
      <a
        href={`${explorerBaseUrl}/${address}`}
        className="font-mono text-emerald-300 hover:underline"
        title={address}
      >
        {short}
      </a>
      <button
        type="button"
        onClick={copy}
        className="rounded px-1 text-white/50 transition hover:text-white/90"
        aria-label={`Copy ${label} address`}
      >
        {copied ? '✓' : '⎘'}
      </button>
    </div>
  );
}
