/**
 * Server-side flag controlling visibility of operator-only pages
 * (/deploy/*, /seed/*, /admin/*).
 *
 * Default in production is OFF — these pages were only needed for the one-time
 * v1 mainnet rollout and would otherwise confuse end users (or let a clueless
 * visitor deploy a clone "ETX" that has no relationship to the canonical
 * EticaHub token).
 *
 * To re-enable, set NEXT_PUBLIC_OPERATOR_UI=1 on the hosting platform and
 * redeploy. In a local dev server these pages are always on.
 */
export function operatorUiEnabled(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  const flag = process.env.NEXT_PUBLIC_OPERATOR_UI;
  return flag === '1' || flag === 'true';
}
