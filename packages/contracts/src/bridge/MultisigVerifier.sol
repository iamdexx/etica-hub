// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";

import {IAttestationVerifier} from "./interfaces/IAttestationVerifier.sol";

/// @title M-of-N ECDSA multisig verifier for bridge attestations
/// @notice Owner maintains the validator set; anyone calls `verify` with
/// signatures. Each signature is an EIP-191 `personal_sign` over the
/// attestation digest.
contract MultisigVerifier is IAttestationVerifier, Ownable {
    error NotAValidator(address signer);
    error DuplicateSigner(address signer);
    error InsufficientSignatures(uint256 got, uint256 need);
    error ThresholdOutOfRange();
    error ValidatorAlreadySet(address validator);
    error ValidatorNotSet(address validator);
    error TooFewValidators();

    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);
    event ThresholdChanged(uint256 oldThreshold, uint256 newThreshold);

    mapping(address => bool) public isValidator;
    address[] private _validators;
    uint256 public threshold;

    constructor(address owner_, address[] memory initialValidators, uint256 initialThreshold)
        Ownable(owner_)
    {
        if (initialValidators.length == 0) revert TooFewValidators();
        if (initialThreshold == 0 || initialThreshold > initialValidators.length) {
            revert ThresholdOutOfRange();
        }
        for (uint256 i = 0; i < initialValidators.length; i++) {
            address v = initialValidators[i];
            if (v == address(0)) revert NotAValidator(v);
            if (isValidator[v]) revert ValidatorAlreadySet(v);
            isValidator[v] = true;
            _validators.push(v);
            emit ValidatorAdded(v);
        }
        threshold = initialThreshold;
        emit ThresholdChanged(0, initialThreshold);
    }

    function validators() external view returns (address[] memory) {
        return _validators;
    }

    function validatorCount() external view returns (uint256) {
        return _validators.length;
    }

    function addValidator(address v) external onlyOwner {
        if (v == address(0)) revert NotAValidator(v);
        if (isValidator[v]) revert ValidatorAlreadySet(v);
        isValidator[v] = true;
        _validators.push(v);
        emit ValidatorAdded(v);
    }

    function removeValidator(address v) external onlyOwner {
        if (!isValidator[v]) revert ValidatorNotSet(v);
        if (_validators.length - 1 < threshold) revert ThresholdOutOfRange();
        isValidator[v] = false;
        for (uint256 i = 0; i < _validators.length; i++) {
            if (_validators[i] == v) {
                _validators[i] = _validators[_validators.length - 1];
                _validators.pop();
                break;
            }
        }
        emit ValidatorRemoved(v);
    }

    function setThreshold(uint256 newThreshold) external onlyOwner {
        if (newThreshold == 0 || newThreshold > _validators.length) revert ThresholdOutOfRange();
        uint256 old = threshold;
        threshold = newThreshold;
        emit ThresholdChanged(old, newThreshold);
    }

    /// @inheritdoc IAttestationVerifier
    function verify(bytes32 digest, bytes[] calldata signatures) external view {
        if (signatures.length < threshold) {
            revert InsufficientSignatures(signatures.length, threshold);
        }
        bytes32 ethSignedHash =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));

        // Track distinct signers without a dynamic set: check each new signer
        // against all previously accepted ones. O(k^2) but k is small (≤ ~7).
        address[] memory seen = new address[](signatures.length);
        uint256 good = 0;
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ECDSA.recover(ethSignedHash, signatures[i]);
            if (!isValidator[signer]) revert NotAValidator(signer);
            for (uint256 j = 0; j < good; j++) {
                if (seen[j] == signer) revert DuplicateSigner(signer);
            }
            seen[good] = signer;
            unchecked {
                good++;
            }
        }
        if (good < threshold) revert InsufficientSignatures(good, threshold);
    }
}
