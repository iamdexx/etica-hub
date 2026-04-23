// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IEticaSwapFactory} from "../swap/interfaces/IEticaSwapFactory.sol";
import {IEticaSwapPair} from "../swap/interfaces/IEticaSwapPair.sol";

interface IStakedETX {
    function distributeRewards(uint256 amount) external;
}

interface IRewardSink {
    function distributeRewards(uint256 amount) external;
}

/// @title TreasuryHarvester
/// @notice Atomic, permissionless on-chain harvester that runs the daily
///         fee-harvest pipeline without any privileged caller. Anyone may
///         call {harvest}; the treasury multisig (owner) configures the
///         split, caps, cooldown, and reward sinks.
///
///         Flow per run:
///           1. Pull a capped slice of treasury LP on each ETX pair.
///           2. Burn LP directly against the pair (no router), receiving
///              ETX + non-ETX to this contract.
///           3. Swap the non-ETX leg to ETX directly via the pair.
///           4. Split harvested ETX per BPS into four slices:
///                - stETX.distributeRewards (or retained if not set)
///                - farms.distributeRewards (or retained if not set)
///                - POL burn: pair ETX with freshly bought non-ETX and mint
///                  LP to 0xdead (permanent depth)
///                - Treasury retained (net of optional caller tip)
///
///         Trust model:
///           - `owner()` (treasury multisig) is the only address that can
///             set the split, safety caps, cooldown, caller tip, reward
///             sink addresses, or rescue tokens.
///           - `harvest` is permissionless — any wallet can call it. The
///             treasury is protected by two on-chain caps that hold
///             regardless of who calls:
///               * {maxBurnBpsPerRun}: upper bound on the LP fraction that
///                 can be burned per pair in a single run (default 1%).
///               * {harvestCooldown}: minimum seconds between harvests
///                 (default 23h), so the per-run cap is also a per-day cap.
///             The caller-supplied `PoolPlan` fields (slippage guards, LP
///             amount, POL allocation) are defensive only and cannot be
///             used to exceed either cap.
///
///         Liveness model:
///           - No single keeper key can halt the protocol. If the default
///             crank stops running (operator death, secret loss, disabled
///             workflow), any third party can invoke {harvest} and keep
///             the fee flywheel turning. An optional {callerTipEtx} gives
///             third-party cranks a gas reimbursement out of the treasury
///             slice, making the role self-sustaining.
///
///         Non-goals:
///           - This contract does NOT receive or send native EGAZ; gas is
///             paid by the caller out of its own balance. Only the ERC-20
///             rails are touched.
///           - This contract does NOT deploy pairs or change factory state.
///             Pairs must already exist and be registered in the factory.
contract TreasuryHarvester is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Dead address that receives permanently-burned POL LP.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice Upper bound on {harvestCooldown} to prevent the owner from
    ///         setting an adversarial cooldown that strands the protocol.
    ///         30 days is long enough to cover any reasonable emergency
    ///         pause but short enough that liveness can recover.
    uint32 public constant MAX_HARVEST_COOLDOWN = 30 days;

    /// @notice The ETX reward asset (also the hub of every pair harvested here).
    address public immutable etx;

    /// @notice The EticaSwap factory. Used to validate pair registration.
    IEticaSwapFactory public immutable factory;

    /// @notice stETX vault that receives the LST slice. Zero disables the slice
    ///         (ETX re-routed to treasury).
    address public stakedEtx;

    /// @notice LP farms that receive the farms slice. Zero disables the slice.
    address public farms;

    /// @notice Max LP fraction (bps) of the treasury's position that a single
    ///         harvest call may burn per pair. Defaults to 1% (100 bps).
    uint16 public maxBurnBpsPerRun;

    /// @notice Reward split in bps. Must sum to 10_000.
    uint16 public stakedEtxBps;
    uint16 public farmsBps;
    uint16 public polBurnBps;
    uint16 public treasuryBps;

    /// @notice Minimum number of seconds that must elapse between successful
    ///         {harvest} calls. Together with {maxBurnBpsPerRun} this caps
    ///         the treasury's LP outflow over any window.
    uint32 public harvestCooldown;

    /// @notice Block timestamp of the most recent successful {harvest}.
    ///         Zero until the first run (so the first call after deploy
    ///         is always immediately available).
    uint64 public lastHarvestAt;

    /// @notice Optional ETX tip paid to `msg.sender` on each successful
    ///         {harvest}, deducted from the treasury slice. Zero disables
    ///         the tip. Set this above realistic gas costs on chain to
    ///         guarantee third-party cranks will run the pipeline even
    ///         if the default GitHub Actions crank is paused.
    uint128 public callerTipEtx;

    struct PoolPlan {
        /// @dev Pair address. Must be registered in {factory} as (etx, nonEtx).
        address pair;
        /// @dev The non-ETX leg of the pair (ETI or WEGAZ in our universe).
        address nonEtx;
        /// @dev LP to burn this run. Capped by {maxBurnBpsPerRun} * treasury LP.
        uint256 lpToBurn;
        /// @dev Slippage guards on the LP burn (UniswapV2 pro-rata).
        uint256 minEtxFromBurn;
        uint256 minNonEtxFromBurn;
        /// @dev Slippage guard on the non-ETX → ETX swap that runs after burn.
        uint256 minEtxFromSwap;
        /// @dev POL path: ETX allocated to swap into non-ETX on this pool.
        uint256 polEtxForSwap;
        /// @dev POL path: ETX paired with the swapped non-ETX on this pool.
        ///      (polEtxForSwap + polEtxForPair) summed across pools must equal
        ///      the polBurn slice.
        uint256 polEtxForPair;
        /// @dev Slippage guard on the POL ETX → non-ETX swap.
        uint256 minNonEtxFromPolSwap;
    }

    event HarvestExecuted(
        address indexed caller,
        uint256 totalEtxHarvested,
        uint256 stakedSlice,
        uint256 farmsSlice,
        uint256 polSlice,
        uint256 treasurySlice
    );
    event PoolHarvested(
        address indexed pair,
        uint256 lpBurned,
        uint256 etxFromBurn,
        uint256 nonEtxFromBurn,
        uint256 etxFromSwap
    );
    event PolAddLiquidity(address indexed pair, uint256 etxIn, uint256 nonEtxIn, uint256 lp);
    event CallerTipPaid(address indexed caller, uint256 amount);
    event StakedEtxUpdated(address indexed newStakedEtx);
    event FarmsUpdated(address indexed newFarms);
    event SplitUpdated(uint16 stakedBps, uint16 farmsBps, uint16 polBps, uint16 treasuryBps);
    event MaxBurnBpsUpdated(uint16 newBps);
    event HarvestCooldownUpdated(uint32 newCooldownSeconds);
    event CallerTipUpdated(uint128 newTipEtx);
    event Rescue(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error NoPoolsProvided();
    error InvalidPool();
    error LpExceedsCap(uint256 requested, uint256 cap);
    error SlippageExceeded();
    error BpsSumInvalid();
    error BpsTooHigh();
    error PolAllocationInvalid(uint256 assigned, uint256 available);
    error UnevenPolPair();
    error CooldownNotElapsed(uint256 nextAllowedAt);
    error CooldownTooLong(uint32 requested, uint32 max);

    /// @param _owner Treasury address (multisig). Receives the retained slice
    ///        and is the sole admin.
    /// @param _etx  ETX token address.
    /// @param _factory EticaSwap factory address.
    constructor(address _owner, address _etx, address _factory) Ownable(_owner) {
        if (_etx == address(0) || _factory == address(0)) {
            revert ZeroAddress();
        }
        etx = _etx;
        factory = IEticaSwapFactory(_factory);

        maxBurnBpsPerRun = 100; // 1%
        // Default split: 10 / 10 / 40 / 40
        stakedEtxBps = 1_000;
        farmsBps = 1_000;
        polBurnBps = 4_000;
        treasuryBps = 4_000;
        // Default cooldown: 23 hours. Pairs well with a daily cron
        // without requiring the cron to hit an exact 24h stride.
        harvestCooldown = 23 hours;
        // Caller tip: disabled by default. Owner flips it on once the
        // harvester has been observed running through a full cycle.
        callerTipEtx = 0;
    }

    // -------------------------------------------------------------------------
    // Harvest
    // -------------------------------------------------------------------------

    /// @notice Execute a single harvest run. Permissionless.
    /// @dev Atomic: if any step reverts (e.g. slippage), the whole run
    ///      reverts and no treasury state changes.
    ///
    ///      Security boundaries that hold regardless of caller:
    ///        - LP burn per pair is capped by {maxBurnBpsPerRun}.
    ///        - Minimum interval between runs is {harvestCooldown}.
    ///        - Reward sinks are fixed on-chain by the owner.
    ///        - Splits are fixed on-chain by the owner.
    ///        - Caller tip is fixed on-chain by the owner.
    function harvest(PoolPlan[] calldata pools) external nonReentrant {
        if (pools.length == 0) revert NoPoolsProvided();

        // Cooldown: first run always passes (lastHarvestAt == 0 after
        // deploy); subsequent runs must wait at least `harvestCooldown`
        // seconds. uint64 + uint32 cannot overflow on any realistic chain.
        uint64 _last = lastHarvestAt;
        if (_last != 0) {
            uint256 nextAllowed = uint256(_last) + harvestCooldown;
            if (block.timestamp < nextAllowed) {
                revert CooldownNotElapsed(nextAllowed);
            }
        }
        lastHarvestAt = uint64(block.timestamp);

        address _treasury = owner();
        uint256 totalEtxBefore = IERC20(etx).balanceOf(address(this));

        // Phase 1: burn + swap per pool.
        for (uint256 i = 0; i < pools.length; i++) {
            _burnAndSwap(_treasury, pools[i]);
        }

        // Read actual ETX balance delta as source of truth for splits.
        // (Defensive: if a pair returned more than quoted, we still split the
        // extra consistently instead of leaving dust stuck in the contract.)
        uint256 totalEtxAfter = IERC20(etx).balanceOf(address(this));
        uint256 harvested = totalEtxAfter - totalEtxBefore;

        // Phase 2: compute slices.
        uint256 stakedSlice = (harvested * stakedEtxBps) / 10_000;
        uint256 farmsSlice = (harvested * farmsBps) / 10_000;
        uint256 polSlice = (harvested * polBurnBps) / 10_000;
        // Dust from integer division accrues to treasury slice.
        uint256 treasurySlice = harvested - stakedSlice - farmsSlice - polSlice;

        // Phase 3: distribute stETX slice.
        _forwardOrRetain(_treasury, stakedEtx, stakedSlice);

        // Phase 4: distribute farms slice.
        _forwardOrRetain(_treasury, farms, farmsSlice);

        // Phase 5: POL burn slice across pools.
        if (polSlice > 0) {
            _distributePol(_treasury, pools, polSlice);
        }

        // Phase 6: pay optional caller tip out of the treasury slice, then
        // forward the remainder to treasury. The tip is capped at
        // min(callerTipEtx, treasurySlice) so we can never under-deliver
        // to treasury and can never exceed the allocated slice.
        uint256 tip = callerTipEtx;
        if (tip > treasurySlice) tip = treasurySlice;
        if (tip > 0) {
            IERC20(etx).safeTransfer(msg.sender, tip);
            emit CallerTipPaid(msg.sender, tip);
        }
        uint256 treasuryNet = treasurySlice - tip;
        if (treasuryNet > 0) {
            IERC20(etx).safeTransfer(_treasury, treasuryNet);
        }

        emit HarvestExecuted(msg.sender, harvested, stakedSlice, farmsSlice, polSlice, treasuryNet);
    }

    function _burnAndSwap(address _treasury, PoolPlan calldata plan) internal {
        if (plan.lpToBurn == 0) return;

        IEticaSwapPair pair = IEticaSwapPair(plan.pair);
        bool etxIs0 = _validatePairAndEtxIs0(plan, pair);

        // Cap LP at maxBurnBpsPerRun of treasury's position.
        {
            uint256 cap = (pair.balanceOf(_treasury) * maxBurnBpsPerRun) / 10_000;
            if (plan.lpToBurn > cap) revert LpExceedsCap(plan.lpToBurn, cap);
        }

        // Pull LP straight into the pair and burn to this contract.
        IERC20(plan.pair).safeTransferFrom(_treasury, plan.pair, plan.lpToBurn);
        uint256 etxOut;
        uint256 nonEtxOut;
        {
            (uint256 amount0, uint256 amount1) = pair.burn(address(this));
            etxOut = etxIs0 ? amount0 : amount1;
            nonEtxOut = etxIs0 ? amount1 : amount0;
        }
        if (etxOut < plan.minEtxFromBurn || nonEtxOut < plan.minNonEtxFromBurn) {
            revert SlippageExceeded();
        }

        // Swap non-ETX → ETX directly against the pair.
        uint256 etxFromSwap = _swapNonEtxToEtx(plan, pair, etxIs0, nonEtxOut);
        emit PoolHarvested(plan.pair, plan.lpToBurn, etxOut, nonEtxOut, etxFromSwap);
    }

    function _validatePairAndEtxIs0(PoolPlan calldata plan, IEticaSwapPair pair)
        internal
        view
        returns (bool etxIs0)
    {
        if (factory.getPair(etx, plan.nonEtx) != plan.pair) revert InvalidPool();
        address t0 = pair.token0();
        address t1 = pair.token1();
        etxIs0 = (t0 == etx);
        if (!(etxIs0 ? (t1 == plan.nonEtx) : (t0 == plan.nonEtx && t1 == etx))) {
            revert InvalidPool();
        }
    }

    function _swapNonEtxToEtx(
        PoolPlan calldata plan,
        IEticaSwapPair pair,
        bool etxIs0,
        uint256 nonEtxOut
    ) internal returns (uint256 etxFromSwap) {
        if (nonEtxOut == 0) return 0;
        (uint112 r0, uint112 r1,) = pair.getReserves();
        etxFromSwap = _getAmountOut(nonEtxOut, etxIs0 ? r1 : r0, etxIs0 ? r0 : r1);
        if (etxFromSwap < plan.minEtxFromSwap) revert SlippageExceeded();

        IERC20(plan.nonEtx).safeTransfer(plan.pair, nonEtxOut);
        if (etxIs0) {
            pair.swap(etxFromSwap, 0, address(this), "");
        } else {
            pair.swap(0, etxFromSwap, address(this), "");
        }
    }

    function _forwardOrRetain(address _treasury, address sink, uint256 amount) internal {
        if (amount == 0) return;
        if (sink == address(0)) {
            IERC20(etx).safeTransfer(_treasury, amount);
            return;
        }
        IERC20(etx).forceApprove(sink, amount);
        IRewardSink(sink).distributeRewards(amount);
        // Reset any leftover approval as a defense-in-depth step.
        IERC20(etx).forceApprove(sink, 0);
    }

    function _distributePol(address _treasury, PoolPlan[] calldata pools, uint256 polSlice)
        internal
    {
        // Sum the caller's per-pool POL assignment; any unassigned residual
        // reverts to the treasury. We require assigned <= polSlice so the
        // caller cannot over-spend by mis-constructing the plan.
        uint256 assigned;
        for (uint256 i = 0; i < pools.length; i++) {
            PoolPlan calldata p = pools[i];
            // Both legs must be present or both must be zero; a one-sided
            // POL branch would either leak ETX or fail add-liquidity.
            if ((p.polEtxForSwap == 0) != (p.polEtxForPair == 0)) revert UnevenPolPair();
            assigned += p.polEtxForSwap + p.polEtxForPair;
        }
        if (assigned > polSlice) revert PolAllocationInvalid(assigned, polSlice);

        for (uint256 i = 0; i < pools.length; i++) {
            PoolPlan calldata p = pools[i];
            if (p.polEtxForSwap == 0 || p.polEtxForPair == 0) continue;
            _polForPool(p);
        }

        uint256 residual = polSlice - assigned;
        if (residual > 0) {
            IERC20(etx).safeTransfer(_treasury, residual);
        }
    }

    function _polForPool(PoolPlan calldata p) internal {
        IEticaSwapPair pair = IEticaSwapPair(p.pair);
        address t0 = pair.token0();
        bool etxIs0 = (t0 == etx);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 rEtx = etxIs0 ? r0 : r1;
        uint256 rNon = etxIs0 ? r1 : r0;

        // ETX → non-ETX via pair.
        uint256 nonEtxOut = _getAmountOut(p.polEtxForSwap, rEtx, rNon);
        if (nonEtxOut < p.minNonEtxFromPolSwap) revert SlippageExceeded();

        IERC20(etx).safeTransfer(p.pair, p.polEtxForSwap);
        if (etxIs0) {
            pair.swap(0, nonEtxOut, address(this), "");
        } else {
            pair.swap(nonEtxOut, 0, address(this), "");
        }

        // Pair the retained ETX with the freshly bought non-ETX and mint to dead.
        IERC20(etx).safeTransfer(p.pair, p.polEtxForPair);
        IERC20(p.nonEtx).safeTransfer(p.pair, nonEtxOut);
        uint256 lp = pair.mint(DEAD);

        emit PolAddLiquidity(p.pair, p.polEtxForPair, nonEtxOut, lp);
    }

    /// @dev UniswapV2 constant-product with 0.30% fee: pure and matches the
    ///      router's getAmountOut.
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256)
    {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) return 0;
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        return numerator / denominator;
    }

    // -------------------------------------------------------------------------
    // Admin (owner = treasury)
    // -------------------------------------------------------------------------

    function setStakedEtx(address newStakedEtx) external onlyOwner {
        stakedEtx = newStakedEtx;
        emit StakedEtxUpdated(newStakedEtx);
    }

    function setFarms(address newFarms) external onlyOwner {
        farms = newFarms;
        emit FarmsUpdated(newFarms);
    }

    function setSplit(uint16 _stakedBps, uint16 _farmsBps, uint16 _polBps, uint16 _treasuryBps)
        external
        onlyOwner
    {
        if (uint256(_stakedBps) + _farmsBps + _polBps + _treasuryBps != 10_000) {
            revert BpsSumInvalid();
        }
        stakedEtxBps = _stakedBps;
        farmsBps = _farmsBps;
        polBurnBps = _polBps;
        treasuryBps = _treasuryBps;
        emit SplitUpdated(_stakedBps, _farmsBps, _polBps, _treasuryBps);
    }

    function setMaxBurnBpsPerRun(uint16 bps) external onlyOwner {
        if (bps > 10_000) revert BpsTooHigh();
        maxBurnBpsPerRun = bps;
        emit MaxBurnBpsUpdated(bps);
    }

    function setHarvestCooldown(uint32 cooldownSeconds) external onlyOwner {
        if (cooldownSeconds > MAX_HARVEST_COOLDOWN) {
            revert CooldownTooLong(cooldownSeconds, MAX_HARVEST_COOLDOWN);
        }
        harvestCooldown = cooldownSeconds;
        emit HarvestCooldownUpdated(cooldownSeconds);
    }

    function setCallerTipEtx(uint128 tipEtx) external onlyOwner {
        callerTipEtx = tipEtx;
        emit CallerTipUpdated(tipEtx);
    }

    /// @notice Sweep tokens out of the contract to the treasury. For clearing
    ///         dust or recovering mis-sent tokens; should never be needed
    ///         during normal operation.
    function rescue(address token, uint256 amount) external onlyOwner {
        address to = owner();
        IERC20(token).safeTransfer(to, amount);
        emit Rescue(token, to, amount);
    }
}
