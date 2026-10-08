import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWhitepaperHref } from '../src/lib/whitepaperLinks';

const GH = 'https://github.com/iamdexx/etica-hub/blob/main';

describe('resolveWhitepaperHref', () => {
  it('maps sibling docs onto GitHub under docs/', () => {
    expect(resolveWhitepaperHref('TRADING.md')).toBe(`${GH}/docs/TRADING.md`);
    expect(resolveWhitepaperHref('./aggregators/')).toBe(`${GH}/docs/aggregators`);
  });

  it('walks ../ out of docs/', () => {
    expect(resolveWhitepaperHref('../apps/web/src/middleware.ts')).toBe(
      `${GH}/apps/web/src/middleware.ts`,
    );
  });

  it('leaves absolute URLs, anchors and site paths alone', () => {
    expect(resolveWhitepaperHref('https://eticahub.com/bridge')).toBe('https://eticahub.com/bridge');
    expect(resolveWhitepaperHref('#appendix-a')).toBe('#appendix-a');
    expect(resolveWhitepaperHref('/swap')).toBe('/swap');
    expect(resolveWhitepaperHref(undefined)).toBeUndefined();
  });
});

describe('public whitepaper copy', () => {
  it('is byte-identical to docs/WHITEPAPER.md (what /whitepaper renders)', () => {
    const pub = readFileSync(path.join(__dirname, '..', 'public', 'whitepaper.md'), 'utf8');
    const src = readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'WHITEPAPER.md'), 'utf8');
    expect(pub).toBe(src);
  });
});
