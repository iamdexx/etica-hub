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

/// @title ProposalTokenFactory
/// @notice Creator-gated launchpad: only the wallet that authored a proposal
///         on the Etica core contract may launch a funding token for that
///         proposal, and only once. The factory deploys a fixed-supply
///         ERC-20 per proposal, splits the supply into a public LP allocation
///         (50%), a liquid author allocation (25%), and a linearly-vesting
///         author allocation (25%, 90 days), and seeds an initial X/ETX pool
///         with ETX provided by the author.
///
/// @dev    Because the swap factory enforces the hub-and-spoke invariant
///         (every pair must include ETX), launched tokens automatically
///         pair against ETX and become tradable via multi-hop routing.
///
///         The author must, prior to calling {launchProposalToken}, grant an
///         allowance on ETX to this contract of at least
///         `launchFeeEtx + lpEtxAmount`. The factory pulls both in one tx:
///         the fee goes to `treasury`, the LP amount is paired with
///         `LP_SUPPLY_BPS` of the new token and sent through the router.
contract ProposalTokenFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant LP_SUPPLY_BPS = 5_000;
    uint256 public constant VEST_SUPPLY_BPS = 2_500;
    uint256 public constant LIQUID_SUPPLY_BPS = 2_500;
    uint64 public constant VEST_DURATION = 90 days;

    IEticaCore public immutable eticaCore;
    IERC20 public immutable etx;
    IEticaSwapRouterLike public immutable router;

    address public treasury;
    uint256 public minLpEtxAmount;
    uint256 public launchFeeEtx;

    mapping(bytes32 => address) public proposalToToken;
    mapping(bytes32 => address) public proposalToVesting;

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event LaunchFeeUpdated(uint256 oldFee, uint256 newFee);
    event MinLpEtxUpdated(uint256 oldMin, uint256 newMin);
    event ProposalTokenLaunched(
        bytes32 indexed proposalHash,
        address indexed proposer,
        address indexed token,
        address vesting,
        uint256 totalSupply,
        uint256 lpTokenAmount,
        uint256 lpEtxAmount
    );

    error ZeroAddress();
    error NotProposalAuthor(address caller, address proposer);
    error ProposalUnknown(bytes32 proposalHash);
    error AlreadyLaunched(bytes32 proposalHash);
    error LpEtxTooLow(uint256 provided, uint256 minimum);
    error SupplyTooLow(uint256 totalSupply);

    struct LaunchParams {
        bytes32 proposalHash;
        string name;
        string symbol;
        uint256 totalSupply;
        uint256 lpEtxAmount;
        uint256 deadline;
    }

    constructor(
        IEticaCore eticaCore_,
        IERC20 etx_,
        IEticaSwapRouterLike router_,
        address treasury_,
        uint256 launchFeeEtx_,
        uint256 minLpEtxAmount_,
        address owner_
    ) Ownable(owner_) {
        if (
            address(eticaCore_) == address(0) || address(etx_) == address(0)
                || address(router_) == address(0) || treasury_ == address(0) || owner_ == address(0)
        ) revert ZeroAddress();
        eticaCore = eticaCore_;
        etx = etx_;
        router = router_;
        treasury = treasury_;
        launchFeeEtx = launchFeeEtx_;
        minLpEtxAmount = minLpEtxAmount_;
    }

    // --------------------------------------------------------------- admin

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setLaunchFeeEtx(uint256 newFee) external onlyOwner {
        emit LaunchFeeUpdated(launchFeeEtx, newFee);
        launchFeeEtx = newFee;
    }

    function setMinLpEtxAmount(uint256 newMin) external onlyOwner {
        emit MinLpEtxUpdated(minLpEtxAmount, newMin);
        minLpEtxAmount = newMin;
    }

    // --------------------------------------------------------------- launch

    /// @notice Launch a new token for a proposal. Caller MUST be the proposer
    ///         recorded in the Etica core contract for `proposalHash`. Prior
    ///         to calling, caller must approve this factory for
    ///         `launchFeeEtx + lpEtxAmount` on the ETX contract.
    function launchProposalToken(LaunchParams calldata p)
        external
        nonReentrant
        returns (address token, address vesting)
    {
        _checkAuthorship(p.proposalHash);
        _checkParams(p);

        // pull launch fee + LP ETX from caller in one go
        etx.safeTransferFrom(msg.sender, treasury, launchFeeEtx);
        etx.safeTransferFrom(msg.sender, address(this), p.lpEtxAmount);

        // deploy token, factory owns full supply initially
        token = address(
            new ProposalToken(
                p.name, p.symbol, p.totalSupply, p.proposalHash, msg.sender, address(this)
            )
        );

        // split supply + distribute (vesting deploy + liquid transfer)
        uint256 lpSupply = (p.totalSupply * LP_SUPPLY_BPS) / BPS_DENOMINATOR;
        vesting = _distributeAuthor(token, msg.sender, p.totalSupply, lpSupply);

        // seed LP through router, LP tokens go to author
        (uint256 usedToken, uint256 usedEtx) =
            _seedLiquidity(token, msg.sender, lpSupply, p.lpEtxAmount, p.deadline);

        // bookkeeping
        proposalToToken[p.proposalHash] = token;
        proposalToVesting[p.proposalHash] = vesting;

        emit ProposalTokenLaunched(
            p.proposalHash, msg.sender, token, vesting, p.totalSupply, usedToken, usedEtx
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
    }

    /// @dev Deploys vesting contract, transfers vested allocation in, and
    ///      sends the liquid author allocation straight to the proposer.
    function _distributeAuthor(address token, address author, uint256 totalSupply, uint256 lpSupply)
        internal
        returns (address vesting)
    {
        uint256 vestSupply = (totalSupply * VEST_SUPPLY_BPS) / BPS_DENOMINATOR;
        uint256 liquidSupply = totalSupply - lpSupply - vestSupply;

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

    /// @dev Approves router, seeds the {token}/ETX pool, refunds any dust,
    ///      and resets router allowances to zero.
    function _seedLiquidity(
        address token,
        address author,
        uint256 lpSupply,
        uint256 lpEtxAmount,
        uint256 deadline
    ) internal returns (uint256 usedToken, uint256 usedEtx) {
        IERC20(token).forceApprove(address(router), lpSupply);
        etx.forceApprove(address(router), lpEtxAmount);

        (usedToken, usedEtx,) =
            router.addLiquidity(token, address(etx), lpSupply, lpEtxAmount, 0, 0, author, deadline);

        if (usedToken < lpSupply) {
            IERC20(token).safeTransfer(author, lpSupply - usedToken);
        }
        if (usedEtx < lpEtxAmount) {
            etx.safeTransfer(author, lpEtxAmount - usedEtx);
        }
        IERC20(token).forceApprove(address(router), 0);
        etx.forceApprove(address(router), 0);
    }
}
