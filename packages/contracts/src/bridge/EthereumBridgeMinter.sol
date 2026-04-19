// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Pausable} from "openzeppelin-contracts/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

import {IAttestationVerifier} from "./interfaces/IAttestationVerifier.sol";
import {WrappedETI} from "./WrappedETI.sol";

/// @title EthereumBridgeMinter
/// @notice Mint wETI on Ethereum against attestations from the Etica-side
/// vault's Deposit events; burn wETI on Ethereum to trigger withdrawal on
/// Etica. No user funds are held by this contract beyond the accrued
/// protocol fee on inbound mints.
contract EthereumBridgeMinter is Ownable, Pausable, ReentrancyGuard {
    error AlreadyProcessed(bytes32 nonce);
    error ZeroAmount();
    error ZeroAddress();
    error FeeTooHigh();
    error DailyLimitExceeded(uint256 requested, uint256 remaining);
    error ChainMismatch(uint256 expected, uint256 got);

    event Minted(
        bytes32 indexed nonce,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        bytes32 srcTxHash
    );
    event Burned(bytes32 indexed nonce, address indexed sender, uint256 amount, address recipient);
    event VerifierChanged(address indexed oldVerifier, address indexed newVerifier);
    event FeeChanged(uint16 oldFeeBps, uint16 newFeeBps);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event DailyLimitChanged(uint256 oldLimit, uint256 newLimit);

    uint16 public constant MAX_FEE_BPS = 100; // 1%
    uint256 public constant BPS_DENOM = 10_000;
    uint256 public constant DAY = 1 days;

    WrappedETI public immutable token;
    uint256 public immutable remoteChainId; // Etica mainnet (61803)

    IAttestationVerifier public verifier;
    address public treasury;
    uint16 public feeBps;
    uint256 public dailyLimit;

    uint256 public burnNonceCounter;
    mapping(bytes32 => bool) public processed;

    // Rolling daily counter: resets when (block.timestamp / DAY) changes.
    uint256 private _dayAnchor;
    uint256 private _mintedToday;

    constructor(
        address owner_,
        WrappedETI token_,
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

    /// @notice Canonical digest used for attestation signing.
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

    /// @notice Snapshot of the remaining capacity for the current day.
    function remainingDailyCapacity() external view returns (uint256) {
        uint256 today = block.timestamp / DAY;
        if (today != _dayAnchor) return dailyLimit;
        return dailyLimit > _mintedToday ? dailyLimit - _mintedToday : 0;
    }

    // --- mint (inbound from Etica) --------------------------------------

    /// @notice Mint wETI against an attestation of an Etica-side Deposit.
    /// @param srcChainId  chain id of the source (Etica)
    /// @param srcTxHash   Deposit tx hash on Etica (for UX / traceability)
    /// @param nonce       globally unique id from the source vault
    /// @param amount      gross amount of ETI locked on Etica
    /// @param recipient   Ethereum address to receive wETI
    /// @param signatures  attestation signatures
    function mint(
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
        token.mint(recipient, net);
        if (fee > 0) token.mint(treasury, fee);

        emit Minted(nonce, recipient, net, fee, srcTxHash);
    }

    // --- burn (outbound to Etica) ---------------------------------------

    /// @notice Burn `amount` of caller's wETI and emit a Burn event for
    /// validators to attest to on the Etica side.
    /// @param amount     amount of wETI to burn
    /// @param recipient  Etica address to receive ETI once the vault
    ///                   unlocks
    function burn(uint256 amount, address recipient)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 nonce)
    {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        unchecked {
            burnNonceCounter++;
        }
        nonce = keccak256(abi.encode(block.chainid, address(this), burnNonceCounter));
        token.burnFrom(msg.sender, amount);
        emit Burned(nonce, msg.sender, amount, recipient);
    }

    // --- internal -------------------------------------------------------

    function _accountDaily(uint256 amount) private {
        uint256 today = block.timestamp / DAY;
        if (today != _dayAnchor) {
            _dayAnchor = today;
            _mintedToday = 0;
        }
        uint256 remaining = dailyLimit > _mintedToday ? dailyLimit - _mintedToday : 0;
        if (amount > remaining) revert DailyLimitExceeded(amount, remaining);
        _mintedToday += amount;
    }
}
