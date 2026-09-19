'use client';

import { useState } from 'react';

export function ShareButtons({ url, text }: { url: string; text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const tweet = `https://twitter.com/intent/tweet?${new URLSearchParams({ text, url }).toString()}`;
  const telegram = `https://t.me/share/url?${new URLSearchParams({ url, text }).toString()}`;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      /* clipboard unavailable — user can copy from the address bar */
    }
  }

  const cls =
    'rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/75 hover:bg-white/10';

  return (
    <div className="flex flex-wrap gap-2">
      <a className={cls} href={tweet} target="_blank" rel="noopener noreferrer">
        Share on X
      </a>
      <a className={cls} href={telegram} target="_blank" rel="noopener noreferrer">
        Telegram
      </a>
      <button type="button" className={cls} onClick={copy}>
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>
  );
}
