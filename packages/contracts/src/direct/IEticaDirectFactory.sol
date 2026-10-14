// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

/// @title EticaSwap Direct factory interface
/// @notice Uniswap V2–compatible factory (same `PairCreated`, `getPair`,
///         `allPairs`, `feeTo` surface so routers and indexers that speak V2
///         work unchanged) plus the stETX gate every pair consults.
interface IEticaDirectFactory {
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);
    event TrustedCreatorSet(address indexed creator, bool trusted);
    event MetaPairCreated(
        address indexed token0, address indexed token1, address pair, address hubRouter
    );
    event WhitelistSet(address indexed account, bool allowed);
    event MinStEtxSet(uint256 minStEtx);
    event FeeTiersSet(uint256[] minStEtx, uint16[] feeBps);
    event BaseFeeBpsSet(uint16 feeBps);

    function stEtx() external view returns (address);
    function minStEtx() external view returns (uint256);
    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);
    function trustedCreators(address creator) external view returns (bool);
    function whitelist(address account) external view returns (bool);
    function isPair(address pair) external view returns (bool);
    function isMetaPair(address pair) external view returns (bool);

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
}
