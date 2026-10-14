import { parseAbi } from 'viem';

export const directFactoryAbi = parseAbi([
  'function feeTo() view returns (address)',
  'function feeToSetter() view returns (address)',
  'function guardian() view returns (address)',
  'function swapsPaused() view returns (bool)',
  'function pauseExpiresAt() view returns (uint256)',
  'function minStEtx() view returns (uint256)',
  'function baseFeeBps() view returns (uint16)',
  'function feeTierCount() view returns (uint256)',
  'function feeTier(uint256 index) view returns (uint256 minStEtx, uint16 feeBps)',
  'function metaPairDeployer() view returns (address)',
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
  'function isMetaPair(address) view returns (bool)',
  'function retired(address) view returns (bool)',
  'function whitelist(address) view returns (bool)',
  'function pauseSwaps()',
]);

export const metaPairAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function hubPair0() view returns (address)',
  'function hubPair1() view returns (address)',
  'function etx() view returns (address)',
  'function hubLiquidity() view returns (uint256 lp0, uint256 lp1)',
  'function liveReserves() view returns (uint256 r0, uint256 r1)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
]);

export const hubPairAbi = parseAbi([
  'function token0() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]);

export const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);
