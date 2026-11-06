/** Integer square root (floor), same as the pair's Math.sqrt. */
export function sqrtBig(n: bigint): bigint {
  if (n < 0n) throw new Error('sqrt of negative');
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/**
 * LP tokens `EticaSwapPair._mintFee` will mint to `feeTo` on the next mint/burn:
 * totalSupply · (√k − √kLast) / (5·√k + √kLast) when the protocol fee is on and
 * k grew since the last liquidity event; 0 otherwise.
 */
export function protocolFeeMint(reserve0: bigint, reserve1: bigint, totalSupply: bigint, kLast: bigint, feeOn: boolean): bigint {
  if (!feeOn || kLast === 0n) return 0n;
  const rootK = sqrtBig(reserve0 * reserve1);
  const rootKLast = sqrtBig(kLast);
  if (rootK <= rootKLast) return 0n;
  return (totalSupply * (rootK - rootKLast)) / (rootK * 5n + rootKLast);
}

/** What burning `lp` returns, after the protocol-fee mint dilutes the supply. */
export function burnOutput(lp: bigint, reserve0: bigint, reserve1: bigint, totalSupply: bigint, kLast: bigint, feeOn: boolean): { amount0: bigint; amount1: bigint } {
  const supply = totalSupply + protocolFeeMint(reserve0, reserve1, totalSupply, kLast, feeOn);
  if (lp === 0n || supply === 0n) return { amount0: 0n, amount1: 0n };
  return { amount0: (lp * reserve0) / supply, amount1: (lp * reserve1) / supply };
}
