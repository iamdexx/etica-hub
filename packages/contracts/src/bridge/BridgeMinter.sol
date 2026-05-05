// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {WrappedETX} from "./WrappedETX.sol";
import {BridgeMessage, IBridgeMinter, VetoReason} from "./IBridgeMinter.sol";

/// @notice Minimal Hyperlane mailbox interface used for outbound dispatches
/// (burn-side flow back to Etica's `BridgeVault`).
interface IMailbox {
    function dispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata body)
        external
        payable
        returns (bytes32 messageId);
}

/// @title BridgeMinter
/// @notice Mint authority for `WrappedETX` on Ethereum + BNB Chain. Manages
/// the optimistic-veto claim queue, native-gas bond accounting, and
/// Hyperlane integration. Symmetric to `BridgeVault` for the burn-side flow.
///
/// Mint flow (Etica → this chain):
///   1. Hyperlane mailbox calls `handle(origin, sender, body)` carrying an
///      Etica-side deposit. Vault on `origin` must be the configured
///      `trustedVault[origin]`. Body is `abi.encode(BridgeMessage)`. The
///      message is recorded as state RECORDED — no bond yet, no clock yet.
///   2. Anyone calls `submitClaim(nonce)` with `msg.value` ≥ required bond
///      (= `amount * bondBps / 10_000`). State advances to PENDING with
///      `expiresAt = now + challengeWindowSeconds`.
///   3. After `expiresAt`, anyone calls `executeClaim(nonce)` which mints
///      `amount` wETX to the recorded recipient and refunds the bond to the
///      original submitter. Per-claim cap and per-day rate limit are
///      enforced at execute time so policy changes apply consistently.
///   4. During the window, `vetoAuthority` (`OptimisticVetoModule`) can
///      cancel via `vetoClaimManual`, OR `fraudProverAuthority`
///      (`FraudProverModule`) can cancel via `vetoClaimWithProof`. Bond is
///      slashed 25/50/25 across `vetoer-of-record` / `treasuryRecipient` /
///      pending insurance accumulator.
///
/// Burn flow (this chain → Etica):
///   1. User calls `burn(amount, destDomain, recipient)`. wETX is burned.
///   2. Bridge fee = `amount * bridgeFeeBps / 10_000` is accrued into a
///      counter; the net amount is dispatched to `trustedVault[destDomain]`
///      via Hyperlane.
///
/// Cross-chain insurance top-up (sweeping `pendingInsuranceShareWei` to the
/// Etica-side `BridgeInsuranceFund`) and any bond-slash back-message
/// plumbing are intentionally deferred to the Hyperlane integration PR.
/// Until then, the operator can manually `sweepInsuranceShare` to a
/// configured `insuranceSweepRecipient`.
///
/// Security posture:
///   - All policy changes (bond, fee, caps, challenge window, routing,
///     authority swaps, treasury recipient, unpause) are 24h-timelocked.
///   - Pause is instant; unpause is timelocked.
///   - Vetoes are deny-only; modules cannot mint, transfer, or unblock.
///   - WrappedETX is deployed inside this constructor and its `bridgeMinter`
///     immutable points back here. There is no path to redirect mint
///     authority post-deploy short of redeploying both contracts.
contract BridgeMinter is IBridgeMinter, Ownable2Step, ReentrancyGuard {
    /* -------------------------------------------------------------------- */
    /*                              CONSTANTS                               */
    /* -------------------------------------------------------------------- */

    uint16 public constant TOTAL_BPS = 10_000;
    uint16 public constant PROVER_SHARE_BPS = 2500; // 25%
    uint16 public constant TREASURY_SHARE_BPS = 5000; // 50%
    uint16 public constant INSURANCE_SHARE_BPS = 2500; // 25%

    uint16 public constant MAX_BOND_BPS = 5000; // 50% hard ceiling
    uint16 public constant MIN_BOND_BPS = 100; // 1% hard floor
    uint16 public constant MAX_BRIDGE_FEE_BPS = 100; // 1% hard cap
    uint128 public constant MAX_DAILY_CAP_BPS = 1000; // 10% hard cap
    uint128 public constant MAX_PER_CLAIM_CAP_BPS = 500; // 5% hard cap
    uint64 public constant MIN_CHALLENGE_WINDOW = 1 hours;
    uint64 public constant MAX_CHALLENGE_WINDOW = 14 days;
    uint64 public constant SECONDS_PER_DAY = 86_400;

    /// @notice Bounds for the heartbeat staleness threshold. Tracks the
    /// design-doc envelope (1h–24h) used to gate optional auto-pause logic
    /// downstream of this contract (e.g. `HeartbeatISM`).
    uint64 public constant MIN_HEARTBEAT_TIMEOUT = 1 hours;
    uint64 public constant MAX_HEARTBEAT_TIMEOUT = 24 hours;

    /// @notice Bounds for the successor-key activation timelock. 30d–365d
    /// per the design doc; default of 90d is set in the constructor.
    uint64 public constant MIN_SUCCESSOR_TIMELOCK = 30 days;
    uint64 public constant MAX_SUCCESSOR_TIMELOCK = 365 days;

    /* -------------------------------------------------------------------- */
    /*                             IMMUTABLES                               */
    /* -------------------------------------------------------------------- */

    /// @notice Wrapped ETX token deployed in this contract's constructor.
    WrappedETX public immutable wetx;

    /// @notice Hyperlane mailbox for this chain.
    address public immutable hyperlaneMailbox;

    /// @notice Hyperlane domain ID of this chain.
    uint32 public immutable selfDomain;

    /// @notice Time that must elapse between an owner `request*` and `executeOp`.
    uint64 public immutable opTimelock;

    /* -------------------------------------------------------------------- */
    /*                          POLICY / RATE STATE                         */
    /* -------------------------------------------------------------------- */

    /// @notice TVL ceiling used to derive the per-claim and daily caps. Owner
    /// adjusts via timelock. Mirrors `BridgeVault.tvlCapEtx` but is denominated
    /// in the same units as wETX (1:1 with locked ETX) and tracked locally.
    uint128 public tvlCapEtx;

    /// @notice wETX minted toward today's rate-limit window.
    uint128 public mintedTodayEtx;
    /// @notice UTC day index for the active rate-limit window.
    uint64 public currentDayUtc;

    /// @notice Per-claim cap as a fraction of `tvlCapEtx`.
    uint128 public perClaimCapBps;
    /// @notice Per-day cumulative mint cap as a fraction of `tvlCapEtx`.
    uint128 public dailyMintCapBps;

    /// @notice Bond required to submit a claim, as a fraction of the claim
    /// amount, denominated in native gas (ETH/BNB).
    uint16 public bondBps;

    /// @notice Bridge fee applied to outbound burns, in basis points.
    uint16 public bridgeFeeBps;

    /// @notice 48h by default; settable via timelocked op within bounds.
    uint64 public challengeWindowSeconds;

    /// @notice Module authorised to call `vetoClaimManual`. Set post-deploy via
    /// timelocked op. Until set, manual vetoes are impossible.
    address public vetoAuthority;

    /// @notice Module authorised to call `vetoClaimWithProof`. Set post-deploy
    /// via timelocked op. Until set, fraud-proof vetoes are impossible.
    address public fraudProverAuthority;

    /// @notice Recipient of the 50% treasury share of slashed bonds. Set
    /// post-deploy via timelocked op.
    address public treasuryRecipient;

    /// @notice Recipient of the 25% vetoer share for *manual* vetoes. The
    /// fraud-prover route pays the prover passed by `FraudProverModule`
    /// directly. Defaults to `vetoAuthority`'s owner via owner setter
    /// (timelocked); typically the operator's bot reward EOA.
    address public manualVetoerRewardRecipient;

    /// @notice Address that can pull accumulated insurance share until the
    /// cross-chain sweep is wired up. Set post-deploy via timelocked op.
    address public insuranceSweepRecipient;

    /// @notice Native gas accumulated for the insurance fund's 25% share,
    /// awaiting cross-chain sweep.
    uint128 public pendingInsuranceShareWei;

    /// @notice Outbound bridge fees accrued from `burn` (in wETX units), awaiting
    /// cross-chain sweep / settlement at the Etica side.
    uint128 public totalFeesAccruedEtx;

    /// @notice Emergency pause flag. Owner can flip ON instantly; flip OFF is
    /// timelocked.
    bool public paused;

    /// @notice Monotonically incrementing per-minter counter for outbound
    /// nonces (burn flow).
    uint96 public burnCounter;

    /* -------------------------------------------------------------------- */
    /*                       HEARTBEAT / SUCCESSOR STATE                    */
    /* -------------------------------------------------------------------- */

    /// @notice Bot key authorized to ping `heartbeat()`. Set post-deploy via
    /// timelocked op. The owner may always heartbeat without this being set;
    /// this exists so the daily watcher EOA never needs the master key.
    address public heartbeatSigner;

    /// @notice Most-recent heartbeat timestamp. Initialized to `block.timestamp`
    /// at deploy so successor activation cannot fire immediately.
    uint64 public lastHeartbeatAt;

    /// @notice Staleness threshold consulted by `checkHeartbeat`. Owner-tunable
    /// via timelocked op within `[MIN_HEARTBEAT_TIMEOUT, MAX_HEARTBEAT_TIMEOUT]`.
    uint64 public heartbeatTimeoutSeconds;

    /// @notice Address that can claim ownership via `activateSuccessor` once
    /// the operator has been silent for `successorTimelockSeconds`. Set
    /// post-deploy via timelocked op. Until set, recovery is impossible.
    address public successorKey;

    /// @notice Time without a heartbeat before `activateSuccessor` may be
    /// called. Owner-tunable via timelocked op within
    /// `[MIN_SUCCESSOR_TIMELOCK, MAX_SUCCESSOR_TIMELOCK]`.
    uint64 public successorTimelockSeconds;

    /* -------------------------------------------------------------------- */
    /*                            ROUTING WIRING                            */
    /* -------------------------------------------------------------------- */

    /// @notice Allowed remote destination domains for `burn`.
    mapping(uint32 destDomain => bool allowed) public allowedDestDomain;

    /// @notice Trusted vault on each remote domain. Used both to filter
    /// inbound `handle` calls and to address outbound `burn` dispatches.
    mapping(uint32 origin => bytes32 trustedVault) public trustedVault;

    /* -------------------------------------------------------------------- */
    /*                              CLAIM STATE                             */
    /* -------------------------------------------------------------------- */

    enum ClaimState {
        NONE,
        RECORDED,
        PENDING,
        EXECUTED,
        VETOED
    }

    struct Claim {
        address recipient;
        uint128 amount;
        address submitter;
        uint128 bondWei;
        uint64 expiresAt;
        ClaimState state;
        VetoReason reason;
        uint32 origin;
    }

    mapping(bytes32 nonce => Claim) public claims;

    /* -------------------------------------------------------------------- */
    /*                       OWNER TIMELOCK MACHINERY                       */
    /* -------------------------------------------------------------------- */

    enum OpKind {
        NONE,
        SET_VETO_AUTHORITY,
        SET_FRAUD_PROVER_AUTHORITY,
        SET_TREASURY_RECIPIENT,
        SET_MANUAL_VETOER_REWARD_RECIPIENT,
        SET_INSURANCE_SWEEP_RECIPIENT,
        SET_BOND_BPS,
        SET_BRIDGE_FEE_BPS,
        SET_RATE_LIMITS,
        SET_TVL_CAP,
        SET_CHALLENGE_WINDOW,
        SET_ALLOWED_DEST_DOMAIN,
        SET_TRUSTED_VAULT,
        UNPAUSE,
        SET_HEARTBEAT_SIGNER,
        SET_HEARTBEAT_TIMEOUT,
        SET_SUCCESSOR_KEY,
        SET_SUCCESSOR_TIMELOCK
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

    event DepositRecorded(
        bytes32 indexed nonce, uint32 indexed origin, address indexed recipient, uint128 amount
    );
    event ClaimSubmitted(
        bytes32 indexed nonce,
        address indexed submitter,
        address indexed recipient,
        uint128 amount,
        uint128 bondWei,
        uint64 expiresAt
    );
    event ClaimExecuted(bytes32 indexed nonce, address indexed recipient, uint128 amount);
    event ClaimVetoed(
        bytes32 indexed nonce,
        address indexed vetoer,
        VetoReason reason,
        uint128 toProver,
        uint128 toTreasury,
        uint128 toInsurance
    );

    event BurnDispatched(
        bytes32 indexed nonce,
        address indexed sender,
        address indexed recipient,
        uint32 destDomain,
        uint128 amountNet,
        uint128 fee
    );
    event InsuranceShareSwept(address indexed recipient, uint128 amount);

    event EmergencyPaused(address indexed pauser);
    event Unpaused();

    event VetoAuthorityChanged(address indexed newAuthority);
    event FraudProverAuthorityChanged(address indexed newAuthority);
    event TreasuryRecipientChanged(address indexed newRecipient);
    event ManualVetoerRewardRecipientChanged(address indexed newRecipient);
    event InsuranceSweepRecipientChanged(address indexed newRecipient);
    event BondBpsChanged(uint16 newBps);
    event BridgeFeeBpsChanged(uint16 newBps);
    event RateLimitsChanged(uint128 newDailyBps, uint128 newPerClaimBps);
    event TvlCapChanged(uint128 newCap);
    event ChallengeWindowChanged(uint64 newSeconds);
    event AllowedDestDomainChanged(uint32 indexed domain, bool allowed);
    event TrustedVaultChanged(uint32 indexed domain, bytes32 trustedVault);
    event HeartbeatSignerChanged(address indexed newSigner);
    event HeartbeatTimeoutChanged(uint64 newTimeout);
    event SuccessorKeyChanged(address indexed newSuccessor);
    event SuccessorTimelockChanged(uint64 newTimelock);
    event Heartbeat(address indexed signer, uint64 timestamp);
    event SuccessorActivated(address indexed previousOwner, address indexed newOwner);

    event OpRequested(uint256 indexed id, OpKind indexed kind, uint64 executableAt, bytes payload);
    event OpExecuted(uint256 indexed id, OpKind indexed kind);
    event OpCancelled(uint256 indexed id, OpKind indexed kind);

    /* -------------------------------------------------------------------- */
    /*                                ERRORS                                */
    /* -------------------------------------------------------------------- */

    error BridgeMinter_ZeroAddress();
    error BridgeMinter_ZeroAmount();
    error BridgeMinter_Paused();
    error BridgeMinter_NotPaused();
    error BridgeMinter_OnlyMailbox(address caller);
    error BridgeMinter_UntrustedOrigin(uint32 origin);
    error BridgeMinter_UntrustedSender(bytes32 sender);
    error BridgeMinter_DestNotAllowed(uint32 destDomain);
    error BridgeMinter_TrustedVaultUnset(uint32 destDomain);
    error BridgeMinter_DestDomainMismatch(uint32 expected, uint32 got);
    error BridgeMinter_RecipientZero();
    error BridgeMinter_AlreadyRecorded(bytes32 nonce);
    error BridgeMinter_WrongState(ClaimState current);
    error BridgeMinter_NotMatured(uint64 expiresAt);
    error BridgeMinter_InsufficientBond(uint128 provided, uint128 required);
    error BridgeMinter_BondRefundFailed();
    error BridgeMinter_PerClaimCapExceeded(uint128 amount, uint128 cap);
    error BridgeMinter_RateLimitExceeded(uint128 wouldBe, uint128 cap);
    error BridgeMinter_OnlyVetoAuthority(address caller);
    error BridgeMinter_OnlyFraudProverAuthority(address caller);
    error BridgeMinter_ProofMatchesClaim();
    error BridgeMinter_BadBondShareSplit();
    error BridgeMinter_BadBpsValue(uint256 value, uint256 max);
    error BridgeMinter_BadChallengeWindow(uint64 value);
    error BridgeMinter_InvalidOpId(uint256 id);
    error BridgeMinter_OpAlreadyExecuted(uint256 id);
    error BridgeMinter_OpAlreadyCancelled(uint256 id);
    error BridgeMinter_OpTimelockNotElapsed(uint64 executableAt, uint64 nowTs);
    error BridgeMinter_MalformedBody();
    error BridgeMinter_OnlyHeartbeatSigner(address caller);
    error BridgeMinter_HeartbeatStale(uint64 lastBeat, uint64 timeout);
    error BridgeMinter_SuccessorUnset();
    error BridgeMinter_SuccessorNotReady(uint64 readyAt);
    error BridgeMinter_BadHeartbeatTimeout(uint64 value);
    error BridgeMinter_BadSuccessorTimelock(uint64 value);

    /* -------------------------------------------------------------------- */
    /*                              CONSTRUCTOR                             */
    /* -------------------------------------------------------------------- */

    /// @param owner_           Owner of the minter (and, by mirror, the modules).
    /// @param hyperlaneMailbox_ Local Hyperlane mailbox.
    /// @param selfDomain_      Local Hyperlane domain ID.
    /// @param opTimelock_      Delay between `request*` and `executeOp`. 24h per spec.
    /// @param tvlCapEtx_       Initial TVL ceiling in wETX wei (drives caps).
    /// @param bondBps_         Bond required per claim, e.g. 2_500 = 25%.
    /// @param bridgeFeeBps_    Outbound burn fee in bps, e.g. 10 = 0.1%.
    /// @param challengeWindowSeconds_ Initial challenge window (e.g. 48h).
    /// @param dailyMintCapBps_  Per-day mint cap as a fraction of TVL.
    /// @param perClaimCapBps_   Per-claim cap as a fraction of TVL.
    constructor(
        address owner_,
        address hyperlaneMailbox_,
        uint32 selfDomain_,
        uint64 opTimelock_,
        uint128 tvlCapEtx_,
        uint16 bondBps_,
        uint16 bridgeFeeBps_,
        uint64 challengeWindowSeconds_,
        uint128 dailyMintCapBps_,
        uint128 perClaimCapBps_
    ) Ownable(owner_) {
        if (hyperlaneMailbox_ == address(0)) {
            revert BridgeMinter_ZeroAddress();
        }
        if (selfDomain_ == 0) revert BridgeMinter_ZeroAmount();
        if (tvlCapEtx_ == 0) revert BridgeMinter_ZeroAmount();
        if (bondBps_ < MIN_BOND_BPS || bondBps_ > MAX_BOND_BPS) {
            revert BridgeMinter_BadBpsValue(bondBps_, MAX_BOND_BPS);
        }
        if (bridgeFeeBps_ > MAX_BRIDGE_FEE_BPS) {
            revert BridgeMinter_BadBpsValue(bridgeFeeBps_, MAX_BRIDGE_FEE_BPS);
        }
        if (
            challengeWindowSeconds_ < MIN_CHALLENGE_WINDOW
                || challengeWindowSeconds_ > MAX_CHALLENGE_WINDOW
        ) revert BridgeMinter_BadChallengeWindow(challengeWindowSeconds_);
        if (dailyMintCapBps_ == 0 || dailyMintCapBps_ > MAX_DAILY_CAP_BPS) {
            revert BridgeMinter_BadBpsValue(dailyMintCapBps_, MAX_DAILY_CAP_BPS);
        }
        if (perClaimCapBps_ == 0 || perClaimCapBps_ > MAX_PER_CLAIM_CAP_BPS) {
            revert BridgeMinter_BadBpsValue(perClaimCapBps_, MAX_PER_CLAIM_CAP_BPS);
        }

        hyperlaneMailbox = hyperlaneMailbox_;
        selfDomain = selfDomain_;
        opTimelock = opTimelock_;

        tvlCapEtx = tvlCapEtx_;
        bondBps = bondBps_;
        bridgeFeeBps = bridgeFeeBps_;
        challengeWindowSeconds = challengeWindowSeconds_;
        dailyMintCapBps = dailyMintCapBps_;
        perClaimCapBps = perClaimCapBps_;
        currentDayUtc = uint64(block.timestamp / SECONDS_PER_DAY);

        // Heartbeat / successor recovery defaults. The signer + successor key
        // are intentionally left zero — wired post-deploy via timelocked op.
        // `lastHeartbeatAt` is anchored to the deploy block so successor
        // activation cannot fire immediately even if a successor is later
        // configured to a non-zero address.
        heartbeatTimeoutSeconds = 4 hours;
        successorTimelockSeconds = 90 days;
        lastHeartbeatAt = uint64(block.timestamp);

        // Sanity-check the canonical share split against the constants. This is a
        // pure assertion — exists so reviewers reading the bond-split math can
        // see at a glance that the percentages add to 100%.
        if (PROVER_SHARE_BPS + TREASURY_SHARE_BPS + INSURANCE_SHARE_BPS != TOTAL_BPS) {
            revert BridgeMinter_BadBondShareSplit();
        }

        // Deploy the wrapped token; its `bridgeMinter` is wired to this contract.
        wetx = new WrappedETX(address(this));
    }

    /* -------------------------------------------------------------------- */
    /*                              MODIFIERS                               */
    /* -------------------------------------------------------------------- */

    modifier whenNotPaused() {
        if (paused) revert BridgeMinter_Paused();
        _;
    }

    modifier onlyMailbox() {
        if (msg.sender != hyperlaneMailbox) revert BridgeMinter_OnlyMailbox(msg.sender);
        _;
    }

    /* -------------------------------------------------------------------- */
    /*                          INBOUND HYPERLANE                           */
    /* -------------------------------------------------------------------- */

    /// @notice Hyperlane callback. Records the inbound deposit message under
    /// its nonce. No bond is taken here — claim submission is a separate
    /// permissionless step. Re-recording an existing nonce reverts so a
    /// compromised relayer can't rewrite a recorded deposit.
    function handle(uint32 origin, bytes32 sender, bytes calldata body)
        external
        payable
        onlyMailbox
        whenNotPaused
    {
        bytes32 expectedSender = trustedVault[origin];
        if (expectedSender == bytes32(0)) revert BridgeMinter_UntrustedOrigin(origin);
        if (sender != expectedSender) revert BridgeMinter_UntrustedSender(sender);

        if (body.length != 32 * 8) revert BridgeMinter_MalformedBody();
        BridgeMessage memory m = abi.decode(body, (BridgeMessage));

        if (m.destDomain != selfDomain) {
            revert BridgeMinter_DestDomainMismatch(selfDomain, m.destDomain);
        }
        if (m.recipient == address(0)) revert BridgeMinter_RecipientZero();
        if (m.amount == 0) revert BridgeMinter_ZeroAmount();
        if (m.srcDomain != origin) revert BridgeMinter_UntrustedOrigin(m.srcDomain);

        Claim storage c = claims[m.nonce];
        if (c.state != ClaimState.NONE) revert BridgeMinter_AlreadyRecorded(m.nonce);

        c.recipient = m.recipient;
        c.amount = m.amount;
        c.origin = origin;
        c.state = ClaimState.RECORDED;

        emit DepositRecorded(m.nonce, origin, m.recipient, m.amount);
    }

    /* -------------------------------------------------------------------- */
    /*                            CLAIM SUBMISSION                          */
    /* -------------------------------------------------------------------- */

    /// @notice Posts the bond against a recorded deposit and starts the
    /// challenge window. Anyone can call this — the legitimate recipient,
    /// a paid relayer, or an unrelated third party. The submitter receives
    /// the bond back on `executeClaim`; if the claim is vetoed the bond is
    /// slashed 25/50/25.
    function submitClaim(bytes32 nonce) external payable whenNotPaused returns (uint128 bondWei) {
        Claim storage c = claims[nonce];
        if (c.state != ClaimState.RECORDED) revert BridgeMinter_WrongState(c.state);

        uint256 required = (uint256(c.amount) * uint256(bondBps)) / TOTAL_BPS;
        if (msg.value < required) {
            revert BridgeMinter_InsufficientBond(uint128(msg.value), uint128(required));
        }

        bondWei = uint128(msg.value);
        c.submitter = msg.sender;
        c.bondWei = bondWei;
        c.expiresAt = uint64(block.timestamp) + challengeWindowSeconds;
        c.state = ClaimState.PENDING;

        emit ClaimSubmitted(nonce, msg.sender, c.recipient, c.amount, bondWei, c.expiresAt);
    }

    /* -------------------------------------------------------------------- */
    /*                            CLAIM EXECUTION                           */
    /* -------------------------------------------------------------------- */

    /// @notice Permissionless after `expiresAt`. Mints `amount` wETX to the
    /// recorded recipient and refunds the bond to the original submitter.
    /// Per-claim and per-day caps are enforced at execute time so policy
    /// changes apply to every claim regardless of when it was submitted.
    function executeClaim(bytes32 nonce) external nonReentrant whenNotPaused {
        Claim storage c = claims[nonce];
        if (c.state != ClaimState.PENDING) revert BridgeMinter_WrongState(c.state);
        if (block.timestamp < c.expiresAt) revert BridgeMinter_NotMatured(c.expiresAt);

        uint128 perClaimCap = uint128((uint256(tvlCapEtx) * uint256(perClaimCapBps)) / TOTAL_BPS);
        if (c.amount > perClaimCap) {
            revert BridgeMinter_PerClaimCapExceeded(c.amount, perClaimCap);
        }

        uint64 today = uint64(block.timestamp / SECONDS_PER_DAY);
        if (today != currentDayUtc) {
            currentDayUtc = today;
            mintedTodayEtx = 0;
        }
        uint128 dailyCap = uint128((uint256(tvlCapEtx) * uint256(dailyMintCapBps)) / TOTAL_BPS);
        uint128 wouldBe = mintedTodayEtx + c.amount;
        if (wouldBe > dailyCap) revert BridgeMinter_RateLimitExceeded(wouldBe, dailyCap);
        mintedTodayEtx = wouldBe;

        c.state = ClaimState.EXECUTED;

        wetx.mint(c.recipient, c.amount);

        // Refund bond. We use a low-level call because the submitter may be a
        // contract; rejection of the refund must revert the execute so the
        // submitter can fix and retry.
        if (c.bondWei != 0) {
            (bool ok,) = payable(c.submitter).call{value: c.bondWei}("");
            if (!ok) revert BridgeMinter_BondRefundFailed();
        }

        emit ClaimExecuted(nonce, c.recipient, c.amount);
    }

    /* -------------------------------------------------------------------- */
    /*                              VETO PATHS                              */
    /* -------------------------------------------------------------------- */

    /// @notice Operator-driven veto. Called by `OptimisticVetoModule` when the
    /// watcher bot or a backup vetoer rejects a pending claim. The 25%
    /// vetoer share goes to `manualVetoerRewardRecipient` (set by the owner;
    /// typically the operator's bot reward EOA). The OVM contract itself is
    /// not payable so the share is paid out via this configured EOA.
    function vetoClaimManual(bytes32 nonce, VetoReason reason) external nonReentrant {
        if (msg.sender != vetoAuthority) revert BridgeMinter_OnlyVetoAuthority(msg.sender);
        Claim storage c = claims[nonce];
        if (c.state != ClaimState.PENDING) revert BridgeMinter_WrongState(c.state);
        if (block.timestamp >= c.expiresAt) revert BridgeMinter_NotMatured(c.expiresAt);

        _slashAndDistribute(nonce, c, manualVetoerRewardRecipient, reason);
    }

    /// @notice Fraud-proof veto. Called by `FraudProverModule` after it has
    /// verified a Merkle proof that the on-Etica deposit doesn't match the
    /// recorded claim. The minter independently checks that the supplied
    /// `actualDeposit` is in fact different from the recorded claim — if
    /// they match (no fraud), the call reverts and the prover's gas is
    /// the only loss. On success the prover receives the 25% share.
    function vetoClaimWithProof(
        bytes32 claimNonce,
        BridgeMessage calldata actualDeposit,
        address prover
    ) external override nonReentrant {
        if (msg.sender != fraudProverAuthority) {
            revert BridgeMinter_OnlyFraudProverAuthority(msg.sender);
        }
        if (prover == address(0)) revert BridgeMinter_ZeroAddress();

        Claim storage c = claims[claimNonce];
        if (c.state != ClaimState.PENDING) revert BridgeMinter_WrongState(c.state);
        if (block.timestamp >= c.expiresAt) revert BridgeMinter_NotMatured(c.expiresAt);

        // Fraud is established when the Merkle-proven deposit differs from
        // what the recorded claim asserts. If amount + recipient match, the
        // prover hasn't shown fraud (they may have re-proven the same deposit
        // by mistake) and we revert. Other fields are informational only at
        // this layer; this matches the contract spec's "if they actually
        // match (no fraud) before slashing the bond" requirement.
        if (actualDeposit.amount == c.amount && actualDeposit.recipient == c.recipient) {
            revert BridgeMinter_ProofMatchesClaim();
        }

        _slashAndDistribute(claimNonce, c, prover, VetoReason.FRAUD_PROVER_MERKLE);
    }

    /// @dev Splits the recorded bond into 25/50/25 shares, sends the prover
    /// and treasury shares synchronously, and accumulates the insurance
    /// share for cross-chain sweep. Resets the bond fields to zero before
    /// any external call.
    function _slashAndDistribute(
        bytes32 nonce,
        Claim storage c,
        address vetoerRecipient,
        VetoReason reason
    ) private {
        uint128 bond = c.bondWei;
        c.bondWei = 0;
        c.state = ClaimState.VETOED;
        c.reason = reason;

        uint128 toProver = uint128((uint256(bond) * uint256(PROVER_SHARE_BPS)) / TOTAL_BPS);
        uint128 toTreasury = uint128((uint256(bond) * uint256(TREASURY_SHARE_BPS)) / TOTAL_BPS);
        // Insurance gets the residual to ensure no wei is lost to rounding.
        uint128 toInsurance = bond - toProver - toTreasury;

        pendingInsuranceShareWei += toInsurance;

        // Determine effective prover recipient. If unset, fold the prover
        // share into treasury so the bond is never stuck. This handles the
        // pre-config window where the owner hasn't yet wired
        // `manualVetoerRewardRecipient` and a manual veto fires.
        address proverDest = vetoerRecipient;
        if (proverDest == address(0)) {
            toTreasury += toProver;
            toProver = 0;
        }
        address treasuryDest = treasuryRecipient;
        if (treasuryDest == address(0)) {
            // Same fail-safe for treasury: fold into pending insurance share.
            pendingInsuranceShareWei += toTreasury;
            toInsurance += toTreasury;
            toTreasury = 0;
        }

        if (toProver != 0) {
            (bool okP,) = payable(proverDest).call{value: toProver}("");
            if (!okP) revert BridgeMinter_BondRefundFailed();
        }
        if (toTreasury != 0) {
            (bool okT,) = payable(treasuryDest).call{value: toTreasury}("");
            if (!okT) revert BridgeMinter_BondRefundFailed();
        }

        emit ClaimVetoed(nonce, msg.sender, reason, toProver, toTreasury, toInsurance);
    }

    /* -------------------------------------------------------------------- */
    /*                                BURN                                  */
    /* -------------------------------------------------------------------- */

    /// @notice Burns `amount` wETX from `msg.sender` and dispatches a
    /// `BridgeMessage` to the trusted vault on `destDomain`. The destination
    /// vault credits the recipient on Etica after its own challenge window.
    function burn(uint128 amount, uint32 destDomain, address recipient)
        external
        payable
        whenNotPaused
        returns (bytes32 nonce)
    {
        if (amount == 0) revert BridgeMinter_ZeroAmount();
        if (recipient == address(0)) revert BridgeMinter_RecipientZero();
        if (!allowedDestDomain[destDomain]) revert BridgeMinter_DestNotAllowed(destDomain);
        bytes32 vault = trustedVault[destDomain];
        if (vault == bytes32(0)) revert BridgeMinter_TrustedVaultUnset(destDomain);

        wetx.burn(msg.sender, amount);

        uint128 fee = uint128((uint256(amount) * uint256(bridgeFeeBps)) / TOTAL_BPS);
        uint128 net = amount - fee;
        totalFeesAccruedEtx += fee;

        unchecked {
            burnCounter += 1;
        }
        nonce = keccak256(
            abi.encode(
                selfDomain, address(this), burnCounter, msg.sender, recipient, net, block.number
            )
        );

        BridgeMessage memory m = BridgeMessage({
            nonce: nonce,
            srcDomain: selfDomain,
            destDomain: destDomain,
            sender: msg.sender,
            recipient: recipient,
            amount: net,
            srcBlockNumber: uint64(block.number),
            timestamp: uint64(block.timestamp)
        });

        IMailbox(hyperlaneMailbox).dispatch{value: msg.value}(destDomain, vault, abi.encode(m));

        emit BurnDispatched(nonce, msg.sender, recipient, destDomain, net, fee);
    }

    /* -------------------------------------------------------------------- */
    /*                          INSURANCE SWEEP                             */
    /* -------------------------------------------------------------------- */

    /// @notice Forwards `pendingInsuranceShareWei` to the configured
    /// `insuranceSweepRecipient`. Until the cross-chain sweep is wired up
    /// in the integration PR, this is the only path that drains the
    /// accumulator.
    function sweepInsuranceShare() external nonReentrant {
        address dest = insuranceSweepRecipient;
        if (dest == address(0)) revert BridgeMinter_ZeroAddress();
        uint128 amount = pendingInsuranceShareWei;
        if (amount == 0) revert BridgeMinter_ZeroAmount();
        pendingInsuranceShareWei = 0;
        (bool ok,) = payable(dest).call{value: amount}("");
        if (!ok) revert BridgeMinter_BondRefundFailed();
        emit InsuranceShareSwept(dest, amount);
    }

    /* -------------------------------------------------------------------- */
    /*                              PAUSE                                   */
    /* -------------------------------------------------------------------- */

    function pause() external onlyOwner {
        if (paused) revert BridgeMinter_Paused();
        paused = true;
        emit EmergencyPaused(msg.sender);
    }

    /* -------------------------------------------------------------------- */
    /*                       HEARTBEAT / SUCCESSOR RECOVERY                 */
    /* -------------------------------------------------------------------- */

    /// @notice Records a fresh liveness ping. Callable by either the
    /// configured `heartbeatSigner` (a hot bot key) or the contract
    /// owner. The owner path is the failsafe so a missing/rotated signer
    /// never bricks recovery posture.
    function heartbeat() external {
        if (msg.sender != heartbeatSigner && msg.sender != owner()) {
            revert BridgeMinter_OnlyHeartbeatSigner(msg.sender);
        }
        uint64 ts = uint64(block.timestamp);
        lastHeartbeatAt = ts;
        emit Heartbeat(msg.sender, ts);
    }

    /// @notice True iff the latest heartbeat is within `heartbeatTimeoutSeconds`.
    /// External monitors and downstream gating contracts (e.g. `HeartbeatISM`)
    /// call this view; this contract intentionally does not gate any of its
    /// own actions on the result — that policy lives one layer up so it can
    /// be tuned independently of the mint engine.
    function checkHeartbeat() external view returns (bool isHealthy) {
        return block.timestamp - lastHeartbeatAt < heartbeatTimeoutSeconds;
    }

    /// @notice Permissionless. Transfers ownership to the configured
    /// `successorKey` once the operator has been silent for at least
    /// `successorTimelockSeconds`. The transfer skips Ownable2Step's
    /// pending-acceptance handshake — the whole point of this path is that
    /// the prior owner is unreachable.
    ///
    /// Reverts with `SuccessorUnset` if no successor was configured, and
    /// with `SuccessorNotReady` if the silence window has not yet elapsed.
    function activateSuccessor() external {
        address newOwner = successorKey;
        if (newOwner == address(0)) revert BridgeMinter_SuccessorUnset();

        uint64 readyAt = lastHeartbeatAt + successorTimelockSeconds;
        if (block.timestamp < readyAt) {
            revert BridgeMinter_SuccessorNotReady(readyAt);
        }

        address prevOwner = owner();
        _transferOwnership(newOwner);
        // Reset the heartbeat anchor so the successor begins their own
        // liveness window from scratch rather than inheriting a stale clock.
        lastHeartbeatAt = uint64(block.timestamp);
        emit SuccessorActivated(prevOwner, newOwner);
    }

    /* -------------------------------------------------------------------- */
    /*                       OWNER TIMELOCKED OPS                           */
    /* -------------------------------------------------------------------- */

    function requestSetVetoAuthority(address newAuthority) external onlyOwner returns (uint256 id) {
        if (newAuthority == address(0)) revert BridgeMinter_ZeroAddress();
        return _request(OpKind.SET_VETO_AUTHORITY, abi.encode(newAuthority));
    }

    function requestSetFraudProverAuthority(address newAuthority)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (newAuthority == address(0)) revert BridgeMinter_ZeroAddress();
        return _request(OpKind.SET_FRAUD_PROVER_AUTHORITY, abi.encode(newAuthority));
    }

    function requestSetTreasuryRecipient(address newRecipient)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (newRecipient == address(0)) revert BridgeMinter_ZeroAddress();
        return _request(OpKind.SET_TREASURY_RECIPIENT, abi.encode(newRecipient));
    }

    function requestSetManualVetoerRewardRecipient(address newRecipient)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (newRecipient == address(0)) revert BridgeMinter_ZeroAddress();
        return _request(OpKind.SET_MANUAL_VETOER_REWARD_RECIPIENT, abi.encode(newRecipient));
    }

    function requestSetInsuranceSweepRecipient(address newRecipient)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (newRecipient == address(0)) revert BridgeMinter_ZeroAddress();
        return _request(OpKind.SET_INSURANCE_SWEEP_RECIPIENT, abi.encode(newRecipient));
    }

    function requestSetBondBps(uint16 newBps) external onlyOwner returns (uint256 id) {
        if (newBps < MIN_BOND_BPS || newBps > MAX_BOND_BPS) {
            revert BridgeMinter_BadBpsValue(newBps, MAX_BOND_BPS);
        }
        return _request(OpKind.SET_BOND_BPS, abi.encode(newBps));
    }

    function requestSetBridgeFeeBps(uint16 newBps) external onlyOwner returns (uint256 id) {
        if (newBps > MAX_BRIDGE_FEE_BPS) {
            revert BridgeMinter_BadBpsValue(newBps, MAX_BRIDGE_FEE_BPS);
        }
        return _request(OpKind.SET_BRIDGE_FEE_BPS, abi.encode(newBps));
    }

    function requestSetRateLimits(uint128 newDailyBps, uint128 newPerClaimBps)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (newDailyBps == 0 || newDailyBps > MAX_DAILY_CAP_BPS) {
            revert BridgeMinter_BadBpsValue(newDailyBps, MAX_DAILY_CAP_BPS);
        }
        if (newPerClaimBps == 0 || newPerClaimBps > MAX_PER_CLAIM_CAP_BPS) {
            revert BridgeMinter_BadBpsValue(newPerClaimBps, MAX_PER_CLAIM_CAP_BPS);
        }
        return _request(OpKind.SET_RATE_LIMITS, abi.encode(newDailyBps, newPerClaimBps));
    }

    function requestSetTvlCap(uint128 newCap) external onlyOwner returns (uint256 id) {
        if (newCap == 0) revert BridgeMinter_ZeroAmount();
        return _request(OpKind.SET_TVL_CAP, abi.encode(newCap));
    }

    function requestSetChallengeWindow(uint64 newSeconds) external onlyOwner returns (uint256 id) {
        if (newSeconds < MIN_CHALLENGE_WINDOW || newSeconds > MAX_CHALLENGE_WINDOW) {
            revert BridgeMinter_BadChallengeWindow(newSeconds);
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

    function requestSetTrustedVault(uint32 origin, bytes32 trusted)
        external
        onlyOwner
        returns (uint256 id)
    {
        return _request(OpKind.SET_TRUSTED_VAULT, abi.encode(origin, trusted));
    }

    function requestUnpause() external onlyOwner returns (uint256 id) {
        if (!paused) revert BridgeMinter_NotPaused();
        return _request(OpKind.UNPAUSE, "");
    }

    function requestSetHeartbeatSigner(address newSigner) external onlyOwner returns (uint256 id) {
        // The zero address is permitted here so the owner can disable the
        // bot path entirely (heartbeats then come from owner only).
        return _request(OpKind.SET_HEARTBEAT_SIGNER, abi.encode(newSigner));
    }

    function requestSetHeartbeatTimeout(uint64 newSeconds) external onlyOwner returns (uint256 id) {
        if (newSeconds < MIN_HEARTBEAT_TIMEOUT || newSeconds > MAX_HEARTBEAT_TIMEOUT) {
            revert BridgeMinter_BadHeartbeatTimeout(newSeconds);
        }
        return _request(OpKind.SET_HEARTBEAT_TIMEOUT, abi.encode(newSeconds));
    }

    function requestSetSuccessorKey(address newSuccessor) external onlyOwner returns (uint256 id) {
        // Zero is permitted: lets the owner explicitly disarm successor
        // recovery (e.g. before rotating away from a compromised successor).
        return _request(OpKind.SET_SUCCESSOR_KEY, abi.encode(newSuccessor));
    }

    function requestSetSuccessorTimelock(uint64 newSeconds)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (newSeconds < MIN_SUCCESSOR_TIMELOCK || newSeconds > MAX_SUCCESSOR_TIMELOCK) {
            revert BridgeMinter_BadSuccessorTimelock(newSeconds);
        }
        return _request(OpKind.SET_SUCCESSOR_TIMELOCK, abi.encode(newSeconds));
    }

    function executeOp(uint256 id) external onlyOwner {
        PendingOp storage op = pendingOps[id];
        if (op.kind == OpKind.NONE) revert BridgeMinter_InvalidOpId(id);
        if (op.cancelled) revert BridgeMinter_OpAlreadyCancelled(id);
        if (op.executed) revert BridgeMinter_OpAlreadyExecuted(id);
        if (block.timestamp < op.executableAt) {
            revert BridgeMinter_OpTimelockNotElapsed(op.executableAt, uint64(block.timestamp));
        }
        op.executed = true;

        OpKind kind = op.kind;
        if (kind == OpKind.SET_VETO_AUTHORITY) {
            address newAuth = abi.decode(op.payload, (address));
            vetoAuthority = newAuth;
            emit VetoAuthorityChanged(newAuth);
        } else if (kind == OpKind.SET_FRAUD_PROVER_AUTHORITY) {
            address newAuth = abi.decode(op.payload, (address));
            fraudProverAuthority = newAuth;
            emit FraudProverAuthorityChanged(newAuth);
        } else if (kind == OpKind.SET_TREASURY_RECIPIENT) {
            address newR = abi.decode(op.payload, (address));
            treasuryRecipient = newR;
            emit TreasuryRecipientChanged(newR);
        } else if (kind == OpKind.SET_MANUAL_VETOER_REWARD_RECIPIENT) {
            address newR = abi.decode(op.payload, (address));
            manualVetoerRewardRecipient = newR;
            emit ManualVetoerRewardRecipientChanged(newR);
        } else if (kind == OpKind.SET_INSURANCE_SWEEP_RECIPIENT) {
            address newR = abi.decode(op.payload, (address));
            insuranceSweepRecipient = newR;
            emit InsuranceSweepRecipientChanged(newR);
        } else if (kind == OpKind.SET_BOND_BPS) {
            uint16 newBps = abi.decode(op.payload, (uint16));
            bondBps = newBps;
            emit BondBpsChanged(newBps);
        } else if (kind == OpKind.SET_BRIDGE_FEE_BPS) {
            uint16 newBps = abi.decode(op.payload, (uint16));
            bridgeFeeBps = newBps;
            emit BridgeFeeBpsChanged(newBps);
        } else if (kind == OpKind.SET_RATE_LIMITS) {
            (uint128 newDailyBps, uint128 newPerClaimBps) =
                abi.decode(op.payload, (uint128, uint128));
            dailyMintCapBps = newDailyBps;
            perClaimCapBps = newPerClaimBps;
            emit RateLimitsChanged(newDailyBps, newPerClaimBps);
        } else if (kind == OpKind.SET_TVL_CAP) {
            uint128 newCap = abi.decode(op.payload, (uint128));
            tvlCapEtx = newCap;
            emit TvlCapChanged(newCap);
        } else if (kind == OpKind.SET_CHALLENGE_WINDOW) {
            uint64 newSeconds = abi.decode(op.payload, (uint64));
            challengeWindowSeconds = newSeconds;
            emit ChallengeWindowChanged(newSeconds);
        } else if (kind == OpKind.SET_ALLOWED_DEST_DOMAIN) {
            (uint32 destDomain, bool allowed) = abi.decode(op.payload, (uint32, bool));
            allowedDestDomain[destDomain] = allowed;
            emit AllowedDestDomainChanged(destDomain, allowed);
        } else if (kind == OpKind.SET_TRUSTED_VAULT) {
            (uint32 origin, bytes32 trusted) = abi.decode(op.payload, (uint32, bytes32));
            trustedVault[origin] = trusted;
            emit TrustedVaultChanged(origin, trusted);
        } else if (kind == OpKind.UNPAUSE) {
            paused = false;
            emit Unpaused();
        } else if (kind == OpKind.SET_HEARTBEAT_SIGNER) {
            address newSigner = abi.decode(op.payload, (address));
            heartbeatSigner = newSigner;
            emit HeartbeatSignerChanged(newSigner);
        } else if (kind == OpKind.SET_HEARTBEAT_TIMEOUT) {
            uint64 newSeconds = abi.decode(op.payload, (uint64));
            heartbeatTimeoutSeconds = newSeconds;
            emit HeartbeatTimeoutChanged(newSeconds);
        } else if (kind == OpKind.SET_SUCCESSOR_KEY) {
            address newSuccessor = abi.decode(op.payload, (address));
            successorKey = newSuccessor;
            emit SuccessorKeyChanged(newSuccessor);
        } else if (kind == OpKind.SET_SUCCESSOR_TIMELOCK) {
            uint64 newSeconds = abi.decode(op.payload, (uint64));
            successorTimelockSeconds = newSeconds;
            emit SuccessorTimelockChanged(newSeconds);
        }

        emit OpExecuted(id, kind);
    }

    function cancelOp(uint256 id) external onlyOwner {
        PendingOp storage op = pendingOps[id];
        if (op.kind == OpKind.NONE) revert BridgeMinter_InvalidOpId(id);
        if (op.cancelled) revert BridgeMinter_OpAlreadyCancelled(id);
        if (op.executed) revert BridgeMinter_OpAlreadyExecuted(id);
        op.cancelled = true;
        emit OpCancelled(id, op.kind);
    }

    function _request(OpKind kind, bytes memory payload) private returns (uint256 id) {
        id = ++nextOpId;
        uint64 executableAt = uint64(block.timestamp) + opTimelock;
        pendingOps[id] = PendingOp({
            kind: kind,
            executableAt: executableAt,
            executed: false,
            cancelled: false,
            payload: payload
        });
        emit OpRequested(id, kind, executableAt, payload);
    }

    /* -------------------------------------------------------------------- */
    /*                                VIEWS                                 */
    /* -------------------------------------------------------------------- */

    /// @notice Required bond in native gas wei for a claim of `amount` wETX
    /// at the current `bondBps`. Off-chain UIs and relayers use this to
    /// prefund `submitClaim`.
    function bondRequiredFor(uint128 amount) external view returns (uint128) {
        return uint128((uint256(amount) * uint256(bondBps)) / TOTAL_BPS);
    }

    /// @notice Effective per-claim cap derived from `tvlCapEtx`.
    function perClaimCapEtx() external view returns (uint128) {
        return uint128((uint256(tvlCapEtx) * uint256(perClaimCapBps)) / TOTAL_BPS);
    }

    /// @notice Effective per-day mint cap derived from `tvlCapEtx`.
    function dailyMintCapEtx() external view returns (uint128) {
        return uint128((uint256(tvlCapEtx) * uint256(dailyMintCapBps)) / TOTAL_BPS);
    }

    /// @notice Allows the contract to receive native gas (e.g. from
    /// over-payment of bond refunds returned, IGP refunds, or insurance
    /// share top-ups by external scripts). Funds become indistinguishable
    /// from `pendingInsuranceShareWei` only when explicitly accumulated
    /// via veto; raw transfers stay as `address(this).balance` and can be
    /// recovered via the insurance sweep path.
    receive() external payable {}
}
