// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {EticaDirectPair} from "./EticaDirectPair.sol";

interface IEticaDirectMetaPairDeployer {
    function deploy(address factory) external returns (address pair);
}

interface IEticaDirectMetaPairInit {
    function initialize(address token0, address token1, address hubRouter) external;
}
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
    /// @notice Pairs that are hub windows ({EticaDirectMetaPair}) rather than
    ///         constant-product pools.
    mapping(address => bool) public isMetaPair;
    /// @notice {EticaDirectMetaPairDeployer} used by {createMetaPair}.
    address public metaPairDeployer;
    mapping(address => bool) public trustedCreators;
    mapping(address => bool) public whitelist;

    /// @notice Hard cap on any venue fee (10%).
    uint16 public constant MAX_FEE_BPS = 1_000;
    /// @notice Fee for traders below the first tier (default 3.00%).
    uint16 public baseFeeBps = 300;
    uint256[] private tierMinStEtx;
    uint16[] private tierFeeBps;

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
        if (whitelist[account]) return true;
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

    /// @notice Open a hub window for `tokenA`/`tokenB`: a {EticaDirectMetaPair}
    ///         whose liquidity lives in the `tokenA`/ETX and `tokenB`/ETX pools
    ///         behind `hubRouter`. Same curation, registry and PairCreated
    ///         event as {createPair}, so indexers treat it as a plain pair.
    function createMetaPair(address tokenA, address tokenB, address hubRouter)
        external
        returns (address pair)
    {
        require(msg.sender == feeToSetter || trustedCreators[msg.sender], "EDirect: NOT_CREATOR");
        require(tokenA != tokenB, "EDirect: IDENTICAL_ADDRESSES");
        require(hubRouter != address(0), "EDirect: ZERO_ADDRESS");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "EDirect: ZERO_ADDRESS");
        require(getPair[token0][token1] == address(0), "EDirect: PAIR_EXISTS");

        require(metaPairDeployer != address(0), "EDirect: NO_DEPLOYER");
        pair = IEticaDirectMetaPairDeployer(metaPairDeployer).deploy(address(this));
        IEticaDirectMetaPairInit(pair).initialize(token0, token1, hubRouter);

        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        isPair[pair] = true;
        isMetaPair[pair] = true;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
        emit MetaPairCreated(token0, token1, pair, hubRouter);
    }

    function setMetaPairDeployer(address deployer) external onlySetter {
        metaPairDeployer = deployer;
        emit MetaPairDeployerSet(deployer);
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

    /// @notice Fee charged to traders that meet no tier (whitelisted contracts
    ///         and, when `minStEtx == 0`, non-stakers). Never below the first
    ///         tier's fee, so holding more stETX can never cost more.
    function setBaseFeeBps(uint16 _feeBps) external onlySetter {
        require(_feeBps <= MAX_FEE_BPS, "EDirect: FEE_TOO_HIGH");
        require(tierFeeBps.length == 0 || _feeBps >= tierFeeBps[0], "EDirect: FEE_BELOW_TIERS");
        baseFeeBps = _feeBps;
        emit BaseFeeBpsSet(_feeBps);
    }

    /// @notice Replace the stETX fee ladder. Thresholds strictly ascending,
    ///         fees non-increasing and never above `baseFeeBps`. An empty
    ///         ladder charges `baseFeeBps` to everyone.
    function setFeeTiers(uint256[] calldata _minStEtx, uint16[] calldata _feeBps)
        external
        onlySetter
    {
        require(_minStEtx.length == _feeBps.length, "EDirect: LENGTH_MISMATCH");
        uint16 prevFee = baseFeeBps;
        for (uint256 i; i < _minStEtx.length; i++) {
            require(_minStEtx[i] > 0, "EDirect: ZERO_TIER");
            if (i > 0) require(_minStEtx[i] > _minStEtx[i - 1], "EDirect: TIERS_NOT_ASCENDING");
            require(_feeBps[i] <= prevFee, "EDirect: FEE_NOT_DESCENDING");
            prevFee = _feeBps[i];
        }
        tierMinStEtx = _minStEtx;
        tierFeeBps = _feeBps;
        emit FeeTiersSet(_minStEtx, _feeBps);
    }

    function feeTierCount() external view returns (uint256) {
        return tierMinStEtx.length;
    }

    function feeTier(uint256 index) external view returns (uint256, uint16) {
        return (tierMinStEtx[index], tierFeeBps[index]);
    }

    /// @inheritdoc IEticaDirectFactory
    function feeBpsFor(address trader) public view returns (uint16 fee) {
        fee = baseFeeBps;
        uint256 n = tierMinStEtx.length;
        if (n == 0) return fee;
        uint256 bal = IERC20Minimal(stEtx).balanceOf(trader);
        for (uint256 i; i < n; i++) {
            if (bal < tierMinStEtx[i]) break;
            fee = tierFeeBps[i];
        }
    }

    /// @notice Init code hash for pairs — useful for off-chain CREATE2 address prediction.
    function pairCodeHash() external pure returns (bytes32) {
        return keccak256(type(EticaDirectPair).creationCode);
    }
}
