// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {EticaSwapPair} from "./EticaSwapPair.sol";
import {IEticaSwapFactory} from "./interfaces/IEticaSwapFactory.sol";
import {TransferHelper} from "./libraries/TransferHelper.sol";

/// @title EticaSwap V2 factory (ETX hub-and-spoke)
/// @notice Deploys deterministic pair contracts via CREATE2. Every pair MUST
///         include ETX on one side: routes all liquidity through the ETX hub,
///         making ETX the reserve asset of the DEX. 0.05% protocol fee (1/6 of
///         the 0.30% swap fee) can be enabled by setting `feeTo`.
/// @dev    The `trustedCreators` allow-list is the one and only exception to
///         the ETX-only rule: addresses in the set may create pairs that do
///         not include ETX. It exists so the proposal-token launchpad can
///         open `token/ETI` pools alongside `token/ETX`. Everyone else stays
///         forced onto the ETX hub.
contract EticaSwapFactory is IEticaSwapFactory {
    /// @notice Default pair-creation fee, denominated in ETX (18 dp). Callers
    ///         not in `trustedCreators` must pay this in ETX on `createPair`.
    ///         Fee is skipped when `feeTo == 0x0` so a freshly-deployed
    ///         factory can bootstrap before treasury wiring.
    uint256 public constant DEFAULT_PAIR_CREATION_FEE = 10_000 ether;

    address public immutable etx;
    address public feeTo;
    address public feeToSetter;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;
    mapping(address => bool) public trustedCreators;
    uint256 public pairCreationFee;

    constructor(address _feeToSetter, address _etx) {
        require(_etx != address(0), "ESwap: ETX_ZERO_ADDRESS");
        feeToSetter = _feeToSetter;
        etx = _etx;
        pairCreationFee = DEFAULT_PAIR_CREATION_FEE;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "ESwap: IDENTICAL_ADDRESSES");
        require(
            tokenA == etx || tokenB == etx || trustedCreators[msg.sender],
            "ESwap: MUST_PAIR_WITH_ETX"
        );
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "ESwap: ZERO_ADDRESS");
        require(getPair[token0][token1] == address(0), "ESwap: PAIR_EXISTS");

        // Collect the pair-creation fee in ETX. Trusted creators (e.g. the
        // proposal-token launchpad, which already pays its own 250 ETX +
        // 250 ETI per launch) are exempt. The fee is also skipped while
        // `feeTo` is unset so a freshly-deployed factory can bootstrap.
        address recipient = feeTo;
        uint256 fee = pairCreationFee;
        if (!trustedCreators[msg.sender] && fee > 0 && recipient != address(0)) {
            TransferHelper.safeTransferFrom(etx, msg.sender, recipient, fee);
        }

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

    /// @notice Grant or revoke a creator's permission to open non-ETX pairs.
    /// @dev    Only the fee-to setter (i.e. governance / admin) can flip this.
    ///         Intended use: whitelist the proposal-token launchpad so it can
    ///         open `token/ETI` pools. Any address not in the set is still
    ///         subject to the ETX-only rule.
    function setTrustedCreator(address creator, bool trusted) external {
        require(msg.sender == feeToSetter, "ESwap: FORBIDDEN");
        require(creator != address(0), "ESwap: ZERO_ADDRESS");
        trustedCreators[creator] = trusted;
        emit TrustedCreatorSet(creator, trusted);
    }

    /// @notice Update the ETX fee charged on `createPair` to non-trusted
    ///         callers. Set to zero to disable the fee entirely.
    function setPairCreationFee(uint256 fee) external {
        require(msg.sender == feeToSetter, "ESwap: FORBIDDEN");
        pairCreationFee = fee;
        emit PairCreationFeeSet(fee);
    }

    /// @notice Init code hash for pairs — useful for off-chain CREATE2 address prediction.
    function pairCodeHash() external pure returns (bytes32) {
        return keccak256(type(EticaSwapPair).creationCode);
    }
}
