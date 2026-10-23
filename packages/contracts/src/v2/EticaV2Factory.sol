// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {EticaSwapPair} from "../swap/EticaSwapPair.sol";
import {IEticaV2Factory} from "./IEticaV2Factory.sol";

/// @title Standalone Uniswap V2 factory
/// @notice A plain, open Uniswap V2 factory with no link to the EticaSwap hub:
///         any token pair, created by anyone, exactly like UniswapV2Factory.
///         Pairs are the audited `EticaSwapPair` (x*y=k, 0.30% fee, standard
///         Mint/Burn/Swap/Sync events) holding real token balances, so any V2
///         indexer or aggregator reads them as-is. The hub factory keeps its
///         ETX hub-and-spoke rule; price parity between the two venues is left
///         to routing and arbitrage.
/// @dev    `feeTo()` is read by the pairs for the optional 1/6 protocol fee.
contract EticaV2Factory is IEticaV2Factory {
    address public feeTo;
    address public feeToSetter;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    constructor(address _feeToSetter) {
        require(_feeToSetter != address(0), "EV2: ZERO_ADDRESS");
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "EV2: IDENTICAL_ADDRESSES");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "EV2: ZERO_ADDRESS");
        require(getPair[token0][token1] == address(0), "EV2: PAIR_EXISTS");

        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        pair = address(new EticaSwapPair{salt: salt}());
        EticaSwapPair(pair).initialize(token0, token1);

        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, "EV2: FORBIDDEN");
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, "EV2: FORBIDDEN");
        require(_feeToSetter != address(0), "EV2: ZERO_ADDRESS");
        feeToSetter = _feeToSetter;
    }

    /// @notice Init code hash for pairs — for off-chain CREATE2 address prediction.
    function pairCodeHash() external pure returns (bytes32) {
        return keccak256(type(EticaSwapPair).creationCode);
    }
}
