// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ResearchToken} from "./ResearchToken.sol";
import {IEticaResearchMarkets} from "./IEticaResearchMarkets.sol";

/// @title EticaResearchMarkets
/// @notice Singleton "V4-style" router that owns the shared 5M ETX research
///         pool and is the exclusive mint/burn authority for every
///         {ResearchToken} it launches. No public LP positions exist: all
///         liquidity sits inside this contract and is priced via a
///         constant-product bonding curve against per-market virtual
///         reserves. Buy/sell, launch, and the trade-fee router live here
///         and only here.
///
/// @dev    Per-trade fee (1% by default) splits 40/30/20/10:
///           - 40% stays in the singleton (compounds the shared pool)
///           - 30% routes to {etiLpSink} (POL burn pattern — pair with ETI
///             and burn the LP, same flywheel TreasuryHarvester already uses)
///           - 20% routes to {treasury}
///           - 10% routes to the researcher (the wallet that launched the
///             token via {launch})
///
///         The "shared pool" is the singleton's free ETX balance: the part
///         of `etx.balanceOf(address(this))` not attributed to any
///         particular market via `virtualEtxAcc`. The 5M seed is delivered
///         by a one-time ETX transfer from the treasury into this contract
///         post-deploy — no privileged seeding function is required.
///
///         Graduation is UI-only: once a market's `virtualEtxAcc` crosses
///         {graduationThreshold} the {Graduated} event fires (so /swap
///         and /trade can list the token) but the contract execution
///         path is unchanged — trades continue to route through this
///         singleton's bonding curve forever.
///
///         Sunset is also UI-only: after {sunsetWindow} seconds without
///         a trade, anyone may call {markSunsetted} to flip the dormant
///         flag (the launchpad UI hides sunsetted markets by default).
///         The bonding curve remains functional, so holders can still
///         sell back into the curve if they want.
contract EticaResearchMarkets is IEticaResearchMarkets, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Denominator for all basis-point math.
    uint256 public constant BPS = 10_000;

    /// @notice Hard upper bound on {feeRateBps} to prevent the owner
    ///         from setting an extractive fee post-deploy. 5% is enough
    ///         headroom for governance to tune fees up if needed but
    ///         caps the worst case far below pump.fun-style 5-10%.
    uint16 public constant MAX_FEE_BPS = 500;

    /// @notice Lower bound on {sunsetWindow}. Even if governance wants
    ///         aggressive UI hygiene, no token can be marked sunsetted
    ///         in under 7 days of inactivity.
    uint32 public constant MIN_SUNSET_WINDOW = 7 days;

    /// @notice The ETX reward asset (sole settlement currency for every market).
    IERC20 public immutable etx;

    /// @notice One-time toll, in ETX, paid by the launcher of every new market.
    ///         Routed entirely to the shared pool (no fee split — this is not
    ///         a trade fee). Default 100e18 (100 ETX).
    uint256 public launchTollEtx;

    /// @notice Per-trade fee in basis points. Default 100 (= 1%). Capped at
    ///         {MAX_FEE_BPS}. Applied to gross ETX in both buy and sell.
    uint16 public feeRateBps;

    /// @notice Fee router splits in basis points. Must sum to {BPS}. The
    ///         `pool` slice is the residual that stays in the singleton
    ///         (no transfer) — it's implicit, not stored, but it's the
    ///         BPS - (etiLp + treasury + researcher) leftover.
    uint16 public etiLpBps;
    uint16 public treasuryBps;
    uint16 public researcherBps;

    /// @notice ETX threshold at which a market is flagged "graduated" for
    ///         UI listing on /swap and /trade. Default 100_000e18 (100k ETX).
    uint128 public graduationThreshold;

    /// @notice Sunset cooldown in seconds. Default 30 days. Once a market
    ///         goes this long without a trade, anyone may call
    ///         {markSunsetted} to flip its dormant flag.
    uint32 public sunsetWindow;

    /// @notice POL burner address that receives the 30% ETI-LP slice of
    ///         every trade fee. Typically set to the existing
    ///         TreasuryHarvester or a dedicated EtiLpBurner contract that
    ///         knows how to pair ETX with ETI and burn the LP.
    address public etiLpSink;

    /// @notice Treasury multisig that receives the 20% treasury slice.
    address public treasury;

    /// @notice Default virtual ETX reserve seeded on every new market. The
    ///         choice trades off price floor (higher = flatter curve, more
    ///         ETX needed to graduate) against early-buyer return.
    ///         Default 5_000e18 (5k ETX). Owner may tune for future launches.
    uint128 public defaultVirtualEtxStart;

    /// @notice Default total virtual token supply for the bonding curve.
    ///         Effectively the "max supply" each market can ever reach
    ///         (constant-product math asymptotes at this value). Default
    ///         1_000_000_000e18 (1B tokens). Owner may tune.
    uint128 public defaultVirtualTokenStart;

    struct Market {
        address researcher;
        uint128 virtualEtxStart;
        uint128 virtualEtxAcc;
        uint128 tokenSupply;
        uint128 virtualTokenStart;
        uint64 launchedAt;
        uint64 lastTradeAt;
        uint64 graduatedAt;
        bool sunsetted;
    }

    mapping(address => Market) internal _markets;
    address[] internal _marketList;

    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh(uint16 fee, uint16 max);
    error SplitInvalid(uint256 sum);
    error SunsetWindowTooShort(uint32 window, uint32 min);
    error MarketUnknown(address token);
    error MarketAlreadyLaunched(address token);
    error DeadlineExpired(uint256 deadline, uint256 nowTs);
    error SlippageExceeded(uint256 got, uint256 want);
    error LaunchTokensRemain();
    error AlreadySunsetted(address token);
    error NotYetSunsettable(address token, uint256 secondsLeft);

    struct ConstructorArgs {
        IERC20 etx;
        address treasury;
        address etiLpSink;
        address owner;
        uint256 launchTollEtx;
        uint16 feeRateBps;
        uint16 etiLpBps;
        uint16 treasuryBps;
        uint16 researcherBps;
        uint128 graduationThreshold;
        uint32 sunsetWindow;
        uint128 defaultVirtualEtxStart;
        uint128 defaultVirtualTokenStart;
    }

    constructor(ConstructorArgs memory a) Ownable(a.owner) {
        if (address(a.etx) == address(0) || a.treasury == address(0) || a.etiLpSink == address(0)) {
            revert ZeroAddress();
        }
        if (a.feeRateBps > MAX_FEE_BPS) revert FeeTooHigh(a.feeRateBps, MAX_FEE_BPS);
        uint256 splitSum = uint256(a.etiLpBps) + uint256(a.treasuryBps) + uint256(a.researcherBps);
        if (splitSum > BPS) revert SplitInvalid(splitSum);
        if (a.sunsetWindow < MIN_SUNSET_WINDOW) revert SunsetWindowTooShort(a.sunsetWindow, uint32(MIN_SUNSET_WINDOW));
        if (a.defaultVirtualEtxStart == 0 || a.defaultVirtualTokenStart == 0) revert ZeroAmount();

        etx = a.etx;
        treasury = a.treasury;
        etiLpSink = a.etiLpSink;
        launchTollEtx = a.launchTollEtx;
        feeRateBps = a.feeRateBps;
        etiLpBps = a.etiLpBps;
        treasuryBps = a.treasuryBps;
        researcherBps = a.researcherBps;
        graduationThreshold = a.graduationThreshold;
        sunsetWindow = a.sunsetWindow;
        defaultVirtualEtxStart = a.defaultVirtualEtxStart;
        defaultVirtualTokenStart = a.defaultVirtualTokenStart;
    }

    // ─── Owner controls ───────────────────────────────────────────────

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event EtiLpSinkUpdated(address indexed oldSink, address indexed newSink);
    event FeeRateUpdated(uint16 oldBps, uint16 newBps);
    event FeeSplitUpdated(uint16 etiLpBps, uint16 treasuryBps, uint16 researcherBps);
    event GraduationThresholdUpdated(uint128 oldT, uint128 newT);
    event SunsetWindowUpdated(uint32 oldW, uint32 newW);
    event LaunchTollUpdated(uint256 oldToll, uint256 newToll);
    event DefaultVirtualReservesUpdated(uint128 etxStart, uint128 tokenStart);

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setEtiLpSink(address newSink) external onlyOwner {
        if (newSink == address(0)) revert ZeroAddress();
        emit EtiLpSinkUpdated(etiLpSink, newSink);
        etiLpSink = newSink;
    }

    function setFeeRate(uint16 newBps) external onlyOwner {
        if (newBps > MAX_FEE_BPS) revert FeeTooHigh(newBps, MAX_FEE_BPS);
        emit FeeRateUpdated(feeRateBps, newBps);
        feeRateBps = newBps;
    }

    function setFeeSplit(uint16 newEtiLpBps, uint16 newTreasuryBps, uint16 newResearcherBps) external onlyOwner {
        uint256 sum = uint256(newEtiLpBps) + uint256(newTreasuryBps) + uint256(newResearcherBps);
        if (sum > BPS) revert SplitInvalid(sum);
        etiLpBps = newEtiLpBps;
        treasuryBps = newTreasuryBps;
        researcherBps = newResearcherBps;
        emit FeeSplitUpdated(newEtiLpBps, newTreasuryBps, newResearcherBps);
    }

    function setGraduationThreshold(uint128 newThreshold) external onlyOwner {
        emit GraduationThresholdUpdated(graduationThreshold, newThreshold);
        graduationThreshold = newThreshold;
    }

    function setSunsetWindow(uint32 newWindow) external onlyOwner {
        if (newWindow < MIN_SUNSET_WINDOW) revert SunsetWindowTooShort(newWindow, uint32(MIN_SUNSET_WINDOW));
        emit SunsetWindowUpdated(sunsetWindow, newWindow);
        sunsetWindow = newWindow;
    }

    function setLaunchToll(uint256 newToll) external onlyOwner {
        emit LaunchTollUpdated(launchTollEtx, newToll);
        launchTollEtx = newToll;
    }

    function setDefaultVirtualReserves(uint128 newEtxStart, uint128 newTokenStart) external onlyOwner {
        if (newEtxStart == 0 || newTokenStart == 0) revert ZeroAmount();
        defaultVirtualEtxStart = newEtxStart;
        defaultVirtualTokenStart = newTokenStart;
        emit DefaultVirtualReservesUpdated(newEtxStart, newTokenStart);
    }

    // ─── Launch ───────────────────────────────────────────────────────

    /// @notice Deploy a new ResearchToken and register it as a market.
    ///         msg.sender becomes the researcher (10% fee recipient) and
    ///         must have approved {launchTollEtx} on this contract prior
    ///         to calling. The toll routes entirely into the shared pool
    ///         (no fee-split — this is not a trade fee).
    /// @dev    The new token is deployed with this singleton as its sole
    ///         mint/burn authority. Constructor args are deterministic
    ///         except for the {ResearchToken.Metadata} strings and the
    ///         researcher address, which lets the launchpad reuse a
    ///         single canonical Sourcify metadata bundle across every
    ///         launch.
    function launch(ResearchToken.Metadata calldata md) external nonReentrant returns (address token) {
        if (launchTollEtx > 0) {
            etx.safeTransferFrom(msg.sender, address(this), launchTollEtx);
        }

        token = address(new ResearchToken(md, address(this), msg.sender));

        Market storage m = _markets[token];
        if (m.virtualEtxStart != 0) revert MarketAlreadyLaunched(token);

        m.researcher = msg.sender;
        m.virtualEtxStart = defaultVirtualEtxStart;
        m.virtualTokenStart = defaultVirtualTokenStart;
        m.launchedAt = uint64(block.timestamp);
        m.lastTradeAt = uint64(block.timestamp);

        _marketList.push(token);

        emit Launched(token, msg.sender, m.virtualEtxStart, m.virtualTokenStart, launchTollEtx);
    }

    // ─── Trade ────────────────────────────────────────────────────────

    /// @notice Buy `token` with `etxInGross` ETX. The full gross amount is
    ///         pulled from msg.sender's ETX balance; a 1% (default) fee is
    ///         deducted and routed per the 40/30/20/10 split; the
    ///         remaining 99% sets the new constant-product invariant and
    ///         determines how many tokens are minted to msg.sender.
    function buy(address token, uint256 etxInGross, uint256 minTokensOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        Market storage m = _markets[token];
        if (m.virtualEtxStart == 0) revert MarketUnknown(token);
        if (etxInGross == 0) revert ZeroAmount();

        // Auto-unsunset if a trade happens.
        if (m.sunsetted) m.sunsetted = false;

        uint256 etxFee = (etxInGross * feeRateBps) / BPS;
        uint256 etxInNet = etxInGross - etxFee;

        uint256 vETXold = uint256(m.virtualEtxStart) + uint256(m.virtualEtxAcc);
        uint256 vTokenOld = uint256(m.virtualTokenStart) - uint256(m.tokenSupply);
        uint256 k = uint256(m.virtualEtxStart) * uint256(m.virtualTokenStart);

        uint256 vETXnew = vETXold + etxInNet;
        uint256 vTokenNew = k / vETXnew;
        tokensOut = vTokenOld - vTokenNew;

        if (tokensOut < minTokensOut) revert SlippageExceeded(tokensOut, minTokensOut);

        // Pull gross ETX.
        etx.safeTransferFrom(msg.sender, address(this), etxInGross);

        // Update curve state.
        m.virtualEtxAcc = uint128(uint256(m.virtualEtxAcc) + etxInNet);
        m.tokenSupply = uint128(uint256(m.tokenSupply) + tokensOut);
        m.lastTradeAt = uint64(block.timestamp);

        // Mint tokens to buyer.
        ResearchToken(token).mintFromMarket(msg.sender, tokensOut);

        // Route fee.
        _routeFee(token, etxFee, m.researcher);

        // Check graduation.
        if (m.graduatedAt == 0 && m.virtualEtxAcc >= graduationThreshold) {
            m.graduatedAt = uint64(block.timestamp);
            emit Graduated(token, m.virtualEtxAcc, m.graduatedAt);
        }

        emit Bought(token, msg.sender, etxInGross, etxFee, tokensOut, m.virtualEtxAcc, m.tokenSupply);
    }

    /// @notice Sell `tokensIn` of `token` back into the bonding curve. The
    ///         tokens are burned directly from msg.sender's balance (no
    ///         allowance needed — the singleton is the token's sole
    ///         mint/burn authority). The gross ETX repaid by the curve is
    ///         reduced by the 1% (default) fee, which routes per the
    ///         40/30/20/10 split; msg.sender receives the net.
    function sell(address token, uint256 tokensIn, uint256 minEtxOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 etxOutNet)
    {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        Market storage m = _markets[token];
        if (m.virtualEtxStart == 0) revert MarketUnknown(token);
        if (tokensIn == 0) revert ZeroAmount();

        if (m.sunsetted) m.sunsetted = false;

        uint256 vETXold = uint256(m.virtualEtxStart) + uint256(m.virtualEtxAcc);
        uint256 vTokenOld = uint256(m.virtualTokenStart) - uint256(m.tokenSupply);
        uint256 k = uint256(m.virtualEtxStart) * uint256(m.virtualTokenStart);

        uint256 vTokenNew = vTokenOld + tokensIn;
        uint256 vETXnew = k / vTokenNew;
        uint256 etxOutGross = vETXold - vETXnew;

        // Curve can never pay out more than this market's accumulated ETX.
        // Underflow would indicate state corruption; assert defensively.
        require(uint128(etxOutGross) <= m.virtualEtxAcc, "ERM: gross > acc");

        uint256 etxFee = (etxOutGross * feeRateBps) / BPS;
        etxOutNet = etxOutGross - etxFee;

        if (etxOutNet < minEtxOut) revert SlippageExceeded(etxOutNet, minEtxOut);

        // Burn tokens from seller (singleton is sole burn authority).
        ResearchToken(token).burnFromMarket(msg.sender, tokensIn);

        // Update curve state.
        m.virtualEtxAcc = uint128(uint256(m.virtualEtxAcc) - etxOutGross);
        m.tokenSupply = uint128(uint256(m.tokenSupply) - tokensIn);
        m.lastTradeAt = uint64(block.timestamp);

        // Pay seller net ETX.
        etx.safeTransfer(msg.sender, etxOutNet);

        // Route fee.
        _routeFee(token, etxFee, m.researcher);

        emit Sold(token, msg.sender, tokensIn, etxOutGross, etxFee, etxOutNet, m.virtualEtxAcc, m.tokenSupply);
    }

    function _routeFee(address token, uint256 totalFee, address researcher) internal {
        if (totalFee == 0) return;
        uint256 etiLpSlice = (totalFee * etiLpBps) / BPS;
        uint256 treasurySlice = (totalFee * treasuryBps) / BPS;
        uint256 researcherSlice = (totalFee * researcherBps) / BPS;
        // The pool slice is the residual that stays in this contract.
        uint256 poolSlice = totalFee - etiLpSlice - treasurySlice - researcherSlice;

        if (etiLpSlice > 0) etx.safeTransfer(etiLpSink, etiLpSlice);
        if (treasurySlice > 0) etx.safeTransfer(treasury, treasurySlice);
        if (researcherSlice > 0) etx.safeTransfer(researcher, researcherSlice);
        // poolSlice: implicit (no transfer).

        emit FeeRouted(token, totalFee, poolSlice, etiLpSlice, treasurySlice, researcherSlice);
    }

    // ─── Sunset ───────────────────────────────────────────────────────

    /// @notice Anyone may flip a market's sunset flag once {sunsetWindow}
    ///         has elapsed without a trade and the market has not
    ///         graduated. UI-only effect — the bonding curve continues to
    ///         function and any next trade auto-unsets the flag.
    function markSunsetted(address token) external {
        Market storage m = _markets[token];
        if (m.virtualEtxStart == 0) revert MarketUnknown(token);
        if (m.sunsetted) revert AlreadySunsetted(token);
        uint256 elapsed = block.timestamp - m.lastTradeAt;
        if (elapsed < sunsetWindow) revert NotYetSunsettable(token, sunsetWindow - elapsed);
        m.sunsetted = true;
        emit Sunsetted(token, m.virtualEtxAcc, uint64(block.timestamp));
    }

    // ─── Views ────────────────────────────────────────────────────────

    function quoteBuy(address token, uint256 etxInGross)
        external
        view
        returns (uint256 tokensOut, uint256 etxFee)
    {
        Market storage m = _markets[token];
        if (m.virtualEtxStart == 0 || etxInGross == 0) return (0, 0);
        etxFee = (etxInGross * feeRateBps) / BPS;
        uint256 etxInNet = etxInGross - etxFee;
        uint256 vETXold = uint256(m.virtualEtxStart) + uint256(m.virtualEtxAcc);
        uint256 vTokenOld = uint256(m.virtualTokenStart) - uint256(m.tokenSupply);
        uint256 k = uint256(m.virtualEtxStart) * uint256(m.virtualTokenStart);
        uint256 vETXnew = vETXold + etxInNet;
        uint256 vTokenNew = k / vETXnew;
        tokensOut = vTokenOld - vTokenNew;
    }

    function quoteSell(address token, uint256 tokensIn)
        external
        view
        returns (uint256 etxOutNet, uint256 etxFee)
    {
        Market storage m = _markets[token];
        if (m.virtualEtxStart == 0 || tokensIn == 0) return (0, 0);
        uint256 vETXold = uint256(m.virtualEtxStart) + uint256(m.virtualEtxAcc);
        uint256 vTokenOld = uint256(m.virtualTokenStart) - uint256(m.tokenSupply);
        uint256 k = uint256(m.virtualEtxStart) * uint256(m.virtualTokenStart);
        uint256 vTokenNew = vTokenOld + tokensIn;
        uint256 vETXnew = k / vTokenNew;
        uint256 etxOutGross = vETXold - vETXnew;
        etxFee = (etxOutGross * feeRateBps) / BPS;
        etxOutNet = etxOutGross - etxFee;
    }

    function market(address token) external view returns (MarketView memory v) {
        Market storage m = _markets[token];
        v = MarketView({
            token: token,
            researcher: m.researcher,
            virtualEtxStart: m.virtualEtxStart,
            virtualEtxAcc: m.virtualEtxAcc,
            tokenSupply: m.tokenSupply,
            virtualTokenStart: m.virtualTokenStart,
            launchedAt: m.launchedAt,
            lastTradeAt: m.lastTradeAt,
            graduatedAt: m.graduatedAt,
            sunsetted: m.sunsetted
        });
    }

    function isGraduated(address token) external view returns (bool) {
        return _markets[token].graduatedAt != 0;
    }

    function isSunsetted(address token) external view returns (bool) {
        return _markets[token].sunsetted;
    }

    function totalMarkets() external view returns (uint256) {
        return _marketList.length;
    }

    function marketAt(uint256 index) external view returns (address) {
        return _marketList[index];
    }

    /// @notice Free (unattributed) ETX held by the singleton — the "shared
    ///         pool" balance. Defined as total ETX balance minus the sum
    ///         of all per-market accumulated ETX. Useful for UI surfaces
    ///         that want to display the 5M seed + compounded fees.
    function freePoolEtx() external view returns (uint256) {
        uint256 total = etx.balanceOf(address(this));
        uint256 attributed;
        uint256 n = _marketList.length;
        for (uint256 i = 0; i < n; i++) {
            attributed += uint256(_markets[_marketList[i]].virtualEtxAcc);
        }
        if (total < attributed) return 0;
        return total - attributed;
    }
}
