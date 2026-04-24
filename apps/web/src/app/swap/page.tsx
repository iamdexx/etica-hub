import { MarketVolumeStrip } from '@/components/MarketVolumeStrip';
import { SwapCard } from '@/components/swap/SwapCard';
import { TvlBanner } from '@/components/TvlBanner';

export const metadata = { title: 'Swap · EticaHub' };

export default function SwapPage() {
  return (
    <div className="mx-auto max-w-md space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Swap</h1>
        <p className="text-sm text-white/60">
          Trade ETI, EGAZ, and any ERC20 on Etica. 0.30% swap fee. Slippage protection on every
          trade.
        </p>
      </header>
      <TvlBanner />
      <SwapCard />
      <MarketVolumeStrip />
    </div>
  );
}
