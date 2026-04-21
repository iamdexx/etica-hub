'use client';

import { OrderForm } from './OrderForm';

export interface LimitFormProps {
  baseSymbol: 'ETI' | 'EGAZ';
}

/**
 * Thin wrapper that preserves the pre-existing import path; all signing +
 * approval logic lives in `OrderForm` so the Stop form can share it.
 */
export function LimitForm({ baseSymbol }: LimitFormProps) {
  return <OrderForm baseSymbol={baseSymbol} strategy="limit" />;
}
