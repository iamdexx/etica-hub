import type { Metadata } from 'next';
import { ActiveOrders } from '@/components/trade/ActiveOrders';

export const metadata: Metadata = {
  title: 'Your orders · EticaHub',
  description:
    'Open limit, stop, and bot-strategy orders you have signed on EticaHub. Non-custodial — cancel any time.',
};

export default function OrdersPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Your orders</h1>
        <p className="text-sm text-white/60">
          Signed orders resting in the off-chain order book. Funds stay in your wallet until a keeper
          lands a profitable fill. Your wallet can cancel any time by invalidating the Permit2 nonce
          directly.
        </p>
      </header>
      <ActiveOrders />
    </div>
  );
}
