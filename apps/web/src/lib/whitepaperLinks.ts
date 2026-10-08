const REPO_BLOB = 'https://github.com/iamdexx/etica-hub/blob/main';

/**
 * `docs/WHITEPAPER.md` is authored for the repo, so its relative links point
 * at sibling docs (`TRADING.md`, `../apps/web/src/middleware.ts`). Resolve
 * them against `docs/` on GitHub so they work from /whitepaper instead of
 * 404ing on the site. Absolute URLs, anchors and site-root paths pass through.
 */
export function resolveWhitepaperHref(href: string | undefined): string | undefined {
  if (!href) return href;
  if (/^(https?:|mailto:|#|\/)/i.test(href)) return href;
  const segments: string[] = ['docs'];
  for (const part of href.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return `${REPO_BLOB}/${segments.join('/')}`;
}
