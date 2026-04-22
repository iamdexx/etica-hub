'use client';

import { OrderForm } from './OrderForm';
import type { TradeBaseSymbol } from '@/lib/trading/baseSymbol';

export interface StopFormProps {
  baseSymbol: TradeBaseSymbol;
}

/**
 * Stop-order composer. Adds a trigger-price input on top of the shared limit
 * form. The on-chain primitive is identical to a limit order — keepers just
 * gate the fill attempt on the trigger condition off-chain.
 */
export function StopForm({ baseSymbol }: StopFormProps) {
  return <OrderForm baseSymbol={baseSymbol} strategy="stop" />;
}
