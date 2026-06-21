// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title EtomicSwap
/// @notice Komodo DeFi Framework HTLC atomic swap contract with a 1% fee
///         split equally among three immutable recipients.
///         Enables trustless cross-chain swaps between Etica and any other
///         chain in the Komodo network (ETH, MATIC, AVAX, BNB, Base, etc.).
/// @dev    No owner, no admin, no upgrade path. Fee recipients and percentage
///         are burned into bytecode at deploy time via immutable/constant.
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

    /// @notice 1% fee in basis points.
    uint256 public constant FEE_BPS = 100;
    uint256 private constant BPS_DENOM = 10_000;

    /// @notice Three immutable fee recipients (equal thirds).
    address payable public immutable feeRecipient1;
    address payable public immutable feeRecipient2;
    address payable public immutable feeRecipient3;

    mapping(bytes32 => Payment) public payments;

    event PaymentSent(bytes32 id);
    event ReceiverSpent(bytes32 id, bytes32 secret);
    event SenderRefunded(bytes32 id);
    event FeePaid(address indexed recipient, uint256 amount);

    constructor(
        address payable _recipient1,
        address payable _recipient2,
        address payable _recipient3
    ) {
        require(_recipient1 != address(0), "Recipient1 cannot be zero");
        require(_recipient2 != address(0), "Recipient2 cannot be zero");
        require(_recipient3 != address(0), "Recipient3 cannot be zero");
        feeRecipient1 = _recipient1;
        feeRecipient2 = _recipient2;
        feeRecipient3 = _recipient3;
    }

    /// @notice Lock native coin (EGAZ) in an HTLC. 1% fee is deducted and split.
    function ethPayment(bytes32 id, address receiver, bytes20 secretHash, uint64 lockTime)
        external
        payable
    {
        require(receiver != address(0), "Receiver cannot be the zero address");
        require(msg.value > 0, "Payment amount must be greater than 0");
        require(payments[id].state == PaymentState.Uninitialized, "ETH payment already initialized");

        uint256 fee = (msg.value * FEE_BPS) / BPS_DENOM;
        uint256 locked = msg.value - fee;

        _distributeFeeETH(fee);

        bytes20 paymentHash =
            ripemd160(abi.encodePacked(receiver, msg.sender, secretHash, address(0), locked));

        payments[id] = Payment(paymentHash, lockTime, PaymentState.PaymentSent);

        emit PaymentSent(id);
    }

    /// @notice Lock ERC-20 tokens (ETI or others) in an HTLC. 1% fee is deducted and split.
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
            payments[id].state == PaymentState.Uninitialized, "ERC20 payment already initialized"
        );

        uint256 fee = (amount * FEE_BPS) / BPS_DENOM;
        uint256 locked = amount - fee;

        // Pull full amount from sender
        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), amount);

        // Distribute fee to recipients
        _distributeFeeERC20(tokenAddress, fee);

        bytes20 paymentHash =
            ripemd160(abi.encodePacked(receiver, msg.sender, secretHash, tokenAddress, locked));

        payments[id] = Payment(paymentHash, lockTime, PaymentState.PaymentSent);

        emit PaymentSent(id);
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

        bytes20 paymentHash =
            ripemd160(abi.encodePacked(receiver, msg.sender, secretHash, tokenAddress, amount));
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

    /// @dev Split native ETH/EGAZ fee equally among three recipients.
    function _distributeFeeETH(uint256 fee) private {
        uint256 share = fee / 3;
        uint256 remainder = fee - (share * 3);

        feeRecipient1.transfer(share);
        feeRecipient2.transfer(share);
        feeRecipient3.transfer(share + remainder);

        emit FeePaid(feeRecipient1, share);
        emit FeePaid(feeRecipient2, share);
        emit FeePaid(feeRecipient3, share + remainder);
    }

    /// @dev Split ERC-20 token fee equally among three recipients.
    function _distributeFeeERC20(address tokenAddress, uint256 fee) private {
        uint256 share = fee / 3;
        uint256 remainder = fee - (share * 3);

        IERC20(tokenAddress).safeTransfer(feeRecipient1, share);
        IERC20(tokenAddress).safeTransfer(feeRecipient2, share);
        IERC20(tokenAddress).safeTransfer(feeRecipient3, share + remainder);

        emit FeePaid(feeRecipient1, share);
        emit FeePaid(feeRecipient2, share);
        emit FeePaid(feeRecipient3, share + remainder);
    }
}
