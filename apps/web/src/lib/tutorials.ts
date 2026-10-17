export interface Tutorial {
  slug: string;
  title: string;
  summary: string;
  /** Seconds. */
  duration: number;
  video: string;
  poster: string;
  steps: string[];
  tryIt: { href: string; label: string };
}

export const TUTORIALS: Tutorial[] = [
  {
    slug: 'bridge-usdc-to-etica',
    title: 'Bridge USDC from Ethereum to Etica',
    summary:
      'Move Circle USDC from Ethereum to Etica as USDC.e with MetaMask, then switch networks and see it land in your wallet.',
    duration: 255,
    video: '/tutorials/bridge-usdc-to-etica.mp4',
    poster: '/tutorials/bridge-usdc-to-etica.jpg',
    steps: [
      'Open Bridge, connect your wallet on Ethereum mainnet.',
      'Enter the USDC amount; the card shows the fee, delivery gas and what you receive.',
      'Approve USDC in your wallet, then confirm the bridge transaction.',
      'Switch to Etica mainnet; USDC.e arrives in a few minutes and the card shows the delivery.',
    ],
    tryIt: { href: '/bridge', label: 'Open Bridge' },
  },
];

export function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}
