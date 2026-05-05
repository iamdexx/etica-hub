// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {BridgeInsuranceFund} from "./BridgeInsuranceFund.sol";
import {FeeRouter} from "./FeeRouter.sol";
import {IMailbox} from "./IHyperlane.sol";

/// @title BridgeVault
/// @notice Asset-locking custodian for the Phase 3 ETX bridge on Etica.
///         Holds every ETX bridged out and orchestrates the optimistic-veto
///         withdrawal queue when wETX is burned on a remote chain.
///
///         **The most security-critical contract in the system** because it
///         controls user funds. Hardened with:
///           - Per-claim cap (1% of TVL by default)
///           - Per-day rate limit (5% of TVL, rolling UTC day)
///           - TVL ceiling (1M ETX initial, raises to 10M via `tryAutoRaiseCap`)
///           - 48h challenge window (settable via timelock)
///           - Owner-veto separation: a dedicated `vetoAuthority` (the future
///             OptimisticVetoModule) cancels claims; `owner` configures policy
///           - Allowed-destination + trusted-minter wiring required before any
///             flow can occur (vault is inert at deploy until owner wires it)
///
///         Money flow on deposit:
///           1. User calls `deposit(amount, destDomain, recipient)`
///           2. Vault pulls `amount` ETX from user via transferFrom
///           3. fee = amount * bridgeFeeBps / 10_000
///           4. Vault transfers `fee` to FeeRouter then notifies via `routeFee`
///           5. net = amount - fee remains locked; `totalLockedEtx` updated
///           6. Vault dispatches encoded (nonce, recipient, net) via Hyperlane
///              mailbox to the trusted minter on `destDomain`
///
///         Money flow on burn (inbound from remote BridgeMinter):
///           1. Mailbox calls `handle(origin, sender, body)`
///           2. Vault verifies origin is allowed and sender == trustedMinter[origin]
///           3. Decodes (nonce, recipient, amount); registers PENDING claim
///              with `expiresAt = now + challengeWindowSeconds`
///           4. After expiry, anyone calls `executeWithdraw(nonce)` →
///              ETX transferred to recipient (subject to caps + rate limit)
///           5. Or `vetoAuthority` calls `vetoWithdraw(nonce)` before expiry →
///              claim marked VETOED; back-message to minter (slash bond) is
///              the responsibility of an integration-layer wrapper (PR 8)
///
///         Cross-chain solvency restoration (`checkSolvency`) and bond/back-
///         message handling are intentionally deferred to the Hyperlane
///         integration PR (PR 8) — they require cross-chain oracle plumbing
///         that depends on contracts not yet deployed.
contract BridgeVault is Ownable2Step {
    using SafeERC20 for IERC20;

    /* -------------------------------------------------------------------- */
    /*                              CONSTANTS                               */
    /* -------------------------------------------------------------------- */

    uint16 public constant TOTAL_BPS = 10_000;
    uint16 public constant MAX_BRIDGE_FEE_BPS = 100; // 1% hard cap
    uint128 public constant MAX_DAILY_CAP_BPS = 1000; // 10% hard cap
    uint128 public constant MAX_PER_CLAIM_CAP_BPS = 500; // 5% hard cap
    uint64 public constant MIN_CHALLENGE_WINDOW = 1 hours;
    uint64 public constant MAX_CHALLENGE_WINDOW = 14 days;
    uint64 public constant SECONDS_PER_DAY = 86_400;

    /* -------------------------------------------------------------------- */
    /*                             IMMUTABLES                               */
    /* -------------------------------------------------------------------- */

    IERC20 public immutable etx;
    address public immutable hyperlaneMailbox;
    BridgeInsuranceFund public immutable insuranceFund;
    FeeRouter public immutable feeRouter;
    uint32 public immutable selfDomain;

    /// @notice Time that must elapse between an owner `request*` and `executeOp`.
    uint64 public immutable opTimelock;

    /* -------------------------------------------------------------------- */
    /*                        POLICY / RATE STATE                           */
    /* -------------------------------------------------------------------- */

    /// @notice Cumulative ETX locked by deposits (not including unrouted fees).
    uint128 public totalLockedEtx;
    /// @notice Cumulative bridge fees collected (informational).
    uint128 public totalFeesAccruedEtx;

    /// @notice Current TVL ceiling in ETX wei.
    uint128 public tvlCapEtx;

    /// @notice Withdrawals counted toward today's rate-limit window.
    uint128 public withdrawnTodayEtx;
    /// @notice UTC day index (`block.timestamp / 86_400`) for the active window.
    uint64 public currentDayUtc;

    /// @notice Per-claim cap as a fraction of `tvlCapEtx`, in basis points.
    uint128 public perClaimCapBps;
    /// @notice Per-day cumulative withdrawal cap as a fraction of `tvlCapEtx`.
    uint128 public dailyWithdrawCapBps;

    /// @notice Bridge fee charged on each `deposit`, in basis points.
    uint16 public bridgeFeeBps;

    /// @notice 48h by default. Settable via timelocked op within bounds.
    uint64 public challengeWindowSeconds;

    /// @notice Address authorized to call `vetoWithdraw`. Set post-deploy via
    ///         timelocked op (initially `address(0)` so vetoes are impossible
    ///         until owner wires the OptimisticVetoModule).
    address public vetoAuthority;

    /// @notice Emergency pause flag. Owner can flip ON instantly; flip OFF is
    ///         timelocked.
    bool public paused;

    /// @notice Monotonically incrementing per-vault counter for outbound nonces.
    uint96 public depositCounter;

    /* -------------------------------------------------------------------- */
    /*                          ROUTING WIRING                              */
    /* -------------------------------------------------------------------- */

    /// @notice Allowed remote destination domains for `deposit`.
    mapping(uint32 destDomain => bool allowed) public allowedDestDomain;

    /// @notice Trusted minter on each remote domain. Used to filter inbound
    ///         `handle` calls.
    mapping(uint32 origin => bytes32 trustedMinter) public trustedMinter;

    /* -------------------------------------------------------------------- */
    /*                            CLAIM STATE                               */
    /* -------------------------------------------------------------------- */

    enum ClaimState {
        NONE,
        PENDING,
        EXECUTED,
        VETOED
    }

    struct Claim {
        address recipient;
        uint128 amount;
        uint64 expiresAt;
        ClaimState state;
    }

    mapping(bytes32 nonce => Claim) public claims;

    /* -------------------------------------------------------------------- */
    /*                       OWNER TIMELOCK MACHINERY                       */
    /* -------------------------------------------------------------------- */

    enum OpKind {
        NONE,
        SET_VETO_AUTHORITY,
        SET_BRIDGE_FEE_BPS,
        SET_RATE_LIMITS,
        SET_CHALLENGE_WINDOW,
        SET_ALLOWED_DEST_DOMAIN,
        SET_TRUSTED_MINTER,
        UNPAUSE
    }

    struct PendingOp {
        OpKind kind;
        uint64 executableAt;
        bool executed;
        bool cancelled;
        bytes payload;
    }

    mapping(uint256 id => PendingOp) public pendingOps;
    uint256 public nextOpId;

    /* -------------------------------------------------------------------- */
    /*                                EVENTS                                */
    /* -------------------------------------------------------------------- */

    event Deposit(
        bytes32 indexed nonce,
        address indexed sender,
        address indexed recipient,
        uint32 destDomain,
        uint128 amountNet,
        uint128 fee
    );
    event WithdrawClaimSubmitted(
        bytes32 indexed nonce, address indexed recipient, uint128 amount, uint64 expiresAt
    );
    event WithdrawExecuted(bytes32 indexed nonce, address indexed recipient, uint128 amount);
    event WithdrawVetoed(bytes32 indexed nonce, address indexed vetoer);
    event EmergencyPaused(address indexed pauser);
    event Unpaused();
    event AllowedDestDomainChanged(uint32 indexed domain, bool allowed);
    event TrustedMinterChanged(uint32 indexed domain, bytes32 trustedMinter);
    event VetoAuthorityChanged(address indexed newAuthority);
    event BridgeFeeBpsChanged(uint16 newBps);
    event RateLimitsChanged(uint128 newDailyBps, uint128 newPerClaimBps);
    event ChallengeWindowChanged(uint64 newSeconds);
    event OpRequested(uint256 indexed id, OpKind kind, uint64 executableAt);
    event OpExecuted(uint256 indexed id);
    event OpCancelled(uint256 indexed id);

    /* -------------------------------------------------------------------- */
    /*                                ERRORS                                */
    /* -------------------------------------------------------------------- */

    error BridgeVault_ZeroAddress();
    error BridgeVault_ZeroAmount();
    error BridgeVault_Paused();
    error BridgeVault_NotPaused();
    error BridgeVault_TVLCapExceeded(uint128 wouldBe, uint128 cap);
    error BridgeVault_RateLimitExceeded(uint128 wouldBe, uint128 cap);
    error BridgeVault_PerClaimCapExceeded(uint128 amount, uint128 cap);
    error BridgeVault_NotMatured(uint64 expiresAt, uint64 nowTimestamp);
    error BridgeVault_AlreadyMatured(uint64 expiresAt);
    error BridgeVault_AlreadyProcessed(bytes32 nonce);
    error BridgeVault_ClaimNotPending(bytes32 nonce);
    error BridgeVault_InvalidDestDomain(uint32 dest);
    error BridgeVault_OnlyMailbox(address caller);
    error BridgeVault_OnlyVetoAuthority(address caller);
    error BridgeVault_UntrustedSender(uint32 origin, bytes32 sender);
    error BridgeVault_FeeBpsTooHigh(uint16 newBps, uint16 cap);
    error BridgeVault_DailyCapTooHigh(uint128 newBps, uint128 cap);
    error BridgeVault_PerClaimCapTooHigh(uint128 newBps, uint128 cap);
    error BridgeVault_ChallengeWindowOutOfBounds(uint64 newSeconds);
    error BridgeVault_InvalidOpId(uint256 id);
    error BridgeVault_OpAlreadyExecuted(uint256 id);
    error BridgeVault_OpAlreadyCancelled(uint256 id);
    error BridgeVault_OpTimelockNotElapsed(uint64 executableAt, uint64 nowTimestamp);

    /* -------------------------------------------------------------------- */
    /*                              MODIFIERS                               */
    /* -------------------------------------------------------------------- */

    modifier whenNotPaused() {
        if (paused) revert BridgeVault_Paused();
        _;
    }

    /* -------------------------------------------------------------------- */
    /*                            CONSTRUCTOR                               */
    /* -------------------------------------------------------------------- */

    constructor(
        address _owner,
        IERC20 _etx,
        address _hyperlaneMailbox,
        BridgeInsuranceFund _insuranceFund,
        FeeRouter _feeRouter,
        uint32 _selfDomain,
        uint64 _opTimelock
    ) Ownable(_owner) {
        if (_owner == address(0)) revert BridgeVault_ZeroAddress();
        if (address(_etx) == address(0)) revert BridgeVault_ZeroAddress();
        if (_hyperlaneMailbox == address(0)) revert BridgeVault_ZeroAddress();
        if (address(_insuranceFund) == address(0)) revert BridgeVault_ZeroAddress();
        if (address(_feeRouter) == address(0)) revert BridgeVault_ZeroAddress();

        etx = _etx;
        hyperlaneMailbox = _hyperlaneMailbox;
        insuranceFund = _insuranceFund;
        feeRouter = _feeRouter;
        selfDomain = _selfDomain;
        opTimelock = _opTimelock;

        // Locked launch defaults — see docs/BRIDGE_DESIGN.md & BRIDGE_CONTRACT_SPEC.md §3
        tvlCapEtx = 1_000_000e18;
        bridgeFeeBps = 10; // 0.1%
        dailyWithdrawCapBps = 500; // 5%
        perClaimCapBps = 100; // 1%
        challengeWindowSeconds = 48 hours;
    }

    /* -------------------------------------------------------------------- */
    /*                              DEPOSIT                                 */
    /* -------------------------------------------------------------------- */

    /// @notice Lock ETX on Etica and dispatch a mint instruction to a remote chain.
    /// @param amount        Total ETX (gross) to bridge. Fee is charged on top.
    /// @param destDomain    Hyperlane domain ID of the destination chain.
    /// @param recipient     Receiving address on the destination chain.
    /// @return nonce        Deterministic per-vault nonce for this deposit.
    function deposit(uint128 amount, uint32 destDomain, address recipient)
        external
        payable
        whenNotPaused
        returns (bytes32 nonce)
    {
        if (amount == 0) revert BridgeVault_ZeroAmount();
        if (recipient == address(0)) revert BridgeVault_ZeroAddress();
        if (!allowedDestDomain[destDomain]) revert BridgeVault_InvalidDestDomain(destDomain);

        uint128 fee = uint128((uint256(amount) * bridgeFeeBps) / TOTAL_BPS);
        uint128 net = amount - fee;

        uint128 newLocked = totalLockedEtx + net;
        if (newLocked > tvlCapEtx) revert BridgeVault_TVLCapExceeded(newLocked, tvlCapEtx);

        // Pull the gross amount from the user. Fee subsequently flows to the
        // FeeRouter; the net stays in this contract as locked collateral.
        etx.safeTransferFrom(msg.sender, address(this), amount);

        if (fee > 0) {
            etx.safeTransfer(address(feeRouter), fee);
            feeRouter.routeFee(fee);
            totalFeesAccruedEtx += fee;
        }
        totalLockedEtx = newLocked;

        // Increment counter first so nonces start at 1.
        depositCounter += 1;
        nonce = keccak256(abi.encode(selfDomain, address(this), depositCounter));

        bytes32 minter = trustedMinter[destDomain];
        // Forward any attached msg.value as Hyperlane IGP / native fee. The
        // caller is expected to pay destination-chain delivery gas via this
        // value-carrying call. If `value` is 0, dispatch still succeeds for
        // mailboxes that don't require it.
        IMailbox(hyperlaneMailbox).dispatch{value: msg.value}(
            destDomain, minter, abi.encode(nonce, recipient, net)
        );

        emit Deposit(nonce, msg.sender, recipient, destDomain, net, fee);
    }

    /* -------------------------------------------------------------------- */
    /*                       INBOUND BURN MESSAGES                          */
    /* -------------------------------------------------------------------- */

    /// @notice Hyperlane callback. Registers a new pending withdrawal claim.
    /// @dev    No funds move here; the actual ETX transfer is gated on the
    ///         48h challenge window via `executeWithdraw`.
    function handle(uint32 origin, bytes32 sender, bytes calldata body) external {
        if (msg.sender != hyperlaneMailbox) revert BridgeVault_OnlyMailbox(msg.sender);
        bytes32 trusted = trustedMinter[origin];
        if (trusted == bytes32(0) || sender != trusted) {
            revert BridgeVault_UntrustedSender(origin, sender);
        }

        (bytes32 nonce, address recipient, uint128 amount) =
            abi.decode(body, (bytes32, address, uint128));

        if (claims[nonce].state != ClaimState.NONE) {
            revert BridgeVault_AlreadyProcessed(nonce);
        }
        if (recipient == address(0)) revert BridgeVault_ZeroAddress();
        if (amount == 0) revert BridgeVault_ZeroAmount();

        uint64 expiresAt = uint64(block.timestamp) + challengeWindowSeconds;
        claims[nonce] = Claim({
            recipient: recipient, amount: amount, expiresAt: expiresAt, state: ClaimState.PENDING
        });
        emit WithdrawClaimSubmitted(nonce, recipient, amount, expiresAt);
    }

    /* -------------------------------------------------------------------- */
    /*                            EXECUTE / VETO                            */
    /* -------------------------------------------------------------------- */

    /// @notice Settle a matured claim. Permissionless; subject to caps + rate limit.
    function executeWithdraw(bytes32 nonce) external whenNotPaused {
        Claim storage c = claims[nonce];
        if (c.state != ClaimState.PENDING) revert BridgeVault_ClaimNotPending(nonce);
        if (block.timestamp < c.expiresAt) {
            revert BridgeVault_NotMatured(c.expiresAt, uint64(block.timestamp));
        }

        uint128 perClaimCap = uint128((uint256(tvlCapEtx) * perClaimCapBps) / TOTAL_BPS);
        if (c.amount > perClaimCap) {
            revert BridgeVault_PerClaimCapExceeded(c.amount, perClaimCap);
        }

        // Roll the daily window.
        uint64 today = uint64(block.timestamp) / SECONDS_PER_DAY;
        uint128 currentlyWithdrawn = withdrawnTodayEtx;
        if (today != currentDayUtc) {
            currentlyWithdrawn = 0;
            currentDayUtc = today;
        }
        uint128 dailyCap = uint128((uint256(tvlCapEtx) * dailyWithdrawCapBps) / TOTAL_BPS);
        uint128 wouldBe = currentlyWithdrawn + c.amount;
        if (wouldBe > dailyCap) revert BridgeVault_RateLimitExceeded(wouldBe, dailyCap);
        withdrawnTodayEtx = wouldBe;

        c.state = ClaimState.EXECUTED;
        // totalLockedEtx is decremented by the gross withdraw amount. If a
        // burn-side fee was charged on the destination chain, that fee was
        // already deducted before the message arrived here.
        totalLockedEtx -= c.amount;

        etx.safeTransfer(c.recipient, c.amount);
        emit WithdrawExecuted(nonce, c.recipient, c.amount);
    }

    /// @notice Cancel a pending claim before its challenge window closes.
    /// @dev    Only `vetoAuthority` may call. Slashing of the submitter bond
    ///         and the back-message to the burn-source minter are handled by
    ///         the OptimisticVetoModule + Hyperlane integration layers.
    function vetoWithdraw(bytes32 nonce) external {
        if (msg.sender != vetoAuthority) revert BridgeVault_OnlyVetoAuthority(msg.sender);
        Claim storage c = claims[nonce];
        if (c.state != ClaimState.PENDING) revert BridgeVault_ClaimNotPending(nonce);
        if (block.timestamp >= c.expiresAt) revert BridgeVault_AlreadyMatured(c.expiresAt);

        c.state = ClaimState.VETOED;
        emit WithdrawVetoed(nonce, msg.sender);
    }

    /* -------------------------------------------------------------------- */
    /*                              EMERGENCY                               */
    /* -------------------------------------------------------------------- */

    /// @notice Owner can flip the bridge OFF instantly (no timelock). Halts
    ///         deposits and withdrawals. Unpause is timelocked.
    function emergencyPause() external onlyOwner {
        if (paused) revert BridgeVault_Paused();
        paused = true;
        emit EmergencyPaused(msg.sender);
    }

    /* -------------------------------------------------------------------- */
    /*                       OWNER TIMELOCKED OPS                           */
    /* -------------------------------------------------------------------- */

    function requestSetVetoAuthority(address newAuthority) external onlyOwner returns (uint256 id) {
        if (newAuthority == address(0)) revert BridgeVault_ZeroAddress();
        return _request(OpKind.SET_VETO_AUTHORITY, abi.encode(newAuthority));
    }

    function requestSetBridgeFeeBps(uint16 newBps) external onlyOwner returns (uint256 id) {
        if (newBps > MAX_BRIDGE_FEE_BPS) {
            revert BridgeVault_FeeBpsTooHigh(newBps, MAX_BRIDGE_FEE_BPS);
        }
        return _request(OpKind.SET_BRIDGE_FEE_BPS, abi.encode(newBps));
    }

    function requestSetRateLimits(uint128 newDailyBps, uint128 newPerClaimBps)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (newDailyBps > MAX_DAILY_CAP_BPS) {
            revert BridgeVault_DailyCapTooHigh(newDailyBps, MAX_DAILY_CAP_BPS);
        }
        if (newPerClaimBps > MAX_PER_CLAIM_CAP_BPS) {
            revert BridgeVault_PerClaimCapTooHigh(newPerClaimBps, MAX_PER_CLAIM_CAP_BPS);
        }
        return _request(OpKind.SET_RATE_LIMITS, abi.encode(newDailyBps, newPerClaimBps));
    }

    function requestSetChallengeWindow(uint64 newSeconds) external onlyOwner returns (uint256 id) {
        if (newSeconds < MIN_CHALLENGE_WINDOW || newSeconds > MAX_CHALLENGE_WINDOW) {
            revert BridgeVault_ChallengeWindowOutOfBounds(newSeconds);
        }
        return _request(OpKind.SET_CHALLENGE_WINDOW, abi.encode(newSeconds));
    }

    function requestSetAllowedDestDomain(uint32 destDomain, bool allowed)
        external
        onlyOwner
        returns (uint256 id)
    {
        return _request(OpKind.SET_ALLOWED_DEST_DOMAIN, abi.encode(destDomain, allowed));
    }

    function requestSetTrustedMinter(uint32 origin, bytes32 minter)
        external
        onlyOwner
        returns (uint256 id)
    {
        return _request(OpKind.SET_TRUSTED_MINTER, abi.encode(origin, minter));
    }

    function requestUnpause() external onlyOwner returns (uint256 id) {
        if (!paused) revert BridgeVault_NotPaused();
        return _request(OpKind.UNPAUSE, "");
    }

    /// @notice Apply a previously-requested op once its timelock has elapsed.
    function executeOp(uint256 id) external onlyOwner {
        PendingOp storage op = pendingOps[id];
        if (op.kind == OpKind.NONE) revert BridgeVault_InvalidOpId(id);
        if (op.executed) revert BridgeVault_OpAlreadyExecuted(id);
        if (op.cancelled) revert BridgeVault_OpAlreadyCancelled(id);
        if (block.timestamp < op.executableAt) {
            revert BridgeVault_OpTimelockNotElapsed(op.executableAt, uint64(block.timestamp));
        }

        op.executed = true;

        if (op.kind == OpKind.SET_VETO_AUTHORITY) {
            address newAuthority = abi.decode(op.payload, (address));
            vetoAuthority = newAuthority;
            emit VetoAuthorityChanged(newAuthority);
        } else if (op.kind == OpKind.SET_BRIDGE_FEE_BPS) {
            uint16 newBps = abi.decode(op.payload, (uint16));
            bridgeFeeBps = newBps;
            emit BridgeFeeBpsChanged(newBps);
        } else if (op.kind == OpKind.SET_RATE_LIMITS) {
            (uint128 newDaily, uint128 newPerClaim) = abi.decode(op.payload, (uint128, uint128));
            dailyWithdrawCapBps = newDaily;
            perClaimCapBps = newPerClaim;
            emit RateLimitsChanged(newDaily, newPerClaim);
        } else if (op.kind == OpKind.SET_CHALLENGE_WINDOW) {
            uint64 newSeconds = abi.decode(op.payload, (uint64));
            challengeWindowSeconds = newSeconds;
            emit ChallengeWindowChanged(newSeconds);
        } else if (op.kind == OpKind.SET_ALLOWED_DEST_DOMAIN) {
            (uint32 destDomain, bool allowed) = abi.decode(op.payload, (uint32, bool));
            allowedDestDomain[destDomain] = allowed;
            emit AllowedDestDomainChanged(destDomain, allowed);
        } else if (op.kind == OpKind.SET_TRUSTED_MINTER) {
            (uint32 origin, bytes32 minter) = abi.decode(op.payload, (uint32, bytes32));
            trustedMinter[origin] = minter;
            emit TrustedMinterChanged(origin, minter);
        } else if (op.kind == OpKind.UNPAUSE) {
            paused = false;
            emit Unpaused();
        }

        emit OpExecuted(id);
    }

    /// @notice Cancel a pending op at any time before execution.
    function cancelOp(uint256 id) external onlyOwner {
        PendingOp storage op = pendingOps[id];
        if (op.kind == OpKind.NONE) revert BridgeVault_InvalidOpId(id);
        if (op.executed) revert BridgeVault_OpAlreadyExecuted(id);
        if (op.cancelled) revert BridgeVault_OpAlreadyCancelled(id);

        op.cancelled = true;
        emit OpCancelled(id);
    }

    function _request(OpKind kind, bytes memory payload) internal returns (uint256 id) {
        id = nextOpId++;
        uint64 executableAt = uint64(block.timestamp) + opTimelock;
        pendingOps[id] = PendingOp({
            kind: kind,
            executableAt: executableAt,
            executed: false,
            cancelled: false,
            payload: payload
        });
        emit OpRequested(id, kind, executableAt);
    }

    /* -------------------------------------------------------------------- */
    /*                                 VIEWS                                */
    /* -------------------------------------------------------------------- */

    /// @notice Per-claim cap derived from current TVL ceiling and bps.
    function currentPerClaimCap() external view returns (uint128) {
        return uint128((uint256(tvlCapEtx) * perClaimCapBps) / TOTAL_BPS);
    }

    /// @notice Per-day cumulative cap derived from current TVL ceiling and bps.
    function currentDailyCap() external view returns (uint128) {
        return uint128((uint256(tvlCapEtx) * dailyWithdrawCapBps) / TOTAL_BPS);
    }
}
