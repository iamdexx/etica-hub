// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Pausable} from "openzeppelin-contracts/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAttestationVerifier} from "./interfaces/IAttestationVerifier.sol";

/// @title EticaBridgeVault
/// @notice Custody of ETI on the Etica chain. Users `deposit` to lock ETI
/// and receive wETI on Ethereum; users receive ETI via `withdraw` against
/// an attestation of a burn on Ethereum.
contract EticaBridgeVault is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error AlreadyProcessed(bytes32 nonce);
    error ZeroAmount();
    error ZeroAddress();
    error FeeTooHigh();
    error DailyLimitExceeded(uint256 requested, uint256 remaining);
    error ChainMismatch(uint256 expected, uint256 got);

    event Deposited(
        bytes32 indexed nonce,
        address indexed sender,
        uint256 amountLocked,
        uint256 fee,
        address recipient
    );
    event Withdrawn(
        bytes32 indexed nonce, address indexed recipient, uint256 amount, bytes32 srcTxHash
    );
    event VerifierChanged(address indexed oldVerifier, address indexed newVerifier);
    event FeeChanged(uint16 oldFeeBps, uint16 newFeeBps);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event DailyLimitChanged(uint256 oldLimit, uint256 newLimit);
    event FeeSkimmed(address indexed to, uint256 amount);

    uint16 public constant MAX_FEE_BPS = 100; // 1%
    uint256 public constant BPS_DENOM = 10_000;
    uint256 public constant DAY = 1 days;

    IERC20 public immutable token; // ETI
    uint256 public immutable remoteChainId; // Ethereum mainnet (1)

    IAttestationVerifier public verifier;
    address public treasury;
    uint16 public feeBps;
    uint256 public dailyLimit;
    uint256 public accruedFees;

    uint256 public depositCounter;
    mapping(bytes32 => bool) public processed;

    uint256 private _dayAnchor;
    uint256 private _withdrawnToday;

    constructor(
        address owner_,
        IERC20 token_,
        IAttestationVerifier verifier_,
        address treasury_,
        uint16 feeBps_,
        uint256 dailyLimit_,
        uint256 remoteChainId_
    ) Ownable(owner_) {
        if (
            address(token_) == address(0) || address(verifier_) == address(0)
                || treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        token = token_;
        verifier = verifier_;
        treasury = treasury_;
        feeBps = feeBps_;
        dailyLimit = dailyLimit_;
        remoteChainId = remoteChainId_;
        _dayAnchor = block.timestamp / DAY;
    }

    // --- admin ----------------------------------------------------------

    function setVerifier(IAttestationVerifier v) external onlyOwner {
        if (address(v) == address(0)) revert ZeroAddress();
        emit VerifierChanged(address(verifier), address(v));
        verifier = v;
    }

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeChanged(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryChanged(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setDailyLimit(uint256 newLimit) external onlyOwner {
        emit DailyLimitChanged(dailyLimit, newLimit);
        dailyLimit = newLimit;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function skim() external nonReentrant {
        uint256 amt = accruedFees;
        if (amt == 0) return;
        accruedFees = 0;
        token.safeTransfer(treasury, amt);
        emit FeeSkimmed(treasury, amt);
    }

    // --- views ----------------------------------------------------------

    function buildDigest(
        uint256 srcChainId,
        uint256 dstChainId,
        bytes32 srcTxHash,
        bytes32 nonce,
        address tokenAddr,
        uint256 amount,
        address recipient
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(srcChainId, dstChainId, srcTxHash, nonce, tokenAddr, amount, recipient)
        );
    }

    function remainingDailyCapacity() external view returns (uint256) {
        uint256 today = block.timestamp / DAY;
        if (today != _dayAnchor) return dailyLimit;
        return dailyLimit > _withdrawnToday ? dailyLimit - _withdrawnToday : 0;
    }

    // --- deposit (outbound to Ethereum) ---------------------------------

    /// @notice Lock `amount` ETI; emits a Deposit event for validators to
    /// attest to on the Ethereum side. The gross `amount` is locked (i.e.
    /// the vault always holds strictly at least the sum of outstanding
    /// wETI supply); fee accrues from that locked balance and is paid to
    /// the treasury via `skim()`.
    /// @param amount     amount of ETI to lock
    /// @param recipient  Ethereum address that will mint the corresponding
    ///                   wETI (amount - fee)
    function deposit(uint256 amount, address recipient)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 nonce)
    {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 fee = (amount * feeBps) / BPS_DENOM;
        accruedFees += fee;

        unchecked {
            depositCounter++;
        }
        nonce = keccak256(abi.encode(block.chainid, address(this), depositCounter));
        emit Deposited(nonce, msg.sender, amount, fee, recipient);
    }

    // --- withdraw (inbound from Ethereum) -------------------------------

    /// @notice Unlock ETI against an attestation of an Ethereum-side burn.
    function withdraw(
        uint256 srcChainId,
        bytes32 srcTxHash,
        bytes32 nonce,
        uint256 amount,
        address recipient,
        bytes[] calldata signatures
    ) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (srcChainId != remoteChainId) revert ChainMismatch(remoteChainId, srcChainId);
        if (processed[nonce]) revert AlreadyProcessed(nonce);

        bytes32 digest = buildDigest(
            srcChainId, block.chainid, srcTxHash, nonce, address(token), amount, recipient
        );
        verifier.verify(digest, signatures);

        _accountDaily(amount);
        processed[nonce] = true;

        token.safeTransfer(recipient, amount);
        emit Withdrawn(nonce, recipient, amount, srcTxHash);
    }

    function _accountDaily(uint256 amount) private {
        uint256 today = block.timestamp / DAY;
        if (today != _dayAnchor) {
            _dayAnchor = today;
            _withdrawnToday = 0;
        }
        uint256 remaining = dailyLimit > _withdrawnToday ? dailyLimit - _withdrawnToday : 0;
        if (amount > remaining) revert DailyLimitExceeded(amount, remaining);
        _withdrawnToday += amount;
    }
}
