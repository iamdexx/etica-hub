// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ProposalToken} from "./ProposalToken.sol";
import {ProposalTokenVesting} from "./ProposalTokenVesting.sol";
import {IEticaCore} from "./IEticaCore.sol";

interface IEticaSwapRouterLike {
    function factory() external view returns (address);
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
}

interface IEticaSwapFactoryLike {
    function getPair(address tokenA, address tokenB) external view returns (address);
    function createPair(address tokenA, address tokenB) external returns (address);
}

/// @title ProposalTokenFactory
/// @notice Creator-gated research-token launchpad. Only the wallet that
///         authored a proposal on the Etica core contract may launch a
///         funding token for that proposal, and only once. Every launched
///         token opens BOTH a `token/ETX` pool and a `token/ETI` pool in
///         the same transaction — this makes ETI an accretive sink
///         alongside ETX (dual-hub requirement) rather than a dilutive
///         alternative narrative.
///
/// @dev    Supply split (BPS): 25% LP into token/ETX, 25% LP into
///         token/ETI, 25% liquid to author, 25% linearly vested to author
///         over 90 days. The author must, prior to calling
///         {launchProposalToken}, grant two allowances on this contract:
///         - ETX: `launchFeeEtx + lpEtxAmount`
///         - ETI: `launchFeeEti + lpEtiAmount`
///
///         Because the swap factory enforces the hub-and-spoke invariant
///         for everyone else (pairs must include ETX), this launchpad is
///         expected to be added to the factory's trustedCreators
///         whitelist post-deploy so its token/ETI pool is permitted.
contract ProposalTokenFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant LP_ETX_SUPPLY_BPS = 2_500;
    uint256 public constant LP_ETI_SUPPLY_BPS = 2_500;
    uint256 public constant VEST_SUPPLY_BPS = 2_500;
    uint256 public constant LIQUID_SUPPLY_BPS = 2_500;
    uint64 public constant VEST_DURATION = 90 days;

    /// @notice Upper bounds on the owner-configurable launch fees. A
    ///         compromised or malicious owner cannot set either fee
    ///         above these ceilings, which caps the worst-case griefing
    ///         of legitimate authors at a known, bounded value.
    ///         ETX total supply is 100M (1e26), so 1M (1e24) is 1% —
    ///         already an absurd launch fee in practice but a hard stop
    ///         against "owner sets fee to type(uint256).max" DoS.
    uint256 public constant MAX_LAUNCH_FEE_ETX = 1_000_000e18;
    uint256 public constant MAX_LAUNCH_FEE_ETI = 1_000_000e18;

    IEticaCore public immutable eticaCore;
    IERC20 public immutable etx;
    IERC20 public immutable eti;
    IEticaSwapRouterLike public immutable router;

    address public treasury;
    uint256 public launchFeeEtx;
    uint256 public launchFeeEti;
    uint256 public minLpEtxAmount;
    uint256 public minLpEtiAmount;

    mapping(bytes32 => address) public proposalToToken;
    mapping(bytes32 => address) public proposalToVesting;

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event LaunchFeeEtxUpdated(uint256 oldFee, uint256 newFee);
    event LaunchFeeEtiUpdated(uint256 oldFee, uint256 newFee);
    event MinLpEtxUpdated(uint256 oldMin, uint256 newMin);
    event MinLpEtiUpdated(uint256 oldMin, uint256 newMin);
    event ProposalTokenLaunched(
        bytes32 indexed proposalHash,
        address indexed proposer,
        address indexed token,
        address vesting,
        uint256 totalSupply,
        uint256 lpTokenEtx,
        uint256 usedEtx,
        uint256 lpTokenEti,
        uint256 usedEti
    );

    error ZeroAddress();
    error NotProposalAuthor(address caller, address proposer);
    error ProposalUnknown(bytes32 proposalHash);
    error AlreadyLaunched(bytes32 proposalHash);
    error LpEtxTooLow(uint256 provided, uint256 minimum);
    error LpEtiTooLow(uint256 provided, uint256 minimum);
    error SupplyTooLow(uint256 totalSupply);
    error LaunchFeeTooHigh(uint256 provided, uint256 maximum);

    struct LaunchParams {
        bytes32 proposalHash;
        string name;
        string symbol;
        uint256 totalSupply;
        uint256 lpEtxAmount;
        uint256 lpEtiAmount;
        uint256 deadline;
    }

    struct ConstructorArgs {
        IEticaCore eticaCore;
        IERC20 etx;
        IERC20 eti;
        IEticaSwapRouterLike router;
        address treasury;
        uint256 launchFeeEtx;
        uint256 launchFeeEti;
        uint256 minLpEtxAmount;
        uint256 minLpEtiAmount;
        address owner;
    }

    constructor(ConstructorArgs memory a) Ownable(a.owner) {
        if (
            address(a.eticaCore) == address(0) || address(a.etx) == address(0)
                || address(a.eti) == address(0) || address(a.router) == address(0)
                || a.treasury == address(0) || a.owner == address(0)
        ) revert ZeroAddress();
        if (a.launchFeeEtx > MAX_LAUNCH_FEE_ETX) {
            revert LaunchFeeTooHigh(a.launchFeeEtx, MAX_LAUNCH_FEE_ETX);
        }
        if (a.launchFeeEti > MAX_LAUNCH_FEE_ETI) {
            revert LaunchFeeTooHigh(a.launchFeeEti, MAX_LAUNCH_FEE_ETI);
        }
        eticaCore = a.eticaCore;
        etx = a.etx;
        eti = a.eti;
        router = a.router;
        treasury = a.treasury;
        launchFeeEtx = a.launchFeeEtx;
        launchFeeEti = a.launchFeeEti;
        minLpEtxAmount = a.minLpEtxAmount;
        minLpEtiAmount = a.minLpEtiAmount;
    }

    // --------------------------------------------------------------- admin

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setLaunchFeeEtx(uint256 newFee) external onlyOwner {
        if (newFee > MAX_LAUNCH_FEE_ETX) revert LaunchFeeTooHigh(newFee, MAX_LAUNCH_FEE_ETX);
        emit LaunchFeeEtxUpdated(launchFeeEtx, newFee);
        launchFeeEtx = newFee;
    }

    function setLaunchFeeEti(uint256 newFee) external onlyOwner {
        if (newFee > MAX_LAUNCH_FEE_ETI) revert LaunchFeeTooHigh(newFee, MAX_LAUNCH_FEE_ETI);
        emit LaunchFeeEtiUpdated(launchFeeEti, newFee);
        launchFeeEti = newFee;
    }

    function setMinLpEtxAmount(uint256 newMin) external onlyOwner {
        emit MinLpEtxUpdated(minLpEtxAmount, newMin);
        minLpEtxAmount = newMin;
    }

    function setMinLpEtiAmount(uint256 newMin) external onlyOwner {
        emit MinLpEtiUpdated(minLpEtiAmount, newMin);
        minLpEtiAmount = newMin;
    }

    // --------------------------------------------------------------- launch

    /// @notice Launch a new token for a proposal. Caller MUST be the proposer
    ///         recorded in the Etica core contract for `proposalHash`. Prior
    ///         to calling, caller must approve this factory:
    ///         - ETX: `launchFeeEtx + lpEtxAmount`
    ///         - ETI: `launchFeeEti + lpEtiAmount`
    function launchProposalToken(LaunchParams calldata p)
        external
        nonReentrant
        returns (address token, address vesting)
    {
        _checkAuthorship(p.proposalHash);
        _checkParams(p);

        // Pull launch fees (ETX + ETI) straight to treasury in one go.
        etx.safeTransferFrom(msg.sender, treasury, launchFeeEtx);
        eti.safeTransferFrom(msg.sender, treasury, launchFeeEti);

        // Pull LP side capital into the factory (seeded into pools below).
        etx.safeTransferFrom(msg.sender, address(this), p.lpEtxAmount);
        eti.safeTransferFrom(msg.sender, address(this), p.lpEtiAmount);

        // Deploy token, factory owns full supply initially.
        token = address(
            new ProposalToken(
                p.name, p.symbol, p.totalSupply, p.proposalHash, msg.sender, address(this)
            )
        );

        // Split supply + distribute (vesting deploy + liquid transfer).
        uint256 lpEtxSupply = (p.totalSupply * LP_ETX_SUPPLY_BPS) / BPS_DENOMINATOR;
        uint256 lpEtiSupply = (p.totalSupply * LP_ETI_SUPPLY_BPS) / BPS_DENOMINATOR;
        vesting = _distributeAuthor(token, msg.sender, p.totalSupply, lpEtxSupply + lpEtiSupply);

        // Seed both pools through the router; LP tokens go to author.
        (uint256 usedTokenEtx, uint256 usedEtx) =
            _seedPool(token, msg.sender, address(etx), lpEtxSupply, p.lpEtxAmount, p.deadline);
        (uint256 usedTokenEti, uint256 usedEti) =
            _seedPool(token, msg.sender, address(eti), lpEtiSupply, p.lpEtiAmount, p.deadline);

        // Bookkeeping.
        proposalToToken[p.proposalHash] = token;
        proposalToVesting[p.proposalHash] = vesting;

        emit ProposalTokenLaunched(
            p.proposalHash,
            msg.sender,
            token,
            vesting,
            p.totalSupply,
            usedTokenEtx,
            usedEtx,
            usedTokenEti,
            usedEti
        );
    }

    // --------------------------------------------------------------- internal

    function _checkAuthorship(bytes32 proposalHash) internal view {
        (,,,,, address proposer,,,,) = eticaCore.proposals(proposalHash);
        if (proposer == address(0)) revert ProposalUnknown(proposalHash);
        if (proposer != msg.sender) revert NotProposalAuthor(msg.sender, proposer);
        if (proposalToToken[proposalHash] != address(0)) revert AlreadyLaunched(proposalHash);
    }

    function _checkParams(LaunchParams calldata p) internal view {
        if (p.totalSupply < BPS_DENOMINATOR) revert SupplyTooLow(p.totalSupply);
        if (p.lpEtxAmount < minLpEtxAmount) revert LpEtxTooLow(p.lpEtxAmount, minLpEtxAmount);
        if (p.lpEtiAmount < minLpEtiAmount) revert LpEtiTooLow(p.lpEtiAmount, minLpEtiAmount);
    }

    /// @dev Deploys vesting contract, transfers vested allocation in, and
    ///      sends the liquid author allocation straight to the proposer.
    function _distributeAuthor(
        address token,
        address author,
        uint256 totalSupply,
        uint256 totalLpSupply
    ) internal returns (address vesting) {
        uint256 vestSupply = (totalSupply * VEST_SUPPLY_BPS) / BPS_DENOMINATOR;
        uint256 liquidSupply = totalSupply - totalLpSupply - vestSupply;

        vesting = address(
            new ProposalTokenVesting(
                IERC20(token), author, uint64(block.timestamp), VEST_DURATION, vestSupply
            )
        );
        IERC20(token).safeTransfer(vesting, vestSupply);
        if (liquidSupply > 0) {
            IERC20(token).safeTransfer(author, liquidSupply);
        }
    }

    /// @dev Approves router, seeds a {token}/{hub} pool, refunds any dust,
    ///      and resets router allowances to zero.
    function _seedPool(
        address token,
        address author,
        address hub,
        uint256 lpTokenSupply,
        uint256 lpHubAmount,
        uint256 deadline
    ) internal returns (uint256 usedToken, uint256 usedHub) {
        // Pre-create the pair ourselves so msg.sender (the factory's
        // createPair caller) is this launchpad — which is in the swap
        // factory's trustedCreators set. Without this, router-initiated
        // pair creation would come from the router and fail the non-ETX
        // hub check for `token/ETI`.
        IEticaSwapFactoryLike swapFactory = IEticaSwapFactoryLike(router.factory());
        if (swapFactory.getPair(token, hub) == address(0)) {
            swapFactory.createPair(token, hub);
        }

        IERC20(token).forceApprove(address(router), lpTokenSupply);
        IERC20(hub).forceApprove(address(router), lpHubAmount);

        (usedToken, usedHub,) =
            router.addLiquidity(token, hub, lpTokenSupply, lpHubAmount, 0, 0, author, deadline);

        if (usedToken < lpTokenSupply) {
            IERC20(token).safeTransfer(author, lpTokenSupply - usedToken);
        }
        if (usedHub < lpHubAmount) {
            IERC20(hub).safeTransfer(author, lpHubAmount - usedHub);
        }
        IERC20(token).forceApprove(address(router), 0);
        IERC20(hub).forceApprove(address(router), 0);
    }
}
