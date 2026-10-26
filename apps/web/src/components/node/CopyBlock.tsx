'use client';

import { useState } from 'react';

interface Props {
  label: string;
  value: string;
  className?: string;
}

/** Monospace block with a copy button; feedback resets after 1.2s. */
export function CopyBlock({ label, value, className = '' }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard blocked; the text is still selectable.
    }
  }

  return (
    <div className={`space-y-1 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs uppercase tracking-wide text-white/50">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="btn-ghost px-2.5 py-1 text-xs"
          aria-label={`Copy ${label}`}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-white/[0.07] bg-black/30 p-3 font-mono text-xs text-emerald-200">{value}</pre>
    </div>
  );
}
