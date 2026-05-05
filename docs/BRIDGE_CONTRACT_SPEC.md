# EticaHub Bridge — Contract Specification

**Status:** draft v0.1 — function-level spec, ready for review before implementation
**Predecessor:** [`BRIDGE_DESIGN.md`](./BRIDGE_DESIGN.md) — architecture-level spec, merged in PR #157
**Phase:** Phase 3 contract specification
**Implementation:** blocked until this spec is approved

---

## 0. Reading guide

This document specifies every contract that ships in the Phase 3 bridge: storage layout, public/external function signatures, events, custom errors, modifiers, and integration points with Hyperlane. **No implementation logic is included here — this is the contract surface, not the body.** Implementation comes after this is approved.

Naming conventions:

- `slot` annotations indicate ABI-encoded storage slot for the variable. Used to flag tight packing and reserve space for future fields.
- `view`/`pure` follows Solidity idiom; functions without those modifiers mutate state.
- Custom errors prefixed with the contract name (e.g. `BridgeVault.ZeroAmount`) reduce gas vs string reverts.
- All amounts in 18-decimal ETX wei unless explicitly noted.
- All chain IDs are uint32 (Hyperlane's domain type), distinct from EVM chain IDs.

Hyperlane domain → EVM chain ID mapping used throughout:

| Hyperlane domain | EVM chain ID | Network |
|---|---|---|
| `61803` | `61803` | Etica |
| `1` | `1` | Ethereum mainnet |
| `56` | `56` | BNB Chain |
| `tron-3` (TBD) | n/a | Tron (Phase 3c) |

---

## 1. Shared types and errors

### 1.1 Common types

```solidity
// Identifies a single bridge transfer end-to-end across two chains.
// Constructed on the source chain at deposit time; immutable for life of the claim.
struct BridgeMessage {
    bytes32 nonce;            // unique per source contract + counter
    uint32  srcDomain;        // Hyperlane domain of the source chain
    uint32  destDomain;       // Hyperlane domain of the destination chain
    address sender;           // depositor on source chain
    address recipient;        // recipient on destination chain
    uint128 amount;           // net amount (post-fee) in 18-dec ETX wei
    uint64  srcBlockNumber;   // for fraud-proof verification
    uint64  timestamp;        // source-chain block timestamp at deposit
}

// State of a withdrawal claim on the destination chain.
enum ClaimState {
    NONE,        // never seen
    PENDING,     // submitted, in challenge window
    EXECUTED,    // passed window, wETX minted
    VETOED,      // operator or fraud-prover rejected; bond slashed
    CANCELLED    // submitter cancelled before any veto (refund - rare)
}

struct Claim {
    BridgeMessage msg_;
    address       submitter;
    uint128       bondAmount;
    uint64        submittedAt;
    uint64        expiresAt;
    ClaimState    state;
    uint8         vetoReason;    // enum below
}

enum VetoReason {
    NONE,
    OPERATOR_MANUAL,        // operator pressed the veto button
    BOT_DEPOSIT_NOT_FOUND,  // bot couldn't find the deposit on Etica
    BOT_AMOUNT_MISMATCH,    // bot found deposit but amount differs
    BOT_RECIPIENT_MISMATCH, // bot found deposit but recipient differs
    FRAUD_PROVER_MERKLE,    // community prover submitted Merkle proof
    HYPERLANE_REJECT        // Hyperlane ISM rejected the message
}
```

### 1.2 Common custom errors

```solidity
error ZeroAddress();
error ZeroAmount();
error NotOwner();
error NotEmergencyPauser();
error Paused();
error NotPaused();
error TimelockNotElapsed(uint64 readyAt);
error UnauthorizedCaller(address caller);
error ChainIdMismatch(uint32 expected, uint32 actual);
error AmountTooLarge(uint128 requested, uint128 max);
error TVLCapExceeded(uint128 wouldBe, uint128 cap);
error RateLimitExceeded(uint128 wouldBe, uint128 cap);
error InsufficientBalance(uint128 available, uint128 required);
error AlreadyProcessed(bytes32 nonce);
error InvalidProof();
```

---

## 2. `WrappedETX` (Ethereum + BNB Chain)

Standard ERC20 with permit (EIP-2612) and restricted mint/burn. **The simplest contract in the bridge.** Holds no business logic; mint/burn authority is delegated to `BridgeMinter`.

### 2.1 Storage

```solidity
// inherits OpenZeppelin ERC20Permit
// no additional storage slots
address public immutable bridgeMinter;
```

### 2.2 Constructor

```solidity
constructor(address _bridgeMinter)
    ERC20("Wrapped ETX", "wETX")
    ERC20Permit("Wrapped ETX")
{
    if (_bridgeMinter == address(0)) revert ZeroAddress();
    bridgeMinter = _bridgeMinter;
}
```

### 2.3 External functions

```solidity
function mint(address to, uint256 amount) external;
//   onlyBridgeMinter — reverts UnauthorizedCaller otherwise
//   no other access control; BridgeMinter enforces all policy

function burn(address from, uint256 amount) external;
//   onlyBridgeMinter — reverts UnauthorizedCaller otherwise
//   used during Eth → Etica withdrawal flow
```

### 2.4 Events

```solidity
// inherits ERC20 Transfer events; no custom events
```

### 2.5 Notes

- Decimals: 18, hardcoded via OZ default.
- No max supply; supply tracks `BridgeVault` locked balance via Hyperlane round-trip accounting.
- No upgrade path; if the protocol needs a new minter, deploy a new wETX and migrate.
- Identical address on Ethereum and BNB via deterministic create2 + same salt.

---

## 3. `BridgeVault` (Etica chain only)

The asset-locking custodian. Holds all ETX bridged out of Etica. **The most security-critical contract in the system** because it controls actual user funds.

### 3.1 Storage

```solidity
// IMMUTABLES (no storage slot — packed into bytecode)
IERC20 public immutable etx;                       // 0xa5A1Bc6307b0b87989B8456D4b35F88a68650044
address public immutable hyperlaneMailbox;         // Hyperlane mailbox on Etica
IBridgeInsuranceFund public immutable insuranceFund;
IFeeRouter public immutable feeRouter;
uint32 public immutable selfDomain;                // 61803

// SLOT 0
address public owner;                              // treasury wallet, settable via timelock
uint96  public depositCounter;                     // packs with owner

// SLOT 1
uint128 public tvlCapEtx;                          // current cap on locked ETX (1M at launch)
uint64  public lastCapRaiseAt;                     // timestamp of last auto-raise
uint32  public capRaiseIntervalSeconds;            // 30 days = 2_592_000
uint32  public capRaiseSteps;                      // 0 at launch; +1 per auto-raise

// SLOT 2
uint128 public capRaiseAmountEtx;                  // 1M ETX added per raise
uint128 public capRaiseCeilingEtx;                 // 10M ETX hard ceiling

// SLOT 3
uint128 public dailyWithdrawCapBps;                // 500 = 5%
uint128 public perClaimCapBps;                     // 100 = 1%

// SLOT 4
uint128 public withdrawnTodayEtx;                  // resets each UTC day
uint64  public currentDayUtc;                      // floor(block.timestamp / 86400)
uint64  public _slot4Reserved;

// SLOT 5
uint128 public totalLockedEtx;                     // == sum of net deposits − sum of net withdrawals
uint128 public totalFeesAccruedEtx;                // bridge fee total since launch (informational)

// SLOT 6
uint16  public bridgeFeeBps;                       // 10 = 0.1%
bool    public paused;
bool    public _slot6Reserved;

// SLOT 7+
mapping(bytes32 => bool) public processedWithdrawals;
mapping(bytes32 => bool) public knownDeposits;     // deposits this contract has issued

// SLOT 9 (storage upgrade reserve)
uint256[49] private __gap;
```

### 3.2 Constructor

```solidity
constructor(
    address _owner,
    IERC20  _etx,
    address _hyperlaneMailbox,
    IBridgeInsuranceFund _insuranceFund,
    IFeeRouter _feeRouter,
    uint32  _selfDomain
);
```

Sets immutables, sets `owner`, initializes `tvlCapEtx = 1_000_000e18`, `bridgeFeeBps = 10`, `dailyWithdrawCapBps = 500`, `perClaimCapBps = 100`, `capRaiseIntervalSeconds = 2_592_000`, `capRaiseAmountEtx = 1_000_000e18`, `capRaiseCeilingEtx = 10_000_000e18`.

### 3.3 External functions

#### Deposit (user-callable)

```solidity
function deposit(
    uint128 amount,
    uint32  destDomain,
    address recipient
) external whenNotPaused returns (bytes32 nonce);
//   Pulls `amount` ETX via transferFrom(msg.sender, this).
//   Computes fee = amount * bridgeFeeBps / 10_000; routes via feeRouter.
//   net = amount - fee; locked in vault.
//   Reverts:
//     - ZeroAmount if amount == 0
//     - TVLCapExceeded if (totalLockedEtx + net > tvlCapEtx)
//     - ChainIdMismatch if destDomain not in {1, 56} pre-3c, {1, 56, tron} post-3c
//     - ZeroAddress if recipient == address(0)
//   Increments depositCounter, computes nonce = keccak256(selfDomain, address(this), counter).
//   Calls hyperlaneMailbox.dispatch(destDomain, recipient, encodedMessage).
//   Emits Deposit event.
//   Returns nonce.

function depositWithPermit(
    uint128 amount,
    uint32  destDomain,
    address recipient,
    uint256 deadline,
    uint8   v,
    bytes32 r,
    bytes32 s
) external whenNotPaused returns (bytes32 nonce);
//   Same as deposit() but consumes ERC20Permit signature on ETX.
//   Reverts on any underlying permit failure.
```

#### Withdraw completion (called by Hyperlane handle path on inbound burn message)

```solidity
function handleBurnMessage(
    uint32 srcDomain,
    bytes32 sender,
    bytes calldata message
) external;
//   onlyHyperlaneMailbox — reverts UnauthorizedCaller otherwise
//   Decodes BridgeMessage; verifies srcDomain matches sender contract
//   Submits claim into pending queue (NOT immediate transfer)
//   Emits WithdrawClaimSubmitted

function executeWithdraw(bytes32 nonce) external;
//   Anyone can call after expiresAt
//   Reverts if claim state != PENDING or block.timestamp < expiresAt
//   Reverts if amount > perClaimCap or daily rate limit exceeded
//   Transfers ETX to recipient; processedWithdrawals[nonce] = true
//   Returns submitter bond
//   Emits WithdrawExecuted
//   Calls insuranceFund.checkSolvency() at end to trigger auto-payout if needed

function vetoWithdraw(bytes32 nonce, VetoReason reason) external;
//   onlyVetoAuthority (= OptimisticVetoModule) — reverts otherwise
//   Reverts if claim state != PENDING or block.timestamp >= expiresAt
//   Slashes bond per 25/50/25 split
//   Sets claim state to VETOED; emits WithdrawVetoed
```

#### Solvency

```solidity
function checkSolvency() external;
//   Permissionless; offers small EGAZ tip to caller (capped at 100 ETX-equivalent / day)
//   Computes wETXOutstanding (via Hyperlane state oracle or off-chain submitted attestation)
//   If totalLockedEtx < wETXOutstanding:
//     delta = wETXOutstanding - totalLockedEtx
//     insuranceFund.draw(delta)
//   Emits SolvencyCheck event

function reportWETXOutstanding(
    uint128 wETXOutstanding,
    bytes calldata hyperlaneAttestation
) external;
//   onlyHyperlaneMailbox; routes through Hyperlane handle path
//   Updates internal mirror of cross-chain wETX supply
```

#### Auto-cap-raise

```solidity
function tryAutoRaiseCap() external;
//   Permissionless
//   If (block.timestamp - lastCapRaiseAt) >= capRaiseIntervalSeconds AND no veto
//   activity in past interval AND tvlCapEtx < capRaiseCeilingEtx:
//     tvlCapEtx += capRaiseAmountEtx; lastCapRaiseAt = block.timestamp; capRaiseSteps += 1
//   Emits CapRaised
//   No tip; gas cost is trivial
```

#### Owner-controlled (24h timelock except emergency)

```solidity
function setBridgeFeeBps(uint16 newBps) external onlyOwner timelocked;
//   Reverts if newBps > 100 (1% hard cap)

function setRateLimits(uint128 newDailyBps, uint128 newPerClaimBps) external onlyOwner timelocked;
//   Reverts if newDailyBps > 1000 (10% cap) or newPerClaimBps > 500 (5% cap)

function setVetoAuthority(address newAuthority) external onlyOwner timelocked;
//   Updates the OptimisticVetoModule address (for migrations/upgrades of veto logic)

function emergencyPause() external onlyEmergencyPauser;
//   Sets paused = true. No timelock.
//   Callable by owner OR any address that posts a 1K-ETX pause bond (slashed if pause is reverted within 48h)

function unpause() external onlyOwner timelocked;
//   48h timelock as documented in design doc §6
```

### 3.4 Events

```solidity
event Deposit(
    bytes32 indexed nonce,
    address indexed sender,
    address indexed recipient,
    uint32 destDomain,
    uint128 amountNet,
    uint128 fee
);

event WithdrawClaimSubmitted(
    bytes32 indexed nonce,
    address indexed recipient,
    uint128 amount,
    uint64 expiresAt
);

event WithdrawExecuted(
    bytes32 indexed nonce,
    address indexed recipient,
    uint128 amount
);

event WithdrawVetoed(
    bytes32 indexed nonce,
    address indexed vetoer,
    VetoReason reason
);

event CapRaised(uint128 newCap, uint32 step);
event SolvencyCheck(uint128 locked, uint128 wETXOutstanding, bool insuranceDrawn, uint128 drawnAmount);
event Paused(address pauser);
event Unpaused();
event OwnerChanged(address oldOwner, address newOwner);
```

### 3.5 Custom errors

```solidity
error BridgeVault_TVLCapExceeded(uint128 wouldBe, uint128 cap);
error BridgeVault_RateLimitExceeded(uint128 wouldBe, uint128 cap);
error BridgeVault_PerClaimCapExceeded(uint128 amount, uint128 cap);
error BridgeVault_NotMatured(uint64 expiresAt);
error BridgeVault_AlreadyProcessed(bytes32 nonce);
error BridgeVault_InvalidDestDomain(uint32 dest);
```

---

## 4. `BridgeMinter` (Ethereum + BNB Chain)

Mint authority for `WrappedETX`. Manages the optimistic-veto claim queue, bond accounting, and Hyperlane integration. Symmetric to `BridgeVault` for the burn-side flow.

### 4.1 Storage

```solidity
// IMMUTABLES
IWrappedETX public immutable wetx;
address public immutable hyperlaneMailbox;
uint32 public immutable selfDomain;

// SLOT 0
address public owner;
uint96  public _slot0Reserved;

// SLOT 1
address public optimisticVetoModule;     // contract that can veto
address public fraudProverModule;        // contract that can submit Merkle-proof veto

// SLOT 2
address public watcherBotKey;            // veto-only key the operator's bot uses
uint64  public lastHeartbeatAt;
uint32  public heartbeatTimeoutSeconds;  // 14400 (4h)
bool    public paused;

// SLOT 3
uint64  public challengeWindowSeconds;   // 172800 (48h)
uint16  public bondBps;                  // 2500 (25%)
uint16  public proverBondBps;            // 500 (5%)
uint128 public _slot3Reserved;

// SLOT 4
uint128 public dailyWithdrawCapBps;      // 500 = 5% of TVL on this chain
uint128 public perClaimCapBps;           // 100 = 1%

// SLOT 5
uint128 public mintedTodayEtx;           // resets each UTC day
uint64  public currentDayUtc;
uint64  public _slot5Reserved;

// SLOT 6+
mapping(bytes32 => Claim) public claims;
mapping(bytes32 => bool) public processedNonces;

// SLOT 8
address public successorKey;            // address that activates if heartbeat dies for 90d
uint64  public successorActiveAt;       // timestamp after which successor can act
uint64  public successorTimelockSeconds; // 7_776_000 (90d)

// SLOT 9 (gap)
uint256[40] private __gap;
```

### 4.2 Constructor

```solidity
constructor(
    address _owner,
    address _watcherBotKey,
    address _successorKey,
    address _hyperlaneMailbox,
    uint32  _selfDomain
);
```

Deploys `WrappedETX` via internal create + sets `wetx = address(deployedWETX)`. Sets initial parameter defaults (challenge window 48h, bond 25%, prover bond 5%, heartbeat timeout 4h, successor timelock 90d).

### 4.3 External functions

#### Claim submission

```solidity
function submitClaim(
    bytes32 nonce,
    BridgeMessage calldata msg_,
    bytes calldata hyperlaneProof
) external payable whenNotPaused returns (bytes32);
//   Reverts:
//     - AlreadyProcessed if processedNonces[nonce]
//     - ZeroAddress if msg_.recipient == 0
//     - ChainIdMismatch if msg_.destDomain != selfDomain
//     - InvalidProof if Hyperlane MultisigISM rejects
//     - InsufficientBond if msg.value (or ERC20 bond) < amount * bondBps / 10_000
//     - PerClaimCapExceeded if amount > perClaimCap of vault TVL
//     - RateLimitExceeded if mintedTodayEtx + amount > dailyCap
//   Sets claims[nonce] = Claim({msg_, msg.sender, bond, now, now + window, PENDING, NONE})
//   Emits ClaimSubmitted
//   Returns nonce
```

#### Claim execution

```solidity
function executeClaim(bytes32 nonce) external;
//   Permissionless after expiresAt
//   Reverts NotMatured if block.timestamp < expiresAt
//   Reverts WrongState if state != PENDING
//   Sets state = EXECUTED, processedNonces[nonce] = true
//   Calls wetx.mint(msg_.recipient, msg_.amount)
//   Returns full bond to submitter (msg.value or ERC20 transfer)
//   Emits ClaimExecuted
//   Updates mintedTodayEtx
```

#### Veto paths

```solidity
function vetoClaimManual(bytes32 nonce, VetoReason reason) external;
//   onlyVetoAuthority (= optimisticVetoModule)
//   Reverts WrongState if state != PENDING
//   Reverts NotMatured if block.timestamp >= expiresAt
//   Slashes bond per 25/50/25 split:
//     - 25% to msg.sender (the vetoer / prover-of-record)
//     - 50% to BridgeMinter.treasuryRecipient (configured address)
//     - 25% to BridgeInsuranceFund (via cross-chain Hyperlane message)
//   Sets state = VETOED; reason = reason
//   Emits ClaimVetoed
```

```solidity
function vetoClaimWithProof(
    bytes32 nonce,
    bytes calldata merkleProof,
    bytes32 etcaBlockRoot
) external;
//   onlyFraudProverModule (= fraudProverModule)
//   Verifies merkleProof against etcaBlockRoot proves the deposit doesn't match the claim
//   On success: slashes bond per 25/50/25 split with prover as the "25% to prover"
//   On failure: reverts InvalidProof; prover bond NOT slashed
//   (Lying-by-prover is cryptographically impossible; only "insufficient evidence" is possible)
```

#### Burn path (Eth/BNB → Etica)

```solidity
function burn(
    uint128 amount,
    uint32  destDomain,
    address recipient
) external whenNotPaused returns (bytes32 nonce);
//   Pulls amount wETX from msg.sender; calls wetx.burn(msg.sender, amount)
//   Computes fee = amount * bridgeFeeBps / 10_000
//   net = amount - fee; fee accumulated for cross-chain transfer
//   Constructs BridgeMessage; computes nonce
//   Calls hyperlaneMailbox.dispatch(destDomain=Etica, vaultAddress, message)
//   Emits BurnDispatched
//   Returns nonce
```

#### Heartbeat

```solidity
function heartbeat() external;
//   onlyWatcherBotKey
//   Sets lastHeartbeatAt = block.timestamp
//   Emits Heartbeat

function rotateBotKey(address newKey) external onlyOwner timelocked;
//   24h timelock
//   Updates watcherBotKey

function checkHeartbeat() external view returns (bool isHealthy);
//   Returns block.timestamp - lastHeartbeatAt < heartbeatTimeoutSeconds

function autoPauseIfStale() external;
//   Permissionless
//   If heartbeat is stale: paused = true; emits AutoPaused(reason="heartbeat-stale")
//   Cannot reverse via this function; requires explicit unpause()
```

#### Successor key activation

```solidity
function activateSuccessor() external;
//   Callable only by successorKey
//   Reverts if block.timestamp < successorActiveAt
//   successorActiveAt is automatically set whenever heartbeat goes stale; 
//   it equals lastHeartbeatAt + successorTimelockSeconds
//   Transfers owner role to successorKey; emits SuccessorActivated
//   No further timelock from this point — successor has full owner authority
//   This is THE recovery path for permanent operator unavailability
```

### 4.4 Events

```solidity
event ClaimSubmitted(bytes32 indexed nonce, address indexed submitter, address indexed recipient, uint128 amount, uint128 bond, uint64 expiresAt);
event ClaimExecuted(bytes32 indexed nonce, address indexed recipient, uint128 amount);
event ClaimVetoed(bytes32 indexed nonce, address indexed vetoer, VetoReason reason, uint128 toProver, uint128 toTreasury, uint128 toInsurance);
event BurnDispatched(bytes32 indexed nonce, address indexed sender, address indexed recipient, uint32 destDomain, uint128 amountNet, uint128 fee);
event Heartbeat(uint64 timestamp);
event AutoPaused(string reason);
event SuccessorActivated(address newOwner);
```

### 4.5 Custom errors

```solidity
error BridgeMinter_AlreadyProcessed(bytes32 nonce);
error BridgeMinter_WrongState(ClaimState current);
error BridgeMinter_NotMatured(uint64 expiresAt);
error BridgeMinter_InsufficientBond(uint128 provided, uint128 required);
error BridgeMinter_PerClaimCapExceeded(uint128 amount, uint128 cap);
error BridgeMinter_RateLimitExceeded(uint128 wouldBe, uint128 cap);
error BridgeMinter_HeartbeatStale(uint64 lastBeat, uint64 timeout);
error BridgeMinter_SuccessorNotReady(uint64 readyAt);
```

---

## 5. `OptimisticVetoModule` (Ethereum + BNB Chain)

Wraps the operator's veto-key authority over `BridgeMinter`. Separating this lets us swap the veto policy (e.g., add multi-sig wrapping) without touching `BridgeMinter`.

### 5.1 Storage

```solidity
// IMMUTABLES
IBridgeMinter public immutable minter;

// SLOT 0
address public owner;          // == BridgeMinter.owner; can rotate keys
address public vetoKey;        // hot key the bot uses

// SLOT 1
mapping(address => bool) public authorizedVetoers;  // for future multi-vetoer

// SLOT 2 (gap)
uint256[10] private __gap;
```

### 5.2 External functions

```solidity
function veto(bytes32 nonce, VetoReason reason) external;
//   msg.sender must be in authorizedVetoers OR == vetoKey
//   Calls minter.vetoClaimManual(nonce, reason)
//   Emits VetoForwarded

function rotateVetoKey(address newKey) external onlyOwner;
//   24h timelock
//   Updates vetoKey

function authorizeVetoer(address vetoer) external onlyOwner;
//   24h timelock; adds to authorizedVetoers

function deauthorizeVetoer(address vetoer) external onlyOwner;
//   No timelock (security-positive operation)
```

### 5.3 Events / errors

```solidity
event VetoForwarded(bytes32 indexed nonce, address indexed vetoer, VetoReason reason);
event VetoKeyRotated(address oldKey, address newKey);

error OptimisticVeto_UnauthorizedVetoer(address sender);
```

---

## 6. `FraudProverModule` (Ethereum + BNB Chain)

Independent path for community fraud proofs. Verifies a Merkle proof that a claim's referenced Etica deposit doesn't match the claim (or doesn't exist). Slashes bond on success; reverts on insufficient evidence.

### 6.1 Storage

```solidity
// IMMUTABLES
IBridgeMinter public immutable minter;
address public immutable hyperlaneMailbox;
uint32 public immutable etcaDomain;        // 61803

// SLOT 0
address public owner;
uint96  public _slot0Reserved;

// SLOT 1
mapping(uint64 => bytes32) public etcaBlockRoots; // blockNumber => stateRoot, populated by Hyperlane oracle

// SLOT 2 (gap)
uint256[10] private __gap;
```

### 6.2 External functions

```solidity
function proveAndVeto(
    bytes32 claimNonce,
    bytes32 claimedDepositNonce,
    bytes calldata merkleProof,
    uint64  etcaBlockNumber,
    BridgeMessage calldata depositInBlock
) external;
//   Verifies:
//     1. etcaBlockRoots[etcaBlockNumber] != 0 (root has been attested)
//     2. merkleProof verifies depositInBlock against etcaBlockRoots[etcaBlockNumber]
//     3. depositInBlock.nonce != claimedDepositNonce  
//        OR depositInBlock.amount != claim.amount  
//        OR depositInBlock.recipient != claim.recipient
//     (i.e., the actual on-Etica deposit doesn't match what the claim says)
//   On success: calls minter.vetoClaimWithProof(claimNonce, ...) → slashes bond
//   On failure: reverts InvalidProof; no penalty to caller (they just submitted bad evidence)

function recordEtcaBlockRoot(uint64 blockNumber, bytes32 root, bytes calldata hyperlaneProof) external;
//   onlyHyperlaneMailbox — populated through standard handle() path
//   Allows Hyperlane validators to push attested Etica block roots for proof verification
```

### 6.3 Events / errors

```solidity
event FraudProven(bytes32 indexed claimNonce, address indexed prover, uint64 etcaBlockNumber);
event EtcaBlockRootRecorded(uint64 blockNumber, bytes32 root);

error FraudProver_RootNotAttested(uint64 blockNumber);
error FraudProver_ProofInvalid();
error FraudProver_DepositMatches();  // proof was valid but the deposit DOES match the claim
```

---

## 7. `BridgeInsuranceFund` (Etica chain only)

Holds 10M ETX as auto-payout backstop. Timelocked for any non-emergency withdrawal; auto-callable by `BridgeVault.checkSolvency` for solvency restoration.

### 7.1 Storage

```solidity
// IMMUTABLES
IERC20 public immutable etx;
address public immutable bridgeVault;       // only contract that can call draw()

// SLOT 0
address public owner;
uint96  public _slot0Reserved;

// SLOT 1
uint128 public balance;                     // mirror; cheaper than etx.balanceOf each call
uint64  public withdrawTimelockSeconds;     // 30 days for emergency withdrawals

// SLOT 2
struct PendingWithdrawal {
    uint128 amount;
    address recipient;
    uint64  readyAt;
}
mapping(uint256 => PendingWithdrawal) public pendingWithdrawals;
uint128 public nextWithdrawalId;

// SLOT 4 (gap)
uint256[10] private __gap;
```

### 7.2 External functions

```solidity
function draw(uint128 amount) external returns (uint128 actualDrawn);
//   onlyBridgeVault — reverts UnauthorizedCaller otherwise
//   actualDrawn = min(amount, balance)
//   Transfers actualDrawn ETX to bridgeVault
//   balance -= actualDrawn
//   Emits InsuranceDrawn(amount, actualDrawn, balance)

function deposit(uint128 amount) external;
//   Anyone can deposit ETX into the insurance fund
//   Pulls amount via transferFrom; balance += amount
//   Emits InsuranceDeposited(sender, amount)

function requestWithdrawal(uint128 amount, address recipient) external onlyOwner returns (uint256 id);
//   Schedules withdrawal at block.timestamp + withdrawTimelockSeconds
//   Emits WithdrawalRequested

function executeWithdrawal(uint256 id) external onlyOwner;
//   Reverts TimelockNotElapsed if block.timestamp < pendingWithdrawals[id].readyAt
//   Transfers amount to recipient
//   Emits WithdrawalExecuted

function cancelWithdrawal(uint256 id) external onlyOwner;
//   Anyone CAN call this with bond? — TBD; for v1, owner-only
//   Cancels pending withdrawal; emits WithdrawalCancelled
```

### 7.3 Events / errors

```solidity
event InsuranceDrawn(uint128 requested, uint128 actualDrawn, uint128 newBalance);
event InsuranceDeposited(address indexed depositor, uint128 amount);
event WithdrawalRequested(uint256 id, uint128 amount, address recipient, uint64 readyAt);
event WithdrawalExecuted(uint256 id);
event WithdrawalCancelled(uint256 id);

error InsuranceFund_TimelockNotElapsed(uint64 readyAt);
```

---

## 8. `FeeRouter` (Etica chain only)

Routes the 0.1% bridge fee. Per the locked decision (§10.7 of design doc): **20% to insurance fund / 80% to harvester** (existing harvester handles the further 10/10/40/40 split).

### 8.1 Storage

```solidity
// IMMUTABLES
IERC20 public immutable etx;
ITreasuryHarvester public immutable harvester;  // 0x5d8B...76f5
IBridgeInsuranceFund public immutable insuranceFund;
address public immutable bridgeVault;

// SLOT 0
address public owner;
uint16  public toInsuranceBps;       // 2000 = 20%
uint16  public toHarvesterBps;       // 8000 = 80%
uint64  public _slot0Reserved;

// SLOT 1+ (gap)
uint256[10] private __gap;
```

### 8.2 External functions

```solidity
function routeFee(uint128 amount) external;
//   onlyBridgeVault — reverts UnauthorizedCaller otherwise
//   Splits amount per current bps: toInsurance, toHarvester
//   Pulls from msg.sender (BridgeVault); transfers to each destination
//   Emits FeeRouted

function setSplit(uint16 newInsuranceBps, uint16 newHarvesterBps) external onlyOwner timelocked;
//   24h timelock
//   Reverts if newInsuranceBps + newHarvesterBps != 10000
```

### 8.3 Events / errors

```solidity
event FeeRouted(uint128 totalAmount, uint128 toInsurance, uint128 toHarvester);
event SplitChanged(uint16 newInsuranceBps, uint16 newHarvesterBps);
```

---

## 9. Hyperlane integration touchpoints

This section documents how the bridge contracts use Hyperlane V3 stdlib.

### 9.1 Deployed Hyperlane components per chain

| Chain | Component | Address (TBD at deploy) |
|---|---|---|
| Etica | `Mailbox` | TBD |
| Etica | `MultisigIsm` | TBD |
| Etica | `InterchainGasPaymaster` (IGP) | TBD |
| Etica | `Validator` (operator-run) | TBD |
| Ethereum | `Mailbox` | TBD |
| Ethereum | `MultisigIsm` | TBD |
| Ethereum | `InterchainGasPaymaster` (IGP) | TBD |
| BNB | `Mailbox` | TBD |
| BNB | `MultisigIsm` | TBD |
| BNB | `InterchainGasPaymaster` (IGP) | TBD |

### 9.2 Message format for cross-chain dispatches

```solidity
// Encoded as abi.encode(BridgeMessage)
struct BridgeMessage {
    bytes32 nonce;
    uint32  srcDomain;
    uint32  destDomain;
    address sender;
    address recipient;
    uint128 amount;
    uint64  srcBlockNumber;
    uint64  timestamp;
}

// Total: ~32 + 32 + 4 + 4 + 20 + 20 + 16 + 8 + 8 = 144 bytes per message
// Hyperlane gas cost: ~200K gas per dispatch + ~100K gas per handle
```

### 9.3 Dispatch sequence (Etica → Eth deposit)

1. User calls `BridgeVault.deposit(...)` on Etica
2. BridgeVault encodes `BridgeMessage`, computes nonce
3. BridgeVault calls `IGP.payForGas(messageId, destDomain, gasLimit, refundAddress)` with user-prepaid ETH/BNB equivalent
4. BridgeVault calls `mailbox.dispatch(destDomain, recipientAddress=BridgeMinter, body)`
5. Hyperlane validators (operator's daemons) observe and sign the Etica block root containing this dispatch
6. Hyperlane relayer (operator's relayer instance) submits the message + ISM proof to Eth Mailbox
7. Eth Mailbox calls `BridgeMinter.handle(srcDomain=61803, sender, body)` — wait, this is wrong
   - Actually BridgeMinter implements `IMessageRecipient.handle()` directly
   - Inside handle(): decodes message, calls submitClaim() internally as PENDING (NOT immediate mint)
   - **Crucially**: the inbound message creates a PENDING claim with bond pre-paid by the relayer/user; or 
     alternative: inbound message just records the deposit, anyone (including the user) can submitClaim()
     against it later by referencing the recorded deposit
   - **Decision needed**: which model? See Open Question Q-CS1 below

### 9.4 ISM configuration

Default ISM stack (in order of evaluation):

```
1. MultisigISM    — verifies validator signatures over Etica block root (5-of-7 threshold, expanded over time)
2. RoutingISM     — selects between MultisigISM (steady state) and EmergencyOverrideISM (incident response)
3. AggregationISM — combines MultisigISM with our custom RateLimitISM (defense in depth)
```

Custom ISMs in scope of this spec:

- **`RateLimitISM`** — wraps any inbound message; rejects if it would push daily withdrawals > 5% of TVL on this chain. Owner-tunable BPS.
- **`TVLCapISM`** — rejects deposits that would push vault TVL > current cap.
- **`HeartbeatISM`** — rejects all inbound messages if BridgeMinter's heartbeat is stale.

These wrap or replace the default Hyperlane ISMs depending on configuration. They are deployed alongside the BridgeMinter per chain.

---

## 10. Deployment order

```
Step 1 (Etica):
  1.1 Deploy BridgeInsuranceFund (pre-fund with 10M ETX from treasury)
  1.2 Deploy FeeRouter (constructor receives insuranceFund address)
  1.3 Deploy BridgeVault (constructor receives feeRouter, insuranceFund, mailbox addresses)
  1.4 BridgeInsuranceFund.setBridgeVault(bridgeVault) (one-time owner call, timelocked)
  1.5 Hyperlane: deploy Etica Mailbox, configure validators

Step 2 (Eth + BNB simultaneously):
  2.1 Deploy WrappedETX with placeholder bridgeMinter; record address
  2.2 Deploy OptimisticVetoModule
  2.3 Deploy FraudProverModule
  2.4 Deploy BridgeMinter (constructor sets wetx, modules, hyperlaneMailbox, watcherBotKey, successorKey)
  2.5 WrappedETX.setBridgeMinter(bridgeMinter) — actually no, immutable; redeploy with correct address
        (alternative: deploy in correct order via create2 + salt, predicting addresses)
  2.6 Hyperlane: deploy Mailbox per chain, configure validators

Step 3 (post-deploy verification):
  3.1 BridgeVault.tvlCapEtx == 1_000_000e18
  3.2 BridgeMinter.challengeWindowSeconds == 172_800
  3.3 BridgeMinter.bondBps == 2_500
  3.4 BridgeInsuranceFund.balance() == 10_000_000e18
  3.5 Hyperlane mailbox correctly reaches each chain (test message)

Step 4 (live launch with cap-ramp):
  4.1 Day 0: TVL cap = 1M ETX; bridge open for deposits
  4.2 Day 30 (if no veto activity): cap auto-raises to 2M
  4.3 Day 60: cap auto-raises to 3M
  4.4 ... continues +1M/30d until 10M ceiling reached at day 300
```

---

## 11. Storage upgrade considerations

All contracts include `__gap` arrays to allow future field additions without storage layout breakage. **However**: bridge contracts are **non-upgradeable** by design — there is no proxy. Future upgrades require:

1. Deploy new contract version
2. Pause old contract
3. Migrate state via owner-callable functions (e.g., `freezeAndExport`, then `importFrozenState`)
4. Update Hyperlane mailbox routes
5. Update UI to reference new contract

This is the right tradeoff for a security-critical bridge — proxy admin keys are themselves an attack surface, and "we can swap the contract" is a feature attackers can exploit.

---

## 12. Open contract-spec questions (CS-prefixed)

These are decisions specific to contract design that warrant operator confirmation:

- **Q-CS1**: Inbound deposit message handling — direct PENDING-claim creation, or "record deposit, claim against it later"? Affects gas costs and UX. Recommendation: **record-then-claim**, because it lets the user (or a relayer) decide WHEN to submit the claim and lock their bond, and avoids requiring the relayer to bond on the user's behalf.

- **Q-CS2**: Bond denomination — destination-chain native gas (ETH/BNB) vs wETX vs wrapped stablecoin? Locked default per design doc §10.4 was native gas. Confirming: native gas at launch.

- **Q-CS3**: Cross-chain insurance fund top-up — when bond is slashed and 25% goes to BridgeInsuranceFund (which lives on Etica), does the destination-chain BridgeMinter dispatch a Hyperlane message to top it up, or are slashed bonds held in a destination-chain accumulator that gets bridged periodically? Recommendation: **accumulator + manual bridge weekly** (less Hyperlane gas, simpler accounting).

- **Q-CS4**: WrappedETX address symmetry across Eth + BNB — use deterministic create2 for identical address on both chains? UX win for users (memorize one address); recommend **yes, use deterministic deploys**.

- **Q-CS5**: `successorKey` — can it be a multi-sig contract? Recommend **yes, allow EOA or contract** for flexibility (operator might want to set successor as a 2-of-3 multi-sig of trusted parties).

- **Q-CS6**: Claim cancellation by submitter — should there be an `cancelClaim()` function for the submitter to abort a PENDING claim (e.g., realized they made a mistake)? Recommendation: **no** — once submitted with bond, it must run to expiration or be vetoed. Cancelling would create griefing vectors (submit, cancel, resubmit at advantageous time). Submitter loses 0% if not vetoed; no need to cancel.

- **Q-CS7**: Per-submitter rate limit — to prevent spam claim attacks (#16 in threat model), max N pending claims per submitter address? Recommendation: **max 10 pending claims per address**, configurable.

- **Q-CS8**: Fee accounting on burn (Eth/BNB → Etica direction) — fee on burn is held on destination chain in wETX or transferred to Etica via Hyperlane to merge with Etica-side fees? Recommendation: **bridge weekly via owner-triggered batch transfer** (saves gas vs per-burn dispatch).

---

## 13. Sign-off checklist for contract specification

Before implementation begins:

- [ ] Operator reviews this spec end-to-end
- [ ] Open questions Q-CS1 through Q-CS8 resolved
- [ ] Storage layouts cross-referenced for tight packing wins
- [ ] Function signatures cross-referenced for gas optimization opportunities
- [ ] Event indexed-field choices reviewed for off-chain indexer compatibility
- [ ] Custom error list reviewed for completeness against threat model attack scenarios
- [ ] Hyperlane integration approach approved (RouterISM + AggregationISM with custom RateLimitISM/TVLCapISM/HeartbeatISM)
- [ ] Deployment order in §10 confirmed feasible
- [ ] Upgrade path in §11 confirmed (non-upgradeable by design)

After sign-off → contract implementation begins. Anticipated rate of work: ~1 contract per implementation PR, fully tested and self-audited before each merge.

---

## 14. References

- [`BRIDGE_DESIGN.md`](./BRIDGE_DESIGN.md) — predecessor architecture-level spec
- Hyperlane V3 contracts: <https://github.com/hyperlane-xyz/hyperlane-monorepo/tree/main/solidity>
- Hyperlane permissionless deploy: <https://docs.hyperlane.xyz/docs/deploy-hyperlane>
- TreasuryHarvester (existing): <https://eticascan.org/address/0x5d8B...76f5> (TBD link)
- BridgeAuditScope (legacy): [`./BRIDGE_AUDIT_SCOPE.md`](./BRIDGE_AUDIT_SCOPE.md) — predates this design; will be replaced by self-audit checklist in §7 of `BRIDGE_DESIGN.md`
