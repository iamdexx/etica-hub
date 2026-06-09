// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title EtomicSwap
/// @notice Komodo DeFi Framework HTLC atomic swap contract.
///         Enables trustless cross-chain swaps between Etica and any other
///         chain running this same contract (ETH, MATIC, AVAX, BNB, Base, etc.).
/// @dev    Deployed identically on each chain. The Komodo DeFi Framework
///         coordinates the secret-reveal handshake off-chain.
contract EtomicSwap {
    using SafeERC20 for IERC20;

    enum PaymentState {
        Uninitialized,
        PaymentSent,
        ReceiverSpent,
        SenderRefunded
    }

    struct Payment {
        bytes20 paymentHash;
        uint64 lockTime;
        PaymentState state;
    }

    mapping(bytes32 => Payment) public payments;

    event PaymentSent(bytes32 id);
    event ReceiverSpent(bytes32 id, bytes32 secret);
    event SenderRefunded(bytes32 id);

    constructor() {}

    /// @notice Lock native coin (ETI/EGAZ) in an HTLC.
    function ethPayment(
        bytes32 id,
        address receiver,
        bytes20 secretHash,
        uint64 lockTime
    ) external payable {
        require(receiver != address(0), "Receiver cannot be the zero address");
        require(msg.value > 0, "Payment amount must be greater than 0");
        require(
            payments[id].state == PaymentState.Uninitialized,
            "ETH payment already initialized"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(receiver, msg.sender, secretHash, address(0), msg.value)
        );

        payments[id] = Payment(paymentHash, lockTime, PaymentState.PaymentSent);

        emit PaymentSent(id);
    }

    /// @notice Lock ERC-20 tokens in an HTLC.
    function erc20Payment(
        bytes32 id,
        uint256 amount,
        address tokenAddress,
        address receiver,
        bytes20 secretHash,
        uint64 lockTime
    ) external {
        require(receiver != address(0), "Receiver cannot be the zero address");
        require(tokenAddress != address(0), "Token address cannot be zero");
        require(amount > 0, "Payment amount must be greater than 0");
        require(
            payments[id].state == PaymentState.Uninitialized,
            "ERC20 payment already initialized"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(receiver, msg.sender, secretHash, tokenAddress, amount)
        );

        payments[id] = Payment(paymentHash, lockTime, PaymentState.PaymentSent);

        emit PaymentSent(id);

        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Counterparty claims funds by revealing the secret preimage.
    function receiverSpend(
        bytes32 id,
        uint256 amount,
        bytes32 secret,
        address tokenAddress,
        address sender
    ) external {
        require(
            payments[id].state == PaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                msg.sender,
                sender,
                ripemd160(abi.encodePacked(sha256(abi.encodePacked(secret)))),
                tokenAddress,
                amount
            )
        );
        require(paymentHash == payments[id].paymentHash, "Invalid paymentHash");

        payments[id].state = PaymentState.ReceiverSpent;

        emit ReceiverSpent(id, secret);

        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(amount);
        } else {
            IERC20(tokenAddress).safeTransfer(msg.sender, amount);
        }
    }

    /// @notice Original sender reclaims funds after timelock expires.
    function senderRefund(
        bytes32 id,
        uint256 amount,
        bytes20 secretHash,
        address tokenAddress,
        address receiver
    ) external {
        require(
            payments[id].state == PaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(receiver, msg.sender, secretHash, tokenAddress, amount)
        );
        require(paymentHash == payments[id].paymentHash, "Invalid paymentHash");
        require(
            block.timestamp >= payments[id].lockTime,
            "Current timestamp didn't exceed payment lock time"
        );

        payments[id].state = PaymentState.SenderRefunded;

        emit SenderRefunded(id);

        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(amount);
        } else {
            IERC20(tokenAddress).safeTransfer(msg.sender, amount);
        }
    }
}
