// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IEticaResearchMarkets
/// @notice External surface of the EticaResearchMarkets singleton. Used by
///         off-chain UI (launchpad, swap, trade) and on-chain integrations
///         (quoter, indexer, keeper) to read market state and execute
///         buys/sells without needing the full contract ABI.
interface IEticaResearchMarkets {
    struct MarketView {
        address token;
        address researcher;
        uint128 virtualEtxStart;
        uint128 virtualEtxAcc;
        uint128 tokenSupply;
        uint128 virtualTokenStart;
        uint64 launchedAt;
        uint64 lastTradeAt;
        uint64 graduatedAt;
        bool sunsetted;
    }

    event Launched(
        address indexed token,
        address indexed researcher,
        uint128 virtualEtxStart,
        uint128 virtualTokenStart,
        uint256 toll
    );
    event Bought(
        address indexed token,
        address indexed buyer,
        uint256 etxInGross,
        uint256 etxFee,
        uint256 tokensOut,
        uint128 virtualEtxAcc,
        uint128 tokenSupply
    );
    event Sold(
        address indexed token,
        address indexed seller,
        uint256 tokensIn,
        uint256 etxOutGross,
        uint256 etxFee,
        uint256 etxOutNet,
        uint128 virtualEtxAcc,
        uint128 tokenSupply
    );
    event Graduated(address indexed token, uint128 virtualEtxAcc, uint64 graduatedAt);
    event Sunsetted(address indexed token, uint128 recycledEtx, uint64 sunsetAt);
    event FeeRouted(
        address indexed token,
        uint256 totalFee,
        uint256 poolSlice,
        uint256 etiLpSlice,
        uint256 treasurySlice,
        uint256 researcherSlice
    );

    function buy(address token, uint256 etxInGross, uint256 minTokensOut, uint256 deadline)
        external
        returns (uint256 tokensOut);

    function sell(address token, uint256 tokensIn, uint256 minEtxOut, uint256 deadline)
        external
        returns (uint256 etxOutNet);

    function quoteBuy(address token, uint256 etxInGross)
        external
        view
        returns (uint256 tokensOut, uint256 etxFee);

    function quoteSell(address token, uint256 tokensIn)
        external
        view
        returns (uint256 etxOutNet, uint256 etxFee);

    function market(address token) external view returns (MarketView memory);

    function isGraduated(address token) external view returns (bool);

    function isSunsetted(address token) external view returns (bool);

    function totalMarkets() external view returns (uint256);

    function marketAt(uint256 index) external view returns (address);
}
