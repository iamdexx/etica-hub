// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

/// @title EticaSwap Direct factory interface
/// @notice Uniswap V2–compatible factory (same `PairCreated`, `getPair`,
///         `allPairs`, `feeTo` surface so routers and indexers that speak V2
///         work unchanged) plus the stETX gate every pair consults.
interface IEticaDirectFactory {
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);
    event TrustedCreatorSet(address indexed creator, bool trusted);
    event MetaPairDeployerSet(address deployer);
    event MetaPairCreated(
        address indexed token0, address indexed token1, address pair, address hubRouter
    );
    event WhitelistSet(address indexed account, bool allowed);
    event MinStEtxSet(uint256 minStEtx);
    event FeeTiersSet(uint256[] minStEtx, uint16[] feeBps);
    event BaseFeeBpsSet(uint16 feeBps);
    event GuardianSet(address indexed guardian);
    event GuardianPauseDurationSet(uint256 duration);
    event UnpauserSet(address indexed account, bool allowed);
    /// @param expiresAt When a guardian pause lapses; 0 for a setter pause.
    event SwapsPaused(address indexed by, uint256 expiresAt);
    event SwapsUnpaused(address indexed by);
    event PairRetired(address indexed token0, address indexed token1, address pair);

    function stEtx() external view returns (address);
    function minStEtx() external view returns (uint256);
    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);
    function trustedCreators(address creator) external view returns (bool);
    function whitelist(address account) external view returns (bool);
    function isPair(address pair) external view returns (bool);
    function isMetaPair(address pair) external view returns (bool);
    function metaPairDeployer() external view returns (address);
    /// @notice Address allowed to pause swaps (never to move funds or unpause).
    function guardian() external view returns (address);
    /// @notice True for accounts allowed to call {unpauseSwaps} without the setter (1-of-N resume).
    function unpausers(address account) external view returns (bool);
    /// @notice Seconds a guardian pause lasts before swaps reopen by themselves.
    function guardianPauseDuration() external view returns (uint256);
    /// @notice Timestamp the current guardian pause lapses; 0 while a setter
    ///         pause holds (or nothing is paused).
    function pauseExpiresAt() external view returns (uint256);
    /// @notice True while a setter pause holds or a guardian pause has not lapsed.
    function swapsPaused() external view returns (bool);
    function retired(address pair) external view returns (bool);
    /// @notice False while the venue is paused or `pair` has been retired;
    ///         pairs refuse swaps (but not mint/skim/sync) when false.
    function swapsOpen(address pair) external view returns (bool);

    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function allPairs(uint256) external view returns (address pair);
    function allPairsLength() external view returns (uint256);

    /// @notice True when `account` may receive the output of a mint, burn or
    ///         swap on any venue pair.
    function isAllowed(address account) external view returns (bool);
    /// @notice Swap fee (basis points of the input) charged to `trader`,
    ///         based on its stETX balance: `baseFeeBps` below the first tier,
    ///         then the fee of the highest tier whose threshold it meets.
    function feeBpsFor(address trader) external view returns (uint16);
    function baseFeeBps() external view returns (uint16);
    function feeTierCount() external view returns (uint256);
    function feeTier(uint256 index) external view returns (uint256 minStEtx, uint16 feeBps);

    function createPair(address tokenA, address tokenB) external returns (address pair);
    function createMetaPair(address tokenA, address tokenB, address hubRouter)
        external
        returns (address pair);

    function setFeeTo(address) external;
    function setFeeToSetter(address) external;
    function setTrustedCreator(address creator, bool trusted) external;
    function setWhitelist(address account, bool allowed) external;
    function setMinStEtx(uint256 minStEtx) external;
    function setBaseFeeBps(uint16 feeBps) external;
    function setFeeTiers(uint256[] calldata minStEtx, uint16[] calldata feeBps) external;
    function setGuardian(address guardian) external;
    function setGuardianPauseDuration(uint256 duration) external;
    function pauseSwaps() external;
    function setUnpauser(address account, bool allowed) external;
    function unpauseSwaps() external;
    function retirePair(address pair) external;
}
