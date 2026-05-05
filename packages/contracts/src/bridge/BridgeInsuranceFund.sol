// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title BridgeInsuranceFund
/// @notice Treasury-funded ETX backstop for the Phase 3 bridge.
///         Holds the operator-pre-funded reserve (10M ETX at launch) and
///         auto-pays into `BridgeVault` whenever a fraudulent claim slips
///         through and creates wETX-vs-ETX undercollateralisation.
///
///         Two access paths:
///           - `draw(amount)` — callable only by the linked `bridgeVault`,
///             returns up to `amount` ETX (capped at current balance).
///             Never reverts on insufficient funds; a partial draw is
///             always preferable to halting the vault.
///           - Owner-controlled withdrawals — must be requested, then
///             executed after a `withdrawTimelock` (default 30d). Owner
///             cannot drain instantly. Designed so a stolen owner key
///             buys the community 30 days of public on-chain warning
///             before any funds can leave the contract.
///
///         The `bridgeVault` address is a one-time setter (deployment
///         ordering: insurance fund deploys first, vault second). Once
///         set, it is locked forever — the vault is the only `draw`
///         caller and cannot be rotated. To migrate, deploy a new
///         insurance fund and bridge any remaining balance via the
///         owner-withdraw flow.
contract BridgeInsuranceFund is Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice The ETX token this fund holds.
    IERC20 public immutable etx;

    /// @notice Time that must elapse between `requestWithdrawal` and
    ///         `executeWithdrawal`. Set at construction; immutable.
    uint64 public immutable withdrawTimelock;

    /// @notice Linked bridge vault. Only this address can call `draw`.
    ///         Set once after deployment; locked thereafter.
    address public bridgeVault;

    struct PendingWithdrawal {
        uint128 amount;
        uint64 executableAt;
        address recipient;
        bool executed;
        bool cancelled;
    }

    mapping(uint256 id => PendingWithdrawal) public pendingWithdrawals;
    uint256 public nextWithdrawalId;

    event BridgeVaultSet(address indexed bridgeVault);
    event InsuranceDeposited(address indexed from, uint128 amount);
    event InsuranceDrawn(address indexed bridgeVault, uint128 requested, uint128 actualDrawn);
    event WithdrawalRequested(
        uint256 indexed id, address indexed recipient, uint128 amount, uint64 executableAt
    );
    event WithdrawalExecuted(uint256 indexed id, address indexed recipient, uint128 amount);
    event WithdrawalCancelled(uint256 indexed id);

    error InsuranceFund_ZeroAddress();
    error InsuranceFund_ZeroAmount();
    error InsuranceFund_OnlyBridgeVault(address caller);
    error InsuranceFund_VaultAlreadySet();
    error InsuranceFund_VaultNotSet();
    error InsuranceFund_InvalidWithdrawalId(uint256 id);
    error InsuranceFund_TimelockNotElapsed(uint64 executableAt, uint64 nowTimestamp);
    error InsuranceFund_AlreadyExecuted(uint256 id);
    error InsuranceFund_AlreadyCancelled(uint256 id);

    modifier onlyBridgeVault() {
        if (msg.sender != bridgeVault) revert InsuranceFund_OnlyBridgeVault(msg.sender);
        _;
    }

    constructor(IERC20 _etx, address _owner, uint64 _withdrawTimelock) Ownable(_owner) {
        if (address(_etx) == address(0)) revert InsuranceFund_ZeroAddress();
        if (_owner == address(0)) revert InsuranceFund_ZeroAddress();
        etx = _etx;
        withdrawTimelock = _withdrawTimelock;
    }

    /* -------------------------------------------------------------------- */
    /*                          ONE-TIME VAULT WIRE                         */
    /* -------------------------------------------------------------------- */

    /// @notice Wire the linked bridge vault. Callable once by owner; locked thereafter.
    function setBridgeVault(address _bridgeVault) external onlyOwner {
        if (_bridgeVault == address(0)) revert InsuranceFund_ZeroAddress();
        if (bridgeVault != address(0)) revert InsuranceFund_VaultAlreadySet();
        bridgeVault = _bridgeVault;
        emit BridgeVaultSet(_bridgeVault);
    }

    /* -------------------------------------------------------------------- */
    /*                              DEPOSITS                                */
    /* -------------------------------------------------------------------- */

    /// @notice Permissionlessly add ETX to the fund. Caller must approve first.
    /// @dev Used by the operator to pre-fund (10M ETX at launch) and by the
    ///      `FeeRouter` to forward the insurance slice of bridge fees.
    function deposit(uint128 amount) external {
        if (amount == 0) revert InsuranceFund_ZeroAmount();
        etx.safeTransferFrom(msg.sender, address(this), amount);
        emit InsuranceDeposited(msg.sender, amount);
    }

    /* -------------------------------------------------------------------- */
    /*                                DRAW                                  */
    /* -------------------------------------------------------------------- */

    /// @notice Pay up to `amount` ETX to the bridge vault to cover a shortfall.
    /// @dev Never reverts on insufficient funds — returns the actual amount
    ///      drawn. Vault is responsible for handling partial coverage.
    /// @return actualDrawn The amount actually transferred (≤ requested).
    function draw(uint128 amount) external onlyBridgeVault returns (uint128 actualDrawn) {
        if (amount == 0) {
            emit InsuranceDrawn(msg.sender, 0, 0);
            return 0;
        }
        uint256 bal = etx.balanceOf(address(this));
        actualDrawn = bal >= amount ? amount : uint128(bal);
        if (actualDrawn > 0) {
            etx.safeTransfer(bridgeVault, actualDrawn);
        }
        emit InsuranceDrawn(msg.sender, amount, actualDrawn);
    }

    /* -------------------------------------------------------------------- */
    /*                       OWNER WITHDRAWAL FLOW                          */
    /* -------------------------------------------------------------------- */

    /// @notice Schedule a future owner-withdrawal. Executable after `withdrawTimelock`.
    function requestWithdrawal(uint128 amount, address recipient)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (amount == 0) revert InsuranceFund_ZeroAmount();
        if (recipient == address(0)) revert InsuranceFund_ZeroAddress();

        id = nextWithdrawalId++;
        uint64 executableAt = uint64(block.timestamp) + withdrawTimelock;
        pendingWithdrawals[id] = PendingWithdrawal({
            amount: amount,
            executableAt: executableAt,
            recipient: recipient,
            executed: false,
            cancelled: false
        });

        emit WithdrawalRequested(id, recipient, amount, executableAt);
    }

    /// @notice Execute a previously requested withdrawal once the timelock has elapsed.
    function executeWithdrawal(uint256 id) external onlyOwner {
        PendingWithdrawal storage w = pendingWithdrawals[id];
        if (w.amount == 0) revert InsuranceFund_InvalidWithdrawalId(id);
        if (w.executed) revert InsuranceFund_AlreadyExecuted(id);
        if (w.cancelled) revert InsuranceFund_AlreadyCancelled(id);
        if (block.timestamp < w.executableAt) {
            revert InsuranceFund_TimelockNotElapsed(w.executableAt, uint64(block.timestamp));
        }

        w.executed = true;
        etx.safeTransfer(w.recipient, w.amount);
        emit WithdrawalExecuted(id, w.recipient, w.amount);
    }

    /// @notice Cancel a pending withdrawal at any time before execution.
    function cancelWithdrawal(uint256 id) external onlyOwner {
        PendingWithdrawal storage w = pendingWithdrawals[id];
        if (w.amount == 0) revert InsuranceFund_InvalidWithdrawalId(id);
        if (w.executed) revert InsuranceFund_AlreadyExecuted(id);
        if (w.cancelled) revert InsuranceFund_AlreadyCancelled(id);

        w.cancelled = true;
        emit WithdrawalCancelled(id);
    }

    /* -------------------------------------------------------------------- */
    /*                                VIEWS                                 */
    /* -------------------------------------------------------------------- */

    /// @notice Current ETX balance held by the insurance fund.
    function balance() external view returns (uint256) {
        return etx.balanceOf(address(this));
    }
}
