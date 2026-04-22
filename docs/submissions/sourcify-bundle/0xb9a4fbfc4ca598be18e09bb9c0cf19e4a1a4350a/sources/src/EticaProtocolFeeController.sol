// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import {IProtocolFeeController} from "uniswapx/src/interfaces/IProtocolFeeController.sol";
import {ResolvedOrder, OutputToken} from "uniswapx/src/base/ReactorStructs.sol";

/// @title  EticaProtocolFeeController
/// @notice UniswapX fee controller for EticaHub's non-custodial trading stack.
///         Charges a BPS-denominated protocol fee denominated in ETX on every
///         fill. Because EticaSwap enforces hub-and-spoke (every pool is
///         ETX-paired), exactly one leg of every trade is ETX, so the fee is
///         always skimmable in ETX without any extra swap hop.
///
/// @dev    The Reactor adds these fee outputs to the resolved order before the
///         filler's callback runs, so the filler (keeper) is responsible for
///         delivering the fee to the treasury atomically with the fill.
///
///         Fee is capped at FEE_CAP_BPS (1%). Owner can raise/lower within that
///         cap and rotate treasury; there is no ability to bypass the cap nor
///         to transfer funds already in the treasury.
contract EticaProtocolFeeController is IProtocolFeeController {
    /// @notice Hard cap on fee BPS. Owner cannot exceed this under any circumstance.
    uint256 public constant FEE_CAP_BPS = 100; // 1%
    /// @notice BPS denominator (10,000 = 100%).
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice The ETX token address; fees are always denominated in ETX.
    address public immutable ETX;

    /// @notice Recipient of all protocol fees.
    address public treasury;
    /// @notice Account authorised to update treasury / feeBps / owner.
    address public owner;
    /// @notice Current fee rate in basis points (0 = disabled).
    uint256 public feeBps;

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);
    event FeeBpsUpdated(uint256 oldBps, uint256 newBps);

    error OnlyOwner();
    error FeeTooHigh();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address _etx, address _treasury, address _owner, uint256 _feeBps) {
        if (_etx == address(0) || _treasury == address(0) || _owner == address(0)) revert ZeroAddress();
        if (_feeBps > FEE_CAP_BPS) revert FeeTooHigh();
        ETX = _etx;
        treasury = _treasury;
        owner = _owner;
        feeBps = _feeBps;
    }

    function setFeeBps(uint256 _feeBps) external onlyOwner {
        if (_feeBps > FEE_CAP_BPS) revert FeeTooHigh();
        emit FeeBpsUpdated(feeBps, _feeBps);
        feeBps = _feeBps;
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    function setOwner(address _owner) external onlyOwner {
        if (_owner == address(0)) revert ZeroAddress();
        emit OwnerUpdated(owner, _owner);
        owner = _owner;
    }

    /// @inheritdoc IProtocolFeeController
    /// @dev Returns a single ETX fee output, or an empty array if the order
    ///      has no ETX leg, fee is zero, or fee truncates to zero on tiny
    ///      trades.
    function getFeeOutputs(ResolvedOrder memory order)
        external
        view
        override
        returns (OutputToken[] memory feeOutputs)
    {
        uint256 bps = feeBps;
        if (bps == 0) return new OutputToken[](0);

        // ETX is on the input leg: skim BPS of input.amount.
        if (address(order.input.token) == ETX) {
            uint256 feeAmount = (order.input.amount * bps) / BPS_DENOMINATOR;
            if (feeAmount == 0) return new OutputToken[](0);
            feeOutputs = new OutputToken[](1);
            feeOutputs[0] = OutputToken({token: ETX, amount: feeAmount, recipient: treasury});
            return feeOutputs;
        }

        // Otherwise look for ETX on the output side.
        for (uint256 i = 0; i < order.outputs.length; i++) {
            if (order.outputs[i].token == ETX) {
                uint256 feeAmount = (order.outputs[i].amount * bps) / BPS_DENOMINATOR;
                if (feeAmount == 0) return new OutputToken[](0);
                feeOutputs = new OutputToken[](1);
                feeOutputs[0] = OutputToken({token: ETX, amount: feeAmount, recipient: treasury});
                return feeOutputs;
            }
        }

        // No ETX leg at all. On EticaSwap this should be unreachable (factory
        // rejects non-ETX pairs), so we charge nothing rather than revert, to
        // keep the Reactor resilient to any future multi-hop path.
        return new OutputToken[](0);
    }
}
