// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Pausable} from "openzeppelin-contracts/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAttestationVerifier} from "./interfaces/IAttestationVerifier.sol";

/// @title EticaBridgeVault
/// @notice Custody of ETI on the Etica chain.
///
/// Fee model: fees are charged on the **destination** chain only. The vault
/// locks the full deposit amount on the source side and splits the
/// withdrawal amount (net to recipient + fee to treasury) on the
/// destination side. This preserves the invariant
/// `vault.balanceOf(ETI) == wETI.totalSupply` across both directions of
/// bridge flow.
contract EticaBridgeVault is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error AlreadyProcessed(bytes32 nonce);
    error ZeroAmount();
    error ZeroAddress();
    error FeeTooHigh();
    error DailyLimitExceeded(uint256 requested, uint256 remaining);
    error ChainMismatch(uint256 expected, uint256 got);

    event Deposited(
        bytes32 indexed nonce, address indexed sender, uint256 amount, address recipient
    );
    event Withdrawn(
        bytes32 indexed nonce,
        address indexed recipient,
        uint256 netAmount,
        uint256 fee,
        bytes32 srcTxHash
    );
    event VerifierChanged(address indexed oldVerifier, address indexed newVerifier);
    event FeeChanged(uint16 oldFeeBps, uint16 newFeeBps);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event DailyLimitChanged(uint256 oldLimit, uint256 newLimit);

    uint16 public constant MAX_FEE_BPS = 100; // 1%
    uint256 public constant BPS_DENOM = 10_000;
    uint256 public constant DAY = 1 days;

    IERC20 public immutable token; // ETI
    uint256 public immutable remoteChainId; // Ethereum mainnet (1)

    IAttestationVerifier public verifier;
    address public treasury;
    uint16 public feeBps;
    uint256 public dailyLimit;

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

    /// @notice Lock `amount` ETI for bridging to Ethereum. No fee is taken
    /// here — the Ethereum-side minter splits mint amount into (net, fee)
    /// when it mints `amount` wETI. Locking the gross amount preserves the
    /// invariant that `vault.balanceOf(ETI) == wETI.totalSupply` over the
    /// full round trip.
    function deposit(uint256 amount, address recipient)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 nonce)
    {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        token.safeTransferFrom(msg.sender, address(this), amount);

        unchecked {
            depositCounter++;
        }
        nonce = keccak256(abi.encode(block.chainid, address(this), depositCounter));
        emit Deposited(nonce, msg.sender, amount, recipient);
    }

    // --- withdraw (inbound from Ethereum) -------------------------------

    /// @notice Unlock ETI against an attestation of an Ethereum-side burn.
    /// The vault splits `amount` into `(amount - fee)` to `recipient` and
    /// `fee` to `treasury`, both drawn from the locked balance. wETI supply
    /// drops by exactly `amount` on the burn side, so
    /// `vault.balanceOf(ETI)` also drops by exactly `amount` here,
    /// preserving the invariant.
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

        uint256 fee = (amount * feeBps) / BPS_DENOM;
        uint256 net = amount - fee;
        token.safeTransfer(recipient, net);
        if (fee > 0) token.safeTransfer(treasury, fee);
        emit Withdrawn(nonce, recipient, net, fee, srcTxHash);
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
