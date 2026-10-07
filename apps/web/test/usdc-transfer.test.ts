import { describe, expect, it } from 'vitest';
import { mainnet } from 'viem/chains';
import { USDC_WARP_ROUTE } from '@etica-hub/shared';
import { eticaMainnet } from '@etica-hub/shared/chains';
import {
  ETHEREUM_DOMAIN,
  ETICA_DOMAIN,
  USDC_LEGS,
  parseUsdcAmount,
  splitWarpQuote,
  toBytes32Recipient,
} from '@/lib/bridge/usdc-transfer';

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const USDC = USDC_WARP_ROUTE.collateralToken;

describe('USDC warp legs', () => {
  it('Ethereum → Etica pulls USDC through the collateral router and needs an approval', () => {
    const leg = USDC_LEGS.toEtica;
    expect(leg.sourceChainId).toBe(mainnet.id);
    expect(leg.destinationDomain).toBe(ETICA_DOMAIN);
    expect(leg.router).toBe(USDC_WARP_ROUTE.collateralRouter);
    expect(leg.token).toBe(USDC);
    expect(leg.needsApproval).toBe(true);
  });

  it('Etica → Ethereum burns USDC.e on its own router, no approval', () => {
    const leg = USDC_LEGS.toEthereum;
    expect(leg.sourceChainId).toBe(eticaMainnet.id);
    expect(leg.destinationDomain).toBe(ETHEREUM_DOMAIN);
    expect(leg.router).toBe(USDC_WARP_ROUTE.syntheticToken);
    expect(leg.token).toBe(leg.router);
    expect(leg.needsApproval).toBe(false);
  });
});

describe('splitWarpQuote', () => {
  it('separates the native gas payment from the stable fee', () => {
    const r = splitWarpQuote(
      [
        { token: ZERO, amount: 1_500n },
        { token: USDC.toLowerCase() as typeof USDC, amount: 20_100_000n },
      ],
      USDC,
      20_000_000n,
    );
    expect(r).toEqual({ native: 1_500n, tokenFee: 100_000n });
  });

  it('tolerates a zero-amount line in another token but rejects a real one', () => {
    const other = '0x1111111111111111111111111111111111111111';
    expect(splitWarpQuote([{ token: other, amount: 0n }, { token: USDC, amount: 5n }], USDC, 5n)).toEqual({
      native: 0n,
      tokenFee: 0n,
    });
    expect(() => splitWarpQuote([{ token: other, amount: 1n }, { token: USDC, amount: 5n }], USDC, 5n)).toThrow(
      /unexpected token/,
    );
  });

  it('rejects a stable quote below the transfer amount', () => {
    expect(() => splitWarpQuote([{ token: USDC, amount: 4n }], USDC, 5n)).toThrow(/quotes 4 for a 5/);
  });
});

describe('recipient + amount parsing', () => {
  it('left-pads the recipient to bytes32', () => {
    expect(toBytes32Recipient('0xfcDd0d3d9A167092d094287E109B9315f08d05a7').toLowerCase()).toBe(
      '0x000000000000000000000000fcdd0d3d9a167092d094287e109b9315f08d05a7',
    );
  });

  it('parses 6-decimal amounts and rejects junk', () => {
    expect(parseUsdcAmount('20')).toBe(20_000_000n);
    expect(parseUsdcAmount(' 0.5 ')).toBe(500_000n);
    expect(parseUsdcAmount('1.1234567')).toBeNull();
    expect(parseUsdcAmount('0')).toBeNull();
    expect(parseUsdcAmount('-1')).toBeNull();
    expect(parseUsdcAmount('abc')).toBeNull();
    expect(parseUsdcAmount('1e3')).toBeNull();
  });
});
