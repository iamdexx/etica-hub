// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IEticaSwapRouterLike {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function swapExactTokensForEGAZ(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

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

interface IERC4626Like is IERC20 {
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

/// @title TreasuryAutoBuyer
/// @notice Cron/keeper-ready ETX treasury autobuyer.
///
/// Launch flow:
///   1. Deploy this contract.
///   2. Treasury approves this contract for ETX.
///   3. A low-risk keeper wallet calls {executeCycle}; the contract reimburses
///      the keeper in native EGAZ from a capped ETX slice on successful cycles.
///
/// The keeper cannot change config, redirect funds, bypass cooldowns, or withdraw
/// treasury funds. It can only trigger this fixed buyback path once eligible.
contract TreasuryAutoBuyer is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant DEFAULT_INTERVAL = 45 minutes;
    uint256 public constant DEFAULT_SPEND_BPS = 100; // 1% of treasury ETX balance.
    uint256 public constant DEFAULT_STETX_REDEEM_BPS = 10; // 0.1% of acquired stETX.
    uint256 public constant DEFAULT_KEEPER_REWARD_BPS = 5; // 0.05% of each cycle budget.
    uint256 public constant MAX_KEEPER_REWARD_BPS = 50; // Max 0.5% of each cycle budget.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable treasury;
    IERC20 public immutable etx;
    IERC20 public immutable eti;
    IERC20 public immutable egaz;
    IERC4626Like public immutable stEtx;
    IEticaSwapRouterLike public immutable router;

    address public burnWallet;
    uint256 public intervalSeconds;
    uint256 public spendBps;
    uint256 public stEtxRedeemBps;
    uint256 public keeperRewardBps;
    uint256 public lastExecutedAt;

    struct Limits {
        uint256 minEtiOut;
        uint256 minEgazOut;
        uint256 minStEtxOut;
        uint256 minEtiLp;
        uint256 minEgazLp;
        uint256 minKeeperEgazOut;
    }

    event CycleExecuted(
        address indexed caller,
        uint256 treasuryEtxBalance,
        uint256 totalBudget,
        uint256 keeperRewardEtx,
        uint256 keeperRewardEgaz,
        uint256 perPoolBudget,
        uint256 etiBought,
        uint256 egazBought,
        uint256 stEtxBought,
        uint256 stEtxRedeemed,
        uint256 etxReturnedFromRedeem
    );
    event BurnWalletUpdated(address indexed burnWallet);
    event IntervalUpdated(uint256 intervalSeconds);
    event SpendBpsUpdated(uint256 spendBps);
    event StEtxRedeemBpsUpdated(uint256 stEtxRedeemBps);
    event KeeperRewardBpsUpdated(uint256 keeperRewardBps);

    error ZeroAddress();
    error TooEarly(uint256 nextAllowedAt);
    error InvalidBps();
    error InsufficientBudget();
    error TreasuryAllowanceTooLow(uint256 allowance, uint256 required);
    error TreasuryBalanceTooLow(uint256 balance, uint256 required);

    constructor(
        address owner_,
        address treasury_,
        address burnWallet_,
        address etx_,
        address eti_,
        address egaz_,
        address stEtx_,
        address router_
    ) Ownable(owner_) {
        if (
            owner_ == address(0) || treasury_ == address(0) || burnWallet_ == address(0)
                || etx_ == address(0) || eti_ == address(0) || egaz_ == address(0)
                || stEtx_ == address(0) || router_ == address(0)
        ) revert ZeroAddress();

        treasury = treasury_;
        burnWallet = burnWallet_;
        etx = IERC20(etx_);
        eti = IERC20(eti_);
        egaz = IERC20(egaz_);
        stEtx = IERC4626Like(stEtx_);
        router = IEticaSwapRouterLike(router_);

        intervalSeconds = DEFAULT_INTERVAL;
        spendBps = DEFAULT_SPEND_BPS;
        stEtxRedeemBps = DEFAULT_STETX_REDEEM_BPS;
        keeperRewardBps = DEFAULT_KEEPER_REWARD_BPS;
    }

    function canExecute() public view returns (bool) {
        if (paused()) return false;
        if (block.timestamp < lastExecutedAt + intervalSeconds) return false;
        uint256 treasuryBalance = etx.balanceOf(treasury);
        uint256 budget = (treasuryBalance * spendBps) / BPS;
        if (budget < 9) return false;
        if (etx.allowance(treasury, address(this)) < budget) return false;
        return true;
    }

    function checker() external view returns (bool canExec, bytes memory execPayload) {
        canExec = canExecute();
        execPayload = abi.encodeCall(this.executeCycle, (Limits(0, 0, 0, 0, 0, 0)));
    }

    function executeCycle(Limits memory limits) public whenNotPaused nonReentrant {
        if (block.timestamp < lastExecutedAt + intervalSeconds) {
            revert TooEarly(lastExecutedAt + intervalSeconds);
        }

        uint256 treasuryBalance = etx.balanceOf(treasury);
        uint256 budget = (treasuryBalance * spendBps) / BPS;
        if (budget < 9) revert InsufficientBudget();
        if (treasuryBalance < budget) revert TreasuryBalanceTooLow(treasuryBalance, budget);

        uint256 allowance = etx.allowance(treasury, address(this));
        if (allowance < budget) revert TreasuryAllowanceTooLow(allowance, budget);

        etx.safeTransferFrom(treasury, address(this), budget);

        uint256 keeperRewardEtx = (budget * keeperRewardBps) / BPS;
        uint256 keeperRewardEgaz = 0;
        if (keeperRewardEtx > 0) {
            keeperRewardEgaz = _payKeeperReward(keeperRewardEtx, limits.minKeeperEgazOut);
        }

        uint256 buyBudget = budget - keeperRewardEtx;
        uint256 perPool = buyBudget / 3;
        uint256 etiBought = _buyAndBurnLp(etx, eti, perPool, limits.minEtiOut, limits.minEtiLp);
        uint256 egazBought = _buyAndBurnLp(etx, egaz, perPool, limits.minEgazOut, limits.minEgazLp);
        (uint256 stEtxBought, uint256 stEtxRedeemed, uint256 etxReturned) =
            _buyStEtxAndRedeem(perPool, limits.minStEtxOut);

        _forwardDustToTreasury();
        lastExecutedAt = block.timestamp;

        emit CycleExecuted(
            msg.sender,
            treasuryBalance,
            budget,
            keeperRewardEtx,
            keeperRewardEgaz,
            perPool,
            etiBought,
            egazBought,
            stEtxBought,
            stEtxRedeemed,
            etxReturned
        );
    }

    function _payKeeperReward(uint256 amountIn, uint256 minEgazOut) internal returns (uint256 paid) {
        address[] memory path = new address[](2);
        path[0] = address(etx);
        path[1] = address(egaz);

        etx.forceApprove(address(router), amountIn);
        uint256[] memory amounts = router.swapExactTokensForEGAZ(
            amountIn,
            minEgazOut,
            path,
            msg.sender,
            block.timestamp
        );
        paid = amounts[amounts.length - 1];
    }

    function _buyAndBurnLp(
        IERC20 base,
        IERC20 quote,
        uint256 poolBudget,
        uint256 minTokenOut,
        uint256 minLp
    ) internal returns (uint256 bought) {
        uint256 swapAmount = poolBudget / 2;
        uint256 pairAmount = poolBudget - swapAmount;

        address[] memory path = new address[](2);
        path[0] = address(base);
        path[1] = address(quote);

        base.forceApprove(address(router), swapAmount);
        uint256[] memory amounts = router.swapExactTokensForTokens(
            swapAmount,
            minTokenOut,
            path,
            address(this),
            block.timestamp
        );
        bought = amounts[amounts.length - 1];

        base.forceApprove(address(router), pairAmount);
        quote.forceApprove(address(router), bought);
        (,, uint256 liquidity) = router.addLiquidity(
            address(base),
            address(quote),
            pairAmount,
            bought,
            0,
            0,
            burnWallet,
            block.timestamp
        );
        if (liquidity < minLp) revert InsufficientBudget();
    }

    function _buyStEtxAndRedeem(uint256 amountIn, uint256 minStEtxOut)
        internal
        returns (uint256 bought, uint256 redeemedShares, uint256 assetsReturned)
    {
        address[] memory path = new address[](2);
        path[0] = address(etx);
        path[1] = address(stEtx);

        etx.forceApprove(address(router), amountIn);
        uint256[] memory amounts = router.swapExactTokensForTokens(
            amountIn,
            minStEtxOut,
            path,
            address(this),
            block.timestamp
        );
        bought = amounts[amounts.length - 1];

        redeemedShares = (bought * stEtxRedeemBps) / BPS;
        if (redeemedShares > 0) {
            assetsReturned = stEtx.redeem(redeemedShares, treasury, address(this));
        }
    }

    function _forwardDustToTreasury() internal {
        uint256 etxDust = etx.balanceOf(address(this));
        if (etxDust > 0) etx.safeTransfer(treasury, etxDust);

        uint256 etiDust = eti.balanceOf(address(this));
        if (etiDust > 0) eti.safeTransfer(treasury, etiDust);

        uint256 egazDust = egaz.balanceOf(address(this));
        if (egazDust > 0) egaz.safeTransfer(treasury, egazDust);

        uint256 stEtxDust = stEtx.balanceOf(address(this));
        if (stEtxDust > 0) stEtx.safeTransfer(treasury, stEtxDust);
    }

    function setBurnWallet(address newBurnWallet) external onlyOwner {
        if (newBurnWallet == address(0)) revert ZeroAddress();
        burnWallet = newBurnWallet;
        emit BurnWalletUpdated(newBurnWallet);
    }

    function setIntervalSeconds(uint256 newIntervalSeconds) external onlyOwner {
        if (newIntervalSeconds < 5 minutes || newIntervalSeconds > 7 days) revert InsufficientBudget();
        intervalSeconds = newIntervalSeconds;
        emit IntervalUpdated(newIntervalSeconds);
    }

    function setSpendBps(uint256 newSpendBps) external onlyOwner {
        if (newSpendBps == 0 || newSpendBps > 100) revert InvalidBps();
        spendBps = newSpendBps;
        emit SpendBpsUpdated(newSpendBps);
    }

    function setStEtxRedeemBps(uint256 newRedeemBps) external onlyOwner {
        if (newRedeemBps > 1_000) revert InvalidBps();
        stEtxRedeemBps = newRedeemBps;
        emit StEtxRedeemBpsUpdated(newRedeemBps);
    }

    function setKeeperRewardBps(uint256 newKeeperRewardBps) external onlyOwner {
        if (newKeeperRewardBps > MAX_KEEPER_REWARD_BPS) revert InvalidBps();
        keeperRewardBps = newKeeperRewardBps;
        emit KeeperRewardBpsUpdated(newKeeperRewardBps);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }
}
