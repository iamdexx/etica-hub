/**
 * Widget referral ledger.
 *
 *   GET  /api/v1/widget/referrals?ref=0x…   → totals for one host wallet
 *   POST /api/v1/widget/referrals {tx, ref}  → credit a confirmed swap
 *
 * The POST re-reads the receipt on-chain and only counts `Swap` events from
 * standalone-V2 pairs, so the client can't inflate its own numbers.
 */

import { jsonError, jsonResponse } from '@/lib/priceApi';
import {
  PROTOCOL_FEE_SHARE,
  REFERRAL_SHARE_OF_PROTOCOL_FEE,
  SWAP_FEE_BPS,
  creditWidgetSwap,
  getReferralTotals,
  referralStore,
} from '@/lib/widget/referrals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const terms = {
  swapFeeBps: SWAP_FEE_BPS,
  protocolFeeShare: PROTOCOL_FEE_SHARE,
  referralShareOfProtocolFee: REFERRAL_SHARE_OF_PROTOCOL_FEE,
  /** Fraction of traded volume owed to the host. */
  commissionOfVolume: (SWAP_FEE_BPS / 10_000) * PROTOCOL_FEE_SHARE * REFERRAL_SHARE_OF_PROTOCOL_FEE,
};

export async function GET(req: Request): Promise<Response> {
  const ref = new URL(req.url).searchParams.get('ref');
  if (!ref) return jsonError(400, 'ref required');
  const store = referralStore();
  if (!store) return jsonError(503, 'ledger unavailable');
  const totals = await getReferralTotals(store, ref);
  if (!totals) return jsonError(400, 'invalid ref');
  return jsonResponse({ terms, totals });
}

export async function POST(req: Request): Promise<Response> {
  let body: { tx?: unknown; ref?: unknown };
  try {
    body = (await req.json()) as { tx?: unknown; ref?: unknown };
  } catch {
    return jsonError(400, 'invalid json');
  }
  if (typeof body.tx !== 'string' || typeof body.ref !== 'string') return jsonError(400, 'tx and ref required');
  const store = referralStore();
  if (!store) return jsonError(503, 'ledger unavailable');
  const result = await creditWidgetSwap(store, body.tx, body.ref);
  if (!result) return jsonError(400, 'invalid tx or ref');
  return jsonResponse({ terms, ...result });
}
