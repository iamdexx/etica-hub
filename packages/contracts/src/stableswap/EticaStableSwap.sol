// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title EticaStableSwap — rate-aware Curve-style stableswap for stETX/ETX
/// @notice A single-pair AMM specialised for a yielding-stable pair where one
///         leg (stETX) accrues NAV in terms of the other leg (ETX) via an
///         ERC-4626 vault. The pool reads `stETX.convertToAssets(1e18)` to
///         re-anchor liquidity at the live NAV on every quote and swap, so the
///         peg is always at the true exchange rate and never drifts out of
///         range as stETX yield compounds.
///
///         Math:
///           Curve's "stable swap" invariant on virtual balances:
///
///             A·n^n·sum(xp) + D = A·n^n·D + D^(n+1) / (n^n · prod(xp))
///
///           with n = 2 (two coins). Virtual balances are:
///
///             xp[0] = reserveEtx                        (raw, ETX is the unit)
///             xp[1] = reserveStEtx · rate / 1e18         (stETX → ETX-equivalent)
///
///           where rate = stETX.convertToAssets(1e18). All math operates in
///           ETX-denominated "xp space"; raw stETX amounts are translated in
///           and out of xp space at the live NAV at the instant of the call.
///
///         Fees:
///           Total swap fee:     `swapFeeBps`     (default 4 bps = 0.04%)
///           Admin slice of fee: `adminFeeBps`    (default 5000 = 50% of fee)
///
///           - Fee is taken from the gross output of every swap.
///           - The admin slice accumulates in a separate accumulator (not
///             part of pool reserves) and is permissionlessly skimmed by
///             {claimAdminFees}, sent to {adminFeeRecipient}. The recipient
///             defaults to {StableSwapHarvesterAdapter} which routes through
///             the existing TreasuryHarvester (10/10/40/40 split). Setting
///             the recipient is owner-gated (treasury timelock).
///           - The non-admin slice of the fee remains in the pool reserves,
///             permanently growing every LP share's value (treasury and
///             public LPs alike).
///
///         Liquidity:
///           - LP shares are an internal ERC-20 (with EIP-2612 permit) so
///             they are composable: anyone can transfer, list, or stake them.
///           - Initial deposit must use balanced amounts at NAV; subsequent
///             deposits accept arbitrary amounts and price the imbalance via
///             the invariant.
///           - {removeLiquidity} burns shares pro-rata at current reserves
///             (no slippage). {removeLiquidityOneCoin} converts a share burn
///             to a single asset via the invariant (slippage-aware).
///           - There is no lock at the pool level. The 10-year lock on the
///             treasury's seed lives in {LiquidityTimelock10y}; from the
///             pool's view that contract is just an LP-share holder.
///
///         A-coefficient ramping:
///           Same shape as Curve: linear interpolation between (initialA,
///           initialATime) and (futureA, futureATime). Ramps are bounded by
///           {MIN_RAMP_TIME} and {MAX_A_CHANGE} so a single owner cannot
///           rugged-pull liquidity by spiking A under a swap.
contract EticaStableSwap is ERC20Permit, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint256 internal constant N_COINS = 2;
    uint256 internal constant A_PRECISION = 100;
    uint256 internal constant FEE_DENOMINATOR = 10_000;
    uint256 internal constant PRECISION = 1e18;

    /// @notice Maximum A coefficient (Curve uses 1_000_000). Higher = tighter
    ///         peg but more sensitive to NAV / balance shifts. We allow up
    ///         to the same ceiling Curve uses; governance is expected to
    ///         stay well below it.
    uint256 internal constant MAX_A = 1_000_000;

    /// @notice Maximum multiplicative change per ramp. A may move at most
    ///         10x up or 1/10 down within a single ramp window.
    uint256 internal constant MAX_A_CHANGE = 10;

    /// @notice Minimum ramp duration. Forces governance to spread A changes
    ///         over time; LPs can react and exit before A finishes moving.
    uint256 internal constant MIN_RAMP_TIME = 1 days;

    /// @notice Hard cap on swap fee (1%). Defends against owner setting an
    ///         absurd fee mid-flight that would tax users.
    uint16 internal constant MAX_SWAP_FEE_BPS = 100;

    /// @notice Hard cap on admin fee share of swap fee (100%).
    uint16 internal constant MAX_ADMIN_FEE_BPS = 10_000;

    /// @notice Initial LP shares minted on first deposit, sent to address(0)
    ///         to permanently lock supply against share-price-zero attacks.
    uint256 internal constant MINIMUM_LIQUIDITY = 1000;

    // -------------------------------------------------------------------------
    // Immutable assets
    // -------------------------------------------------------------------------

    /// @notice ETX token (token0). Unit of account for invariant math.
    IERC20 public immutable etx;

    /// @notice stETX vault token (token1). Rate-aware leg; pool reads its
    ///         NAV via {IERC4626.convertToAssets}.
    IERC4626 public immutable stEtx;

    // -------------------------------------------------------------------------
    // Reserves (active liquidity used in invariant math)
    // -------------------------------------------------------------------------

    /// @notice Active ETX liquidity (excludes accumulated admin fees).
    uint128 public reserveEtx;

    /// @notice Active stETX liquidity (excludes accumulated admin fees).
    uint128 public reserveStEtx;

    /// @notice Admin-fee accumulator, ETX leg. Skimmed by {claimAdminFees}.
    uint128 public adminFeeEtx;

    /// @notice Admin-fee accumulator, stETX leg. Skimmed by {claimAdminFees}.
    uint128 public adminFeeStEtx;

    // -------------------------------------------------------------------------
    // Fee parameters
    // -------------------------------------------------------------------------

    /// @notice Total swap fee in basis points (1 bp = 0.01%). Default 4 bp.
    uint16 public swapFeeBps;

    /// @notice Admin slice of the swap fee in basis points of the fee
    ///         (NOT of the trade size). Default 5000 = 50% of the fee.
    uint16 public adminFeeBps;

    /// @notice Address that receives accumulated admin fees on
    ///         {claimAdminFees}. Defaults to a harvester adapter that routes
    ///         through the existing 10/10/40/40 TreasuryHarvester pipeline.
    address public adminFeeRecipient;

    // -------------------------------------------------------------------------
    // A-coefficient ramping
    // -------------------------------------------------------------------------

    /// @notice A at the start of the current ramp window, scaled by A_PRECISION.
    uint256 public initialA;

    /// @notice A at the end of the current ramp window, scaled by A_PRECISION.
    uint256 public futureA;

    /// @notice Unix timestamp of ramp window start.
    uint256 public initialATime;

    /// @notice Unix timestamp of ramp window end.
    uint256 public futureATime;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event TokenSwap(
        address indexed buyer,
        uint256 tokensSold,
        uint256 tokensBought,
        uint128 soldId,
        uint128 boughtId
    );
    event AddLiquidity(
        address indexed provider, uint256 amountEtx, uint256 amountStEtx, uint256 lpMinted
    );
    event RemoveLiquidity(
        address indexed provider, uint256 amountEtx, uint256 amountStEtx, uint256 lpBurned
    );
    event RemoveLiquidityOne(
        address indexed provider, uint256 lpBurned, uint128 boughtId, uint256 amountReceived
    );
    event AdminFeesClaimed(address indexed recipient, uint256 amountEtx, uint256 amountStEtx);
    event SwapFeeUpdated(uint16 newSwapFeeBps);
    event AdminFeeUpdated(uint16 newAdminFeeBps);
    event AdminFeeRecipientUpdated(address indexed newRecipient);
    event RampA(uint256 oldA, uint256 newA, uint256 startTime, uint256 endTime);
    event StopRampA(uint256 currentA, uint256 stopTime);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error InvalidIndex();
    error InvalidA();
    error RampTooFast(uint256 requested, uint256 max);
    error RampTooSoon(uint256 nowTime, uint256 nextAllowedAt);
    error RampWindowTooShort(uint256 requested, uint256 minimum);
    error SwapFeeTooHigh(uint16 requested, uint16 maximum);
    error AdminFeeTooHigh(uint16 requested, uint16 maximum);
    error InvariantNotConverged();
    error MinAmountNotMet(uint256 received, uint256 minimum);
    error InitialDepositImbalanced();
    error TokenIdenticalAddresses();
    error AssetMismatch();

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    /// @param _etx     ETX token (must be the underlying asset of `_stEtx`).
    /// @param _stEtx   stETX ERC-4626 vault.
    /// @param _ampInit Initial A coefficient (real-valued, NOT scaled).
    ///                 e.g. pass 200 for A = 200; stored internally as 20_000.
    /// @param _owner   Treasury timelock / multisig that can ramp A and
    ///                 update fee parameters and the admin recipient.
    constructor(IERC20 _etx, IERC4626 _stEtx, uint256 _ampInit, address _owner)
        ERC20("EticaStableSwap stETX/ETX LP", "esLP")
        ERC20Permit("EticaStableSwap stETX/ETX LP")
        Ownable(_owner)
    {
        if (address(_etx) == address(0) || address(_stEtx) == address(0)) revert ZeroAddress();
        if (address(_etx) == address(_stEtx)) revert TokenIdenticalAddresses();
        // Enforce that stETX's underlying really is ETX. This is the entire
        // semantic basis of the rate-aware design — without it the rate
        // function would return nonsense.
        if (_stEtx.asset() != address(_etx)) revert AssetMismatch();
        if (_ampInit == 0 || _ampInit * A_PRECISION > MAX_A) revert InvalidA();

        etx = _etx;
        stEtx = _stEtx;

        uint256 ampScaled = _ampInit * A_PRECISION;
        initialA = ampScaled;
        futureA = ampScaled;
        initialATime = block.timestamp;
        futureATime = block.timestamp;

        swapFeeBps = 4; // 0.04%
        adminFeeBps = 5_000; // 50% of the fee accrues to admin
    }

    // -------------------------------------------------------------------------
    // Public views
    // -------------------------------------------------------------------------

    /// @notice ETX redeemable per 1e18 stETX, read live from the vault.
    function getRate() public view returns (uint256) {
        return stEtx.convertToAssets(PRECISION);
    }

    /// @notice Current A coefficient (linearly interpolated within the ramp
    ///         window). Returned scaled by {A_PRECISION}.
    function getA() public view returns (uint256) {
        return _getA();
    }

    /// @notice Current virtual balances (ETX-denominated). xp[0] is the raw
    ///         ETX reserve; xp[1] is the stETX reserve translated through
    ///         the live vault rate.
    function getVirtualBalances() public view returns (uint256[2] memory xp) {
        xp[0] = uint256(reserveEtx);
        xp[1] = (uint256(reserveStEtx) * getRate()) / PRECISION;
    }

    /// @notice Total ETX-equivalent value of all pool reserves (excludes
    ///         accumulated admin fees).
    function totalValueInEtx() external view returns (uint256) {
        uint256[2] memory xp = getVirtualBalances();
        return xp[0] + xp[1];
    }

    /// @notice Output of swapping `dx` of token `i` into token `j`, after
    ///         total fee. View-only; uses the live rate.
    function getDy(uint128 i, uint128 j, uint256 dx) public view returns (uint256) {
        if (i == j) revert InvalidIndex();
        if (i >= N_COINS || j >= N_COINS) revert InvalidIndex();
        uint256[2] memory xp = getVirtualBalances();
        uint256 rate = getRate();

        // Translate input dx into xp space.
        uint256 dxXp = (i == 0) ? dx : (dx * rate) / PRECISION;
        uint256 xNew = xp[i] + dxXp;
        uint256 yNew = _getY(i, j, xNew, xp, _getA());
        // Output before fee, in xp space.
        uint256 dyXp;
        unchecked {
            // _getY guarantees xp[j] >= yNew + 1 for any positive dx.
            dyXp = xp[j] - yNew - 1;
        }
        // Apply total swap fee.
        uint256 fee = (dyXp * swapFeeBps) / FEE_DENOMINATOR;
        uint256 dyXpAfterFee = dyXp - fee;

        // Translate back to raw token units.
        return (j == 0) ? dyXpAfterFee : (dyXpAfterFee * PRECISION) / rate;
    }

    /// @notice Estimated LP shares minted for an unbalanced deposit of
    ///         (`amountEtx`, `amountStEtx`). View-only.
    function calcAddLiquidity(uint256 amountEtx, uint256 amountStEtx)
        external
        view
        returns (uint256 lp)
    {
        return _calcLp(amountEtx, amountStEtx, true);
    }

    /// @notice Tokens redeemed for `lpAmount` shares burned pro-rata.
    function calcRemoveLiquidity(uint256 lpAmount)
        external
        view
        returns (uint256 amountEtx, uint256 amountStEtx)
    {
        uint256 supply = totalSupply();
        amountEtx = (uint256(reserveEtx) * lpAmount) / supply;
        amountStEtx = (uint256(reserveStEtx) * lpAmount) / supply;
    }

    // -------------------------------------------------------------------------
    // Liquidity
    // -------------------------------------------------------------------------

    /// @notice Add liquidity. First deposit must be at NAV-balanced amounts;
    ///         subsequent deposits may be unbalanced.
    /// @param amountEtx     ETX to deposit (raw token units).
    /// @param amountStEtx   stETX to deposit (raw token units).
    /// @param minMintAmount Reverts if fewer LP shares would be minted.
    /// @param to            LP-share recipient.
    function addLiquidity(uint256 amountEtx, uint256 amountStEtx, uint256 minMintAmount, address to)
        external
        nonReentrant
        returns (uint256 lp)
    {
        if (to == address(0)) revert ZeroAddress();
        if (amountEtx == 0 && amountStEtx == 0) revert ZeroAmount();

        uint256 supply = totalSupply();
        if (supply == 0) {
            // Initial deposit: mint xp-sum LP shares; require NAV-balanced
            // amounts so the curve starts exactly at peg.
            uint256 rate = getRate();
            uint256 xp0 = amountEtx;
            uint256 xp1 = (amountStEtx * rate) / PRECISION;
            if (xp0 == 0 || xp1 == 0) revert InitialDepositImbalanced();
            // Tolerance: enforce within 1% of balanced. Stricter than V2
            // (which lets first depositor pick any ratio) — the rate-aware
            // curve really needs to start at peg or the first swap will be
            // mis-priced.
            uint256 imbalance =
                (xp0 > xp1) ? ((xp0 - xp1) * 10_000) / xp0 : ((xp1 - xp0) * 10_000) / xp1;
            if (imbalance > 100) revert InitialDepositImbalanced();
            lp = xp0 + xp1;
        } else {
            lp = _calcLp(amountEtx, amountStEtx, false);
        }

        if (lp < minMintAmount) revert MinAmountNotMet(lp, minMintAmount);

        // Pull tokens.
        if (amountEtx != 0) {
            etx.safeTransferFrom(msg.sender, address(this), amountEtx);
            reserveEtx += uint128(amountEtx);
        }
        if (amountStEtx != 0) {
            IERC20(address(stEtx)).safeTransferFrom(msg.sender, address(this), amountStEtx);
            reserveStEtx += uint128(amountStEtx);
        }

        if (supply == 0) {
            // Burn MINIMUM_LIQUIDITY to address(0).
            _mint(address(0xdead), MINIMUM_LIQUIDITY);
            unchecked {
                lp -= MINIMUM_LIQUIDITY;
            }
        }

        _mint(to, lp);
        emit AddLiquidity(msg.sender, amountEtx, amountStEtx, lp);
    }

    /// @notice Burn `lpAmount` shares for a pro-rata slice of both reserves.
    ///         No slippage, no curve math — strictly proportional.
    function removeLiquidity(uint256 lpAmount, uint256 minEtx, uint256 minStEtx, address to)
        external
        nonReentrant
        returns (uint256 amountEtx, uint256 amountStEtx)
    {
        if (to == address(0)) revert ZeroAddress();
        if (lpAmount == 0) revert ZeroAmount();
        uint256 supply = totalSupply();

        amountEtx = (uint256(reserveEtx) * lpAmount) / supply;
        amountStEtx = (uint256(reserveStEtx) * lpAmount) / supply;
        if (amountEtx < minEtx) revert MinAmountNotMet(amountEtx, minEtx);
        if (amountStEtx < minStEtx) revert MinAmountNotMet(amountStEtx, minStEtx);

        _burn(msg.sender, lpAmount);
        reserveEtx -= uint128(amountEtx);
        reserveStEtx -= uint128(amountStEtx);

        if (amountEtx != 0) etx.safeTransfer(to, amountEtx);
        if (amountStEtx != 0) IERC20(address(stEtx)).safeTransfer(to, amountStEtx);

        emit RemoveLiquidity(msg.sender, amountEtx, amountStEtx, lpAmount);
    }

    /// @notice Burn `lpAmount` shares for a single asset, priced via the
    ///         invariant (slippage-aware). Charges the swap fee on the
    ///         imbalance leg only.
    function removeLiquidityOneCoin(uint128 i, uint256 lpAmount, uint256 minAmount, address to)
        external
        nonReentrant
        returns (uint256 amount)
    {
        if (to == address(0)) revert ZeroAddress();
        if (lpAmount == 0) revert ZeroAmount();
        if (i >= N_COINS) revert InvalidIndex();

        // Compute (dyXpAfterFee, adminXp) under target D = d0 · (1 - lp/supply).
        (uint256 dyXpAfterFee, uint256 adminXp) = _calcOneCoin(i, lpAmount);

        uint256 rate = getRate();
        amount = (i == 0) ? dyXpAfterFee : (dyXpAfterFee * PRECISION) / rate;
        if (amount < minAmount) revert MinAmountNotMet(amount, minAmount);

        _burn(msg.sender, lpAmount);
        _settleOutput(i, amount, adminXp, rate, to);
        emit RemoveLiquidityOne(msg.sender, lpAmount, i, amount);
    }

    /// @dev Helper: compute the after-fee output (in xp space) and admin
    ///      slice (in xp space) for a one-coin redemption of `lpAmount`
    ///      shares of token `i`.
    function _calcOneCoin(uint128 i, uint256 lpAmount)
        internal
        view
        returns (uint256 dyXpAfterFee, uint256 adminXp)
    {
        uint256 amp = _getA();
        uint256[2] memory xp = getVirtualBalances();
        uint256 d0 = _getD(xp, amp);
        uint256 d1 = d0 - (d0 * lpAmount) / totalSupply();
        uint256 newY = _getYD(i, xp, amp, d1);
        uint256 dyXp;
        unchecked {
            dyXp = xp[i] - newY - 1;
        }
        uint256 fee = (dyXp * swapFeeBps) / FEE_DENOMINATOR;
        adminXp = (fee * adminFeeBps) / FEE_DENOMINATOR;
        dyXpAfterFee = dyXp - fee;
    }

    /// @dev Helper: settle user payout + admin accumulator after a swap or
    ///      one-coin redemption. `amount` is in raw token-`i` units;
    ///      `adminXp` is in xp space.
    function _settleOutput(uint128 i, uint256 amount, uint256 adminXp, uint256 rate, address to)
        internal
    {
        if (i == 0) {
            uint128 totalOut = uint128(amount + adminXp);
            reserveEtx -= totalOut;
            adminFeeEtx += uint128(adminXp);
            etx.safeTransfer(to, amount);
        } else {
            uint256 adminRaw = (adminXp * PRECISION) / rate;
            uint128 totalOut = uint128(amount + adminRaw);
            reserveStEtx -= totalOut;
            adminFeeStEtx += uint128(adminRaw);
            IERC20(address(stEtx)).safeTransfer(to, amount);
        }
    }

    // -------------------------------------------------------------------------
    // Swap
    // -------------------------------------------------------------------------

    /// @notice Swap `dx` of token `i` for at least `minDy` of token `j`.
    /// @param i      Index of input token (0=ETX, 1=stETX).
    /// @param j      Index of output token (0=ETX, 1=stETX).
    /// @param dx     Input amount in raw token units of token `i`.
    /// @param minDy  Reverts if output < this.
    /// @param to     Output recipient.
    function swap(uint128 i, uint128 j, uint256 dx, uint256 minDy, address to)
        external
        nonReentrant
        returns (uint256 dy)
    {
        if (i == j) revert InvalidIndex();
        if (i >= N_COINS || j >= N_COINS) revert InvalidIndex();
        if (dx == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        _pullInput(i, dx);

        uint256 rate = getRate();
        (uint256 dyXpAfterFee, uint256 adminXp) = _calcSwap(i, j, dx, rate);
        dy = (j == 0) ? dyXpAfterFee : (dyXpAfterFee * PRECISION) / rate;
        if (dy < minDy) revert MinAmountNotMet(dy, minDy);

        _settleOutput(j, dy, adminXp, rate, to);
        emit TokenSwap(msg.sender, dx, dy, i, j);
    }

    /// @dev Helper: pull input tokens into the pool and bump reserves.
    function _pullInput(uint128 i, uint256 dx) internal {
        if (i == 0) {
            etx.safeTransferFrom(msg.sender, address(this), dx);
            reserveEtx += uint128(dx);
        } else {
            IERC20(address(stEtx)).safeTransferFrom(msg.sender, address(this), dx);
            reserveStEtx += uint128(dx);
        }
    }

    /// @dev Helper: compute (dyXpAfterFee, adminXp) for a swap with the
    ///      input already settled into the pool's xp-space view.
    function _calcSwap(uint128 i, uint128 j, uint256 dx, uint256 rate)
        internal
        view
        returns (uint256 dyXpAfterFee, uint256 adminXp)
    {
        // Reconstruct the pre-input xp from CURRENT reserves (post-pull) and
        // the input amount: pre = post − dx. Cheaper than a second SLOAD set.
        uint256[2] memory xp;
        xp[0] = uint256(reserveEtx);
        xp[1] = (uint256(reserveStEtx) * rate) / PRECISION;
        if (i == 0) xp[0] -= dx;
        else xp[1] -= (dx * rate) / PRECISION;

        uint256 dxXp = (i == 0) ? dx : (dx * rate) / PRECISION;
        uint256 yNew = _getY(i, j, xp[i] + dxXp, xp, _getA());
        uint256 dyXp;
        unchecked {
            dyXp = xp[j] - yNew - 1;
        }
        uint256 fee = (dyXp * swapFeeBps) / FEE_DENOMINATOR;
        adminXp = (fee * adminFeeBps) / FEE_DENOMINATOR;
        dyXpAfterFee = dyXp - fee;
    }

    // -------------------------------------------------------------------------
    // Admin fees
    // -------------------------------------------------------------------------

    /// @notice Sweep accumulated admin fees to {adminFeeRecipient}.
    ///         Permissionless: anyone may call. The recipient address is
    ///         owner-set so there is no exfiltration risk from open access.
    function claimAdminFees() external nonReentrant returns (uint256 outEtx, uint256 outStEtx) {
        address to = adminFeeRecipient;
        if (to == address(0)) revert ZeroAddress();
        outEtx = uint256(adminFeeEtx);
        outStEtx = uint256(adminFeeStEtx);
        adminFeeEtx = 0;
        adminFeeStEtx = 0;
        if (outEtx != 0) etx.safeTransfer(to, outEtx);
        if (outStEtx != 0) IERC20(address(stEtx)).safeTransfer(to, outStEtx);
        emit AdminFeesClaimed(to, outEtx, outStEtx);
    }

    // -------------------------------------------------------------------------
    // Owner controls
    // -------------------------------------------------------------------------

    function setSwapFee(uint16 newSwapFeeBps) external onlyOwner {
        if (newSwapFeeBps > MAX_SWAP_FEE_BPS) {
            revert SwapFeeTooHigh(newSwapFeeBps, MAX_SWAP_FEE_BPS);
        }
        swapFeeBps = newSwapFeeBps;
        emit SwapFeeUpdated(newSwapFeeBps);
    }

    function setAdminFee(uint16 newAdminFeeBps) external onlyOwner {
        if (newAdminFeeBps > MAX_ADMIN_FEE_BPS) {
            revert AdminFeeTooHigh(newAdminFeeBps, MAX_ADMIN_FEE_BPS);
        }
        adminFeeBps = newAdminFeeBps;
        emit AdminFeeUpdated(newAdminFeeBps);
    }

    function setAdminFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        adminFeeRecipient = newRecipient;
        emit AdminFeeRecipientUpdated(newRecipient);
    }

    /// @notice Begin a linear ramp of A from its current value to `newAreal`
    ///         over the window `[block.timestamp, endTime]`. `newAreal` is
    ///         the real (unscaled) target; it is multiplied by A_PRECISION
    ///         internally.
    function rampA(uint256 newAreal, uint256 endTime) external onlyOwner {
        // Ramp pacing: at most one ramp every MIN_RAMP_TIME, no instant ramps.
        if (block.timestamp < initialATime + MIN_RAMP_TIME) {
            revert RampTooSoon(block.timestamp, initialATime + MIN_RAMP_TIME);
        }
        if (endTime < block.timestamp + MIN_RAMP_TIME) {
            revert RampWindowTooShort(endTime - block.timestamp, MIN_RAMP_TIME);
        }
        if (newAreal == 0) revert InvalidA();
        uint256 newAscaled = newAreal * A_PRECISION;
        if (newAscaled > MAX_A) revert InvalidA();

        uint256 currentA = _getA();
        // Cap multiplicative change.
        if (newAscaled < currentA) {
            if (currentA / newAscaled > MAX_A_CHANGE) {
                revert RampTooFast(newAscaled, currentA / MAX_A_CHANGE);
            }
        } else {
            if (newAscaled / currentA > MAX_A_CHANGE) {
                revert RampTooFast(newAscaled, currentA * MAX_A_CHANGE);
            }
        }

        initialA = currentA;
        futureA = newAscaled;
        initialATime = block.timestamp;
        futureATime = endTime;
        emit RampA(currentA, newAscaled, block.timestamp, endTime);
    }

    /// @notice Freeze A at its current value, cancelling any active ramp.
    function stopRampA() external onlyOwner {
        uint256 currentA = _getA();
        initialA = currentA;
        futureA = currentA;
        initialATime = block.timestamp;
        futureATime = block.timestamp;
        emit StopRampA(currentA, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // Internal: A-coefficient interpolation
    // -------------------------------------------------------------------------

    function _getA() internal view returns (uint256) {
        if (block.timestamp >= futureATime) return futureA;
        if (block.timestamp <= initialATime) return initialA;
        uint256 t1 = futureATime;
        uint256 t0 = initialATime;
        uint256 a0 = initialA;
        uint256 a1 = futureA;
        uint256 elapsed = block.timestamp - t0;
        uint256 window = t1 - t0;
        if (a1 > a0) {
            return a0 + ((a1 - a0) * elapsed) / window;
        } else {
            return a0 - ((a0 - a1) * elapsed) / window;
        }
    }

    // -------------------------------------------------------------------------
    // Internal: invariant math
    // -------------------------------------------------------------------------

    /// @dev Solve invariant for D given xp and A using Newton iteration.
    ///      A is scaled by A_PRECISION. Reverts if the iteration cannot
    ///      converge in 255 steps (a defensive bound — convergence is
    ///      typically < 10 iterations).
    function _getD(uint256[2] memory xp, uint256 amp) internal pure returns (uint256) {
        uint256 s = xp[0] + xp[1];
        if (s == 0) return 0;
        uint256 d = s;
        uint256 ann = amp * N_COINS;
        for (uint256 k = 0; k < 255; k++) {
            uint256 dp = d;
            // dp = D · D / (xp[0] · n) repeated for each coin
            dp = (dp * d) / (xp[0] * N_COINS);
            dp = (dp * d) / (xp[1] * N_COINS);
            uint256 dPrev = d;
            d = (((ann * s) / A_PRECISION + dp * N_COINS) * d)
                / ((((ann - A_PRECISION) * d) / A_PRECISION) + (N_COINS + 1) * dp);
            if (_within1(d, dPrev)) return d;
        }
        revert InvariantNotConverged();
    }

    /// @dev Solve invariant for new xp[j] given a fresh xp[i] = x.
    function _getY(uint256 i, uint256 j, uint256 x, uint256[2] memory xp, uint256 amp)
        internal
        pure
        returns (uint256)
    {
        if (i == j) revert InvalidIndex();
        if (i >= N_COINS || j >= N_COINS) revert InvalidIndex();
        uint256 d = _getD(xp, amp);
        uint256 ann = amp * N_COINS;

        // For 2 coins: only the "other" coin contributes to s and c.
        uint256 s = x;
        uint256 c = (d * d) / (x * N_COINS);
        c = (c * d * A_PRECISION) / (ann * N_COINS);
        uint256 b = s + (d * A_PRECISION) / ann;

        uint256 y = d;
        for (uint256 k = 0; k < 255; k++) {
            uint256 yPrev = y;
            y = (y * y + c) / (2 * y + b - d);
            if (_within1(y, yPrev)) return y;
        }
        revert InvariantNotConverged();
    }

    /// @dev Solve invariant for xp[i] given a target D and the OTHER coin
    ///      held fixed. Used in {removeLiquidityOneCoin}.
    function _getYD(uint256 i, uint256[2] memory xp, uint256 amp, uint256 d)
        internal
        pure
        returns (uint256)
    {
        if (i >= N_COINS) revert InvalidIndex();
        uint256 ann = amp * N_COINS;
        // The "other" coin is held at its current xp value.
        uint256 other = xp[1 - i];
        uint256 s = other;
        uint256 c = (d * d) / (other * N_COINS);
        c = (c * d * A_PRECISION) / (ann * N_COINS);
        uint256 b = s + (d * A_PRECISION) / ann;

        uint256 y = d;
        for (uint256 k = 0; k < 255; k++) {
            uint256 yPrev = y;
            y = (y * y + c) / (2 * y + b - d);
            if (_within1(y, yPrev)) return y;
        }
        revert InvariantNotConverged();
    }

    function _within1(uint256 a, uint256 b) internal pure returns (bool) {
        unchecked {
            return (a > b) ? (a - b <= 1) : (b - a <= 1);
        }
    }

    // -------------------------------------------------------------------------
    // Internal: LP math for unbalanced add
    // -------------------------------------------------------------------------

    /// @dev LP shares minted for an unbalanced deposit (non-initial). Mirror
    ///      of the Curve `add_liquidity` math: compute D before, deposit,
    ///      compute D after with imbalance fees applied per leg, and mint
    ///      LP proportional to ΔD/D.
    ///
    ///      `_writeFees` is only true when this runs as a state mutation
    ///      (from {addLiquidity}). When called as a view ({calcAddLiquidity})
    ///      we just want the LP estimate without modifying anything.
    function _calcLp(uint256 amountEtx, uint256 amountStEtx, bool view_)
        internal
        view
        returns (uint256 lp)
    {
        view_; // silence linter; both paths are pure-math
        uint256 amp = _getA();
        uint256 rate = getRate();

        uint256[2] memory xpOld;
        xpOld[0] = uint256(reserveEtx);
        xpOld[1] = (uint256(reserveStEtx) * rate) / PRECISION;
        uint256 d0 = _getD(xpOld, amp);

        uint256[2] memory xpNew;
        xpNew[0] = xpOld[0] + amountEtx;
        xpNew[1] = xpOld[1] + (amountStEtx * rate) / PRECISION;
        uint256 d1 = _getD(xpNew, amp);

        // Per-leg imbalance fee (Curve's standard imbalance fee = swapFee
        // · n / (4 · (n - 1)) for n=2 simplifies to swapFee/2). We then
        // recompute D against a "fee-adjusted" xpNew to land on the LP
        // mint; admin slice on the imbalance is set aside for claim.
        uint256 imbalanceFeeBps = (uint256(swapFeeBps) * N_COINS) / (4 * (N_COINS - 1));

        uint256[2] memory xpAdj;
        for (uint256 k = 0; k < N_COINS; k++) {
            uint256 idealBal = (d1 * xpOld[k]) / d0;
            uint256 newBal = xpNew[k];
            uint256 difference = (idealBal > newBal) ? idealBal - newBal : newBal - idealBal;
            uint256 fee = (difference * imbalanceFeeBps) / FEE_DENOMINATOR;
            xpAdj[k] = newBal - (fee * adminFeeBps) / FEE_DENOMINATOR;
        }
        uint256 d2 = _getD(xpAdj, amp);

        uint256 supply = totalSupply();
        lp = (supply * (d2 - d0)) / d0;
    }
}
