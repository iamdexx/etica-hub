import { describe, expect, it } from 'vitest';
import { DEPLOYMENTS, USDC_WARP_ROUTE } from '@etica-hub/shared';
import { ETICA_ADD_CHAIN_PARAMS } from '@/components/network/AddNetworkButton';
import { WALLET_TOKENS } from '@/components/network/AddTokenButton';
import { ALL_LINKS, nextUpFor } from '@/lib/nav';
import tokenlist from '../public/tokenlist.json';

describe('wallet onboarding', () => {
  it('uses Etica chain and native EGAZ', () => {
    expect(ETICA_ADD_CHAIN_PARAMS.chainId).toBe('0xf16b');
    expect(ETICA_ADD_CHAIN_PARAMS.nativeCurrency.symbol).toBe('EGAZ');
    expect(ETICA_ADD_CHAIN_PARAMS.blockExplorerUrls).toContain('https://eticahub.com/explorer');
  });
  it('matches the live deployment registry and public token list', () => {
    expect(WALLET_TOKENS.ETX.address).toBe(DEPLOYMENTS[61803].etx);
    expect(WALLET_TOKENS.stETX.address).toBe(DEPLOYMENTS[61803].stakedETX);
    expect(WALLET_TOKENS['USDC.e'].address.toLowerCase()).toBe(USDC_WARP_ROUTE.syntheticToken.toLowerCase());
    for (const token of Object.values(WALLET_TOKENS)) {
      expect(tokenlist.tokens.some(t => t.chainId === 61803 && t.address.toLowerCase() === token.address.toLowerCase() && t.decimals === token.decimals)).toBe(true);
    }
  });
  it('links wallet setup without exposing hidden standalone pools', () => {
    expect(ALL_LINKS.some(l => l.href === '/network')).toBe(true);
    expect(nextUpFor('/network').map(l => l.href)).toEqual(['/tutorials', '/bridge', '/swap']);
    expect(ALL_LINKS.some(l => l.href.includes('/embed'))).toBe(false);
  });
});
