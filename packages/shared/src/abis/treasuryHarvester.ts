/**
 * ABI for the TreasuryHarvester delegation contract.
 *
 * Source: packages/contracts/src/etx/TreasuryHarvester.sol. Only the
 * fields the keeper + frontend actually touch are included. The treasury
 * pre-approves LP + token allowances once to this contract; a separate
 * hot keeper EOA then calls {harvest} on each run so the treasury key
 * never has to sign live transactions.
 */
export const treasuryHarvesterAbi = [
  // ─── Views ─────────────────────────────────────────────────────────────
  { type: 'function', name: 'etx', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'keeper', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'stakedEtx', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'farms', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'maxBurnBpsPerRun', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'stakedEtxBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'farmsBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'polBurnBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'treasuryBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'DEAD', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  // ─── Core call ─────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'harvest',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'pools',
        type: 'tuple[]',
        components: [
          { name: 'pair', type: 'address' },
          { name: 'nonEtx', type: 'address' },
          { name: 'lpToBurn', type: 'uint256' },
          { name: 'minEtxFromBurn', type: 'uint256' },
          { name: 'minNonEtxFromBurn', type: 'uint256' },
          { name: 'minEtxFromSwap', type: 'uint256' },
          { name: 'polEtxForSwap', type: 'uint256' },
          { name: 'polEtxForPair', type: 'uint256' },
          { name: 'minNonEtxFromPolSwap', type: 'uint256' },
        ],
      },
    ],
    outputs: [],
  },
  // ─── Admin (owner only) ────────────────────────────────────────────────
  {
    type: 'function',
    name: 'setKeeper',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newKeeper', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setStakedEtx',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newStakedEtx', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setFarms',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newFarms', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setSplit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_stakedBps', type: 'uint16' },
      { name: '_farmsBps', type: 'uint16' },
      { name: '_polBps', type: 'uint16' },
      { name: '_treasuryBps', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setMaxBurnBpsPerRun',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'bps', type: 'uint16' }],
    outputs: [],
  },
  // ─── Events ────────────────────────────────────────────────────────────
  {
    type: 'event',
    name: 'HarvestExecuted',
    inputs: [
      { indexed: true, name: 'keeper', type: 'address' },
      { indexed: false, name: 'totalEtxHarvested', type: 'uint256' },
      { indexed: false, name: 'stakedSlice', type: 'uint256' },
      { indexed: false, name: 'farmsSlice', type: 'uint256' },
      { indexed: false, name: 'polSlice', type: 'uint256' },
      { indexed: false, name: 'treasurySlice', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'PoolHarvested',
    inputs: [
      { indexed: true, name: 'pair', type: 'address' },
      { indexed: false, name: 'lpBurned', type: 'uint256' },
      { indexed: false, name: 'etxFromBurn', type: 'uint256' },
      { indexed: false, name: 'nonEtxFromBurn', type: 'uint256' },
      { indexed: false, name: 'etxFromSwap', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'PolAddLiquidity',
    inputs: [
      { indexed: true, name: 'pair', type: 'address' },
      { indexed: false, name: 'etxIn', type: 'uint256' },
      { indexed: false, name: 'nonEtxIn', type: 'uint256' },
      { indexed: false, name: 'lp', type: 'uint256' },
    ],
  },
] as const;
