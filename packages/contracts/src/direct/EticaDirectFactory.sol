// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {EticaDirectPair} from "./EticaDirectPair.sol";
import {IEticaDirectFactory} from "./IEticaDirectFactory.sol";
import {IERC20Minimal} from "../swap/interfaces/IERC20Minimal.sol";

/// @title EticaSwap Direct factory (stETX-gated direct pairs)
/// @notice The second EticaSwap venue. EticaSwap V2 stays pure hub-and-spoke
///         (every pair contains ETX); this factory hosts curated direct pairs
///         such as EGAZ/USDC.e and ETI/USDC.e that bypass the hub, and the
///         only way to use them is to hold at least `minStEtx` stETX. Holding
///         stETX means ETX is staked, so direct routing still pulls demand
///         into the hub asset instead of around it, and the venue's protocol
///         fee is harvested back to stETX holders.
/// @dev    Pair creation is curated: only `feeToSetter` or a trusted creator
///         may open a pair, there is no creation fee, and there is no ETX
///         requirement. Pairs, whitelisted routers and the fee harvester are
///         always allowed so multi-hop swaps, EGAZ unwrapping and fee claims
///         work; everyone else is checked against `stEtx.balanceOf`.
///         Events, `getPair` and `allPairs` are byte-for-byte V2 compatible so
///         {EticaSwapRouter} and V2-aware indexers work against this factory
///         without changes.
contract EticaDirectFactory is IEticaDirectFactory {
    address public immutable stEtx;
    uint256 public minStEtx;

    address public feeTo;
    address public feeToSetter;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;
    mapping(address => bool) public isPair;
    mapping(address => bool) public trustedCreators;
    mapping(address => bool) public whitelist;

    constructor(address _feeToSetter, address _stEtx, uint256 _minStEtx) {
        require(_feeToSetter != address(0), "EDirect: ZERO_ADDRESS");
        require(_stEtx != address(0), "EDirect: STETX_ZERO_ADDRESS");
        feeToSetter = _feeToSetter;
        stEtx = _stEtx;
        minStEtx = _minStEtx;
        emit MinStEtxSet(_minStEtx);
    }

    modifier onlySetter() {
        require(msg.sender == feeToSetter, "EDirect: FORBIDDEN");
        _;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @inheritdoc IEticaDirectFactory
    function isAllowed(address account) public view returns (bool) {
        if (isPair[account] || whitelist[account]) return true;
        uint256 threshold = minStEtx;
        if (threshold == 0) return true;
        return IERC20Minimal(stEtx).balanceOf(account) >= threshold;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(msg.sender == feeToSetter || trustedCreators[msg.sender], "EDirect: NOT_CREATOR");
        require(tokenA != tokenB, "EDirect: IDENTICAL_ADDRESSES");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "EDirect: ZERO_ADDRESS");
        require(getPair[token0][token1] == address(0), "EDirect: PAIR_EXISTS");

        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        pair = address(new EticaDirectPair{salt: salt}());
        EticaDirectPair(pair).initialize(token0, token1);

        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        isPair[pair] = true;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external onlySetter {
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external onlySetter {
        require(_feeToSetter != address(0), "EDirect: ZERO_ADDRESS");
        feeToSetter = _feeToSetter;
    }

    function setTrustedCreator(address creator, bool trusted) external onlySetter {
        require(creator != address(0), "EDirect: ZERO_ADDRESS");
        trustedCreators[creator] = trusted;
        emit TrustedCreatorSet(creator, trusted);
    }

    /// @notice Routers and fee sinks that must be able to receive pair output
    ///         without holding stETX themselves.
    function setWhitelist(address account, bool allowed) external onlySetter {
        require(account != address(0), "EDirect: ZERO_ADDRESS");
        whitelist[account] = allowed;
        emit WhitelistSet(account, allowed);
    }

    /// @notice stETX (18 dp shares) a wallet must hold to use the venue.
    ///         Zero opens the venue to everyone.
    function setMinStEtx(uint256 _minStEtx) external onlySetter {
        minStEtx = _minStEtx;
        emit MinStEtxSet(_minStEtx);
    }

    /// @notice Init code hash for pairs — useful for off-chain CREATE2 address prediction.
    function pairCodeHash() external pure returns (bytes32) {
        return keccak256(type(EticaDirectPair).creationCode);
    }
}
