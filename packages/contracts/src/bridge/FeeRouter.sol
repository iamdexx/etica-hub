// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {BridgeInsuranceFund} from "./BridgeInsuranceFund.sol";

/// @title FeeRouter
/// @notice Routes the 0.1% bridge fee collected by `BridgeVault` on Etica.
///
///         Default split (locked in design doc §10.7):
///           - 20% → BridgeInsuranceFund (auto-replenishment of the backstop)
///           - 80% → TreasuryHarvester (existing harvester applies its own
///                   10/10/40/40 split: stETX yield, POL, treasury, burn)
///
///         Money flow:
///           1. `BridgeVault` transfers `amount` ETX to this contract.
///           2. `BridgeVault` calls `routeFee(amount)`.
///           3. `routeFee` splits the held balance per current bps and
///              forwards each share. The insurance share is sent via
///              `BridgeInsuranceFund.deposit(...)` so the fund's own
///              `InsuranceDeposited` event fires for clean accounting.
///
///         Split is owner-adjustable behind a 24h timelock (request/execute/
///         cancel pattern, mirroring `BridgeInsuranceFund`). The bps
///         pair must always sum to 10000.
///
///         The `bridgeVault` address is a one-time setter (deploy order:
///         InsuranceFund → FeeRouter → Vault). Once set, locked forever.
contract FeeRouter is Ownable2Step {
    using SafeERC20 for IERC20;

    uint16 public constant TOTAL_BPS = 10_000;

    /// @notice ETX token routed through this contract.
    IERC20 public immutable etx;

    /// @notice Insurance backstop. Receives the insurance slice via `deposit`.
    BridgeInsuranceFund public immutable insuranceFund;

    /// @notice TreasuryHarvester (or successor). Receives the harvester slice
    ///         via plain ERC20 transfer; harvester picks up balance on next tick.
    address public immutable harvester;

    /// @notice Time that must elapse between a `requestSplitChange` and its
    ///         `executeSplitChange`. Set at construction; immutable.
    uint64 public immutable splitTimelock;

    /// @notice Linked bridge vault. Only this address may call `routeFee`.
    ///         Set once after deploy; locked thereafter.
    address public bridgeVault;

    /// @notice Current insurance fund split, in basis points (out of 10_000).
    uint16 public toInsuranceBps;

    /// @notice Current harvester split, in basis points (out of 10_000).
    uint16 public toHarvesterBps;

    struct PendingSplit {
        uint16 toInsuranceBps;
        uint16 toHarvesterBps;
        uint64 executableAt;
        bool executed;
        bool cancelled;
    }

    mapping(uint256 id => PendingSplit) public pendingSplits;
    uint256 public nextSplitId;

    event BridgeVaultSet(address indexed bridgeVault);
    event FeeRouted(uint128 totalAmount, uint128 toInsurance, uint128 toHarvester);
    event SplitChangeRequested(
        uint256 indexed id, uint16 newInsuranceBps, uint16 newHarvesterBps, uint64 executableAt
    );
    event SplitChanged(uint16 newInsuranceBps, uint16 newHarvesterBps);
    event SplitChangeCancelled(uint256 indexed id);

    error FeeRouter_ZeroAddress();
    error FeeRouter_OnlyBridgeVault(address caller);
    error FeeRouter_VaultAlreadySet();
    error FeeRouter_InsufficientBalance(uint256 requested, uint256 held);
    error FeeRouter_InvalidSplit(uint16 toInsuranceBps, uint16 toHarvesterBps);
    error FeeRouter_InvalidSplitId(uint256 id);
    error FeeRouter_TimelockNotElapsed(uint64 executableAt, uint64 nowTimestamp);
    error FeeRouter_AlreadyExecuted(uint256 id);
    error FeeRouter_AlreadyCancelled(uint256 id);

    modifier onlyBridgeVault() {
        if (msg.sender != bridgeVault) revert FeeRouter_OnlyBridgeVault(msg.sender);
        _;
    }

    constructor(
        IERC20 _etx,
        address _owner,
        BridgeInsuranceFund _insuranceFund,
        address _harvester,
        uint64 _splitTimelock
    ) Ownable(_owner) {
        if (address(_etx) == address(0)) revert FeeRouter_ZeroAddress();
        if (_owner == address(0)) revert FeeRouter_ZeroAddress();
        if (address(_insuranceFund) == address(0)) revert FeeRouter_ZeroAddress();
        if (_harvester == address(0)) revert FeeRouter_ZeroAddress();

        etx = _etx;
        insuranceFund = _insuranceFund;
        harvester = _harvester;
        splitTimelock = _splitTimelock;

        toInsuranceBps = 2000;
        toHarvesterBps = 8000;

        // One-time max approval lets `insuranceFund.deposit(...)` pull on each
        // routeFee. SafeERC20 forceApprove handles non-standard tokens, but ETX
        // is standard so a direct approve would also work; using forceApprove
        // for defensive uniformity with the rest of the bridge stack.
        _etx.forceApprove(address(_insuranceFund), type(uint256).max);
    }

    /* -------------------------------------------------------------------- */
    /*                          ONE-TIME VAULT WIRE                         */
    /* -------------------------------------------------------------------- */

    /// @notice Wire the linked bridge vault. Callable once by owner; locked thereafter.
    function setBridgeVault(address _bridgeVault) external onlyOwner {
        if (_bridgeVault == address(0)) revert FeeRouter_ZeroAddress();
        if (bridgeVault != address(0)) revert FeeRouter_VaultAlreadySet();
        bridgeVault = _bridgeVault;
        emit BridgeVaultSet(_bridgeVault);
    }

    /* -------------------------------------------------------------------- */
    /*                              ROUTING                                 */
    /* -------------------------------------------------------------------- */

    /// @notice Split a previously-transferred fee balance and forward each share.
    /// @dev Caller (the vault) MUST transfer `amount` ETX to this contract
    ///      before calling. The function reverts if the held balance is less
    ///      than `amount` to make accounting bugs noisy.
    /// @param amount The fee amount the vault just transferred to this contract.
    function routeFee(uint128 amount) external onlyBridgeVault {
        if (amount == 0) {
            emit FeeRouted(0, 0, 0);
            return;
        }
        uint256 held = etx.balanceOf(address(this));
        if (held < amount) revert FeeRouter_InsufficientBalance(amount, held);

        // Insurance share rounds down; harvester gets the remainder so dust
        // never accumulates in this contract.
        uint128 insuranceShare = uint128((uint256(amount) * toInsuranceBps) / TOTAL_BPS);
        uint128 harvesterShare = amount - insuranceShare;

        if (insuranceShare > 0) {
            insuranceFund.deposit(insuranceShare);
        }
        if (harvesterShare > 0) {
            etx.safeTransfer(harvester, harvesterShare);
        }

        emit FeeRouted(amount, insuranceShare, harvesterShare);
    }

    /* -------------------------------------------------------------------- */
    /*                       OWNER SPLIT-CHANGE FLOW                        */
    /* -------------------------------------------------------------------- */

    /// @notice Schedule a future split update. Executable after `splitTimelock`.
    function requestSplitChange(uint16 newInsuranceBps, uint16 newHarvesterBps)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (uint256(newInsuranceBps) + uint256(newHarvesterBps) != TOTAL_BPS) {
            revert FeeRouter_InvalidSplit(newInsuranceBps, newHarvesterBps);
        }

        id = nextSplitId++;
        uint64 executableAt = uint64(block.timestamp) + splitTimelock;
        pendingSplits[id] = PendingSplit({
            toInsuranceBps: newInsuranceBps,
            toHarvesterBps: newHarvesterBps,
            executableAt: executableAt,
            executed: false,
            cancelled: false
        });

        emit SplitChangeRequested(id, newInsuranceBps, newHarvesterBps, executableAt);
    }

    /// @notice Execute a previously requested split change once timelock elapsed.
    function executeSplitChange(uint256 id) external onlyOwner {
        PendingSplit storage s = pendingSplits[id];
        // executableAt is always non-zero on a valid request (set to
        // block.timestamp + timelock, which is never zero). Use it as the
        // existence sentinel; bps fields can legitimately be zero on one side.
        if (s.executableAt == 0) revert FeeRouter_InvalidSplitId(id);
        if (s.executed) revert FeeRouter_AlreadyExecuted(id);
        if (s.cancelled) revert FeeRouter_AlreadyCancelled(id);
        if (block.timestamp < s.executableAt) {
            revert FeeRouter_TimelockNotElapsed(s.executableAt, uint64(block.timestamp));
        }

        s.executed = true;
        toInsuranceBps = s.toInsuranceBps;
        toHarvesterBps = s.toHarvesterBps;
        emit SplitChanged(s.toInsuranceBps, s.toHarvesterBps);
    }

    /// @notice Cancel a pending split change at any time before execution.
    function cancelSplitChange(uint256 id) external onlyOwner {
        PendingSplit storage s = pendingSplits[id];
        if (s.executableAt == 0) revert FeeRouter_InvalidSplitId(id);
        if (s.executed) revert FeeRouter_AlreadyExecuted(id);
        if (s.cancelled) revert FeeRouter_AlreadyCancelled(id);

        s.cancelled = true;
        emit SplitChangeCancelled(id);
    }

    /* -------------------------------------------------------------------- */
    /*                           RESCUE / RECOVERY                          */
    /* -------------------------------------------------------------------- */

    /// @notice Recover ERC-20 tokens accidentally sent to this contract.
    ///         Cannot rescue the managed ETX token — only unrelated tokens.
    function rescueERC20(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (address(token) == address(etx)) revert FeeRouter_ZeroAddress();
        if (to == address(0)) revert FeeRouter_ZeroAddress();
        token.safeTransfer(to, amount);
    }
}
