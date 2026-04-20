// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {EticaSwapPair} from "./EticaSwapPair.sol";
import {IEticaSwapFactory} from "./interfaces/IEticaSwapFactory.sol";

/// @title EticaSwap V2 factory
/// @notice Deploys deterministic pair contracts via CREATE2. 0.05% protocol
///         fee (1/6 of the 0.30% swap fee) can be enabled by setting `feeTo`.
contract EticaSwapFactory is IEticaSwapFactory {
    address public feeTo;
    address public feeToSetter;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    constructor(address _feeToSetter) {
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "ESwap: IDENTICAL_ADDRESSES");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "ESwap: ZERO_ADDRESS");
        require(getPair[token0][token1] == address(0), "ESwap: PAIR_EXISTS");

        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        pair = address(new EticaSwapPair{salt: salt}());
        EticaSwapPair(pair).initialize(token0, token1);

        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, "ESwap: FORBIDDEN");
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, "ESwap: FORBIDDEN");
        feeToSetter = _feeToSetter;
    }

    /// @notice Init code hash for pairs — useful for off-chain CREATE2 address prediction.
    function pairCodeHash() external pure returns (bytes32) {
        return keccak256(type(EticaSwapPair).creationCode);
    }
}
