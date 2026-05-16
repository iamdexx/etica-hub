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
/// @notice Gelato-ready ETX treasury autobuyer.
///
/// Two-signature launch flow:
///   1. Deploy this contract.
///   2. Treasury approves this contract for ETX.
///
/// The contract is unpaused at deploy so the ETX approval is the activation gate.
/// Before approval, {canExecute} and {checker} return false, so Gelato cannot run it.
/// The owner can still pause at any time.
///
/// Flow per cycle:
///   - Pull 1% of the treasury's current ETX balance via allowance.
///   - Split it equally across ETI, WEGAZ, and stETX.
///   - ETI leg: spend half buying ETI, pair with the other half ETX, mint LP to burn wallet.
///   - WEGAZ leg: spend half buying WEGAZ, pair with the other half ETX, mint LP to burn wallet.
///   - stETX leg: buy stETX, redeem 0.1% of acquired shares back into ETX to treasury,
///     then send the remaining stETX to treasury.
///
/// Gelato model:
///   - Gelato can call {executeCycle} every 45 minutes.
///   - {checker} returns the standard canExec + execPayload tuple for resolver tasks.
///   - The function remains permissionless; cooldown, allowance, balance checks, pause, and
///     slippage limits protect treasury funds regardless of caller.
contract TreasuryAutoBuyer is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant DEFAULT_INTERVAL = 45 minutes;
    uint256 public constant DEFAULT_SPEND_BPS = 100; // 1% of treasury ETX balance.
    uint256 public constant DEFAULT_STETX_REDEEM_BPS = 10; // 0.1% of acquired stETX.
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
    uint256 public lastExecutedAt;

    struct Limits {
        uint256 minEtiOut;
        uint256 minEgazOut;
        uint256 minStEtxOut;
        uint256 minEtiLp;
        uint256 minEgazLp;
    }

    event CycleExecuted(
        address indexed caller,
        uint256 treasuryEtxBalance,
        uint256 totalBudget,
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

    /// @notice Gelato resolver-compatible checker. Uses zero minOuts.
    /// @dev For production slippage, prefer Gelato Web3 Functions calling {executeCycle}
    ///      with computed {Limits}. This resolver exists as a simple schedule fallback.
    function checker() external view returns (bool canExec, bytes memory execPayload) {
        canExec = canExecute();
        execPayload = abi.encodeCall(this.executeCycle, (Limits(0, 0, 0, 0, 0)));
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

        uint256 perPool = budget / 3;
        uint256 etiBought = _buyAndBurnLp(etx, eti, perPool, limits.minEtiOut, limits.minEtiLp);
        uint256 egazBought = _buyAndBurnLp(etx, egaz, perPool, limits.minEgazOut, limits.minEgazLp);
        (uint256 stEtxBought, uint256 stEtxRedeemed, uint256 etxReturned) =
            _buyStEtxAndRedeem(perPool, limits.minStEtxOut);

        uint256 dust = etx.balanceOf(address(this));
        if (dust > 0) etx.safeTransfer(treasury, dust);

        lastExecutedAt = block.timestamp;

        emit CycleExecuted(
            msg.sender,
            treasuryBalance,
            budget,
            perPool,
            etiBought,
            egazBought,
            stEtxBought,
            stEtxRedeemed,
            etxReturned
        );
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

        uint256 quoteDust = quote.balanceOf(address(this));
        if (quoteDust > 0) quote.safeTransfer(treasury, quoteDust);
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

        uint256 remaining = stEtx.balanceOf(address(this));
        if (remaining > 0) stEtx.safeTransfer(treasury, remaining);
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
