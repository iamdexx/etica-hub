'use client';

import { useMemo, useState } from 'react';
import { getAddress, isAddress } from 'viem';

type PairKey = 'egaz' | 'eti';
type Theme = 'dark' | 'light';

/**
 * Plug-and-play setup for widget hosts: paste a wallet, pick the pool, copy
 * one line. Nothing is stored; the wallet only ends up in the embed URL.
 */
export function V2WidgetSetup({ siteUrl }: { siteUrl: string }) {
  const [wallet, setWallet] = useState('');
  const [pair, setPair] = useState<PairKey>('egaz');
  const [theme, setTheme] = useState<Theme>('dark');
  const [copied, setCopied] = useState<'embed' | 'link' | null>(null);

  const trimmed = wallet.trim();
  const valid = isAddress(trimmed, { strict: false });
  const ref = valid ? getAddress(trimmed) : null;

  const embedUrl = useMemo(() => {
    const u = new URL('/embed/v2-pool', siteUrl);
    u.searchParams.set('pair', pair);
    if (theme === 'light') u.searchParams.set('theme', 'light');
    if (ref) u.searchParams.set('ref', ref);
    return u.toString();
  }, [siteUrl, pair, theme, ref]);
  const embedCode = `<iframe src="${embedUrl}" width="100%" height="640" style="border:0;border-radius:16px" allow="clipboard-write"></iframe>`;
  const ledgerUrl = ref ? `${siteUrl}/api/v1/widget/referrals?ref=${ref}` : null;

  async function copy(text: string, what: 'embed' | 'link') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable: the text is selectable */
    }
  }

  const field = 'w-full rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2 text-sm outline-none focus:border-emerald-500';

  return (
    <div className="min-h-screen bg-[#0b0f14] p-4 text-white sm:p-6">
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-white/50">EticaSwap · host a pool widget</div>
            <h1 className="text-xl font-semibold">Your swap widget in three fields</h1>
            <p className="mt-1 text-sm text-white/60">
              Paste the wallet that should receive your commission, pick the pool, copy the line into your page.
              Swaps made through your widget are credited to that wallet; nothing to run or maintain.
            </p>
          </div>

          <label className="block space-y-1 text-xs text-white/60">
            <span>Your wallet (receives commissions)</span>
            <input
              className={`${field} font-mono`}
              placeholder="0x…"
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              spellCheck={false}
            />
            {trimmed && !valid && <span className="text-amber-300">That is not a valid address.</span>}
          </label>

          <div className="grid grid-cols-2 gap-3 text-xs text-white/60">
            <label className="space-y-1">
              <span>Default pool (visitors can switch inside the widget)</span>
              <select className={field} value={pair} onChange={(e) => setPair(e.target.value as PairKey)}>
                <option value="egaz">EGAZ / USDC.e</option>
                <option value="eti">ETI / USDC.e</option>
              </select>
            </label>
            <label className="space-y-1">
              <span>Theme</span>
              <select className={field} value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </label>
          </div>

          <div className="space-y-1 text-xs text-white/60">
            <div className="flex items-center justify-between">
              <span>Embed code (paste anywhere HTML is allowed)</span>
              <button
                type="button"
                onClick={() => void copy(embedCode, 'embed')}
                disabled={!ref}
                className="rounded-md border border-white/[0.1] px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-40"
              >
                {copied === 'embed' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <textarea readOnly className={`${field} h-24 font-mono text-[11px]`} value={ref ? embedCode : 'Enter your wallet to generate the code.'} />
          </div>

          <div className="space-y-1 text-xs text-white/60">
            <div className="flex items-center justify-between">
              <span>Your commission ledger (public, live)</span>
              <button
                type="button"
                onClick={() => ledgerUrl && void copy(ledgerUrl, 'link')}
                disabled={!ledgerUrl}
                className="rounded-md border border-white/[0.1] px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-40"
              >
                {copied === 'link' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <input readOnly className={`${field} font-mono text-[11px]`} value={ledgerUrl ?? '—'} />
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 text-xs text-white/60">
            <div className="font-medium text-white/80">How you get paid</div>
            <p className="mt-1">
              Every swap pays a 0.30% fee: 0.25% to liquidity providers, 0.05% to the protocol. Hosts receive a share
              of the protocol part on every swap that goes through their widget, tracked per wallet at the link above
              and paid out from treasury fee income.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-white/50">Live preview</div>
          <div className="overflow-hidden rounded-2xl border border-white/[0.08]">
            <iframe title="Widget preview" src={embedUrl} width="100%" height="640" style={{ border: 0 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
