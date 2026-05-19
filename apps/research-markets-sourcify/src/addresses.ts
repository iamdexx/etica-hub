/**
 * Resolve the EticaResearchMarkets singleton address for a given chain.
 *
 * We deliberately don't import @etica-hub/shared from this worker: the
 * shared package brings in big web-deps (viem extensions, browser
 * adapters) and a couple of those have TS-only entry points that aren't
 * always resolvable when this worker is invoked from a bare Node runtime
 * (e.g. inside the GitHub Actions runner before pnpm builds @etica-hub/shared).
 *
 * Instead we read the source file directly from disk and grep out the
 * address for the requested chain. addresses.ts is hand-maintained, so
 * its format is stable and matching against a small regex is robust.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Same 3-up logic as the bundle dir in worker.ts.
const ADDRESSES_TS = resolvePath(
  HERE,
  '..',
  '..',
  '..',
  'packages',
  'shared',
  'src',
  'addresses.ts',
);

export function researchMarketsSingleton(chainId: number): string {
  const src = readFileSync(ADDRESSES_TS, 'utf8');
  // Match a block of the shape:
  //   <chainId>: {
  //     ...
  //     eticaResearchMarkets: '0x...'
  // The chain blocks are keyed by literal numeric chainId followed by a
  // colon at module scope, so this regex is unambiguous in practice.
  const blockRe = new RegExp(
    String.raw`${chainId}\s*:\s*\{([\s\S]*?)\n\s*\}`,
    'g',
  );
  const blockMatch = blockRe.exec(src);
  if (!blockMatch) return '';
  const block = blockMatch[1] ?? '';
  const addrMatch = block.match(/eticaResearchMarkets\s*:\s*['"](0x[a-fA-F0-9]{40})['"]/);
  return addrMatch ? (addrMatch[1] as string) : '';
}
