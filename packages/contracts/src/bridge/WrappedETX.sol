// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title WrappedETX
/// @notice Restricted-mint ERC20Permit representing ETX bridged from Etica.
///         Lives on Ethereum + BNB Chain (and later Tron). Minted 1:1 against
///         ETX locked in `BridgeVault` on Etica.
///
///         Mint/burn authority is delegated exclusively to a single trusted
///         contract (`BridgeMinter`) set at construction time. The minter
///         address is immutable; no setter exists. To migrate to a new minter,
///         deploy a new wETX and route Hyperlane traffic to it.
///
///         All policy (challenge windows, rate limits, veto, insurance) is
///         enforced upstream of `mint` by `BridgeMinter`. This contract holds
///         no business logic beyond the ERC20Permit standard.
contract WrappedETX is ERC20Permit {
    /// @notice Address authorised to mint and burn wETX.
    /// @dev Set once at construction; no setter. Migrating to a new minter
    ///      requires deploying a new wETX and bridging holders across.
    address public immutable bridgeMinter;

    error WrappedETX_ZeroAddress();
    error WrappedETX_OnlyBridgeMinter(address caller);

    modifier onlyBridgeMinter() {
        if (msg.sender != bridgeMinter) {
            revert WrappedETX_OnlyBridgeMinter(msg.sender);
        }
        _;
    }

    constructor(address _bridgeMinter) ERC20("Wrapped ETX", "wETX") ERC20Permit("Wrapped ETX") {
        if (_bridgeMinter == address(0)) revert WrappedETX_ZeroAddress();
        bridgeMinter = _bridgeMinter;
    }

    /// @notice Mint `amount` wETX to `to`. Only callable by `bridgeMinter`.
    function mint(address to, uint256 amount) external onlyBridgeMinter {
        _mint(to, amount);
    }

    /// @notice Burn `amount` wETX from `from`. Only callable by `bridgeMinter`.
    /// @dev Used during destination-chain → Etica withdrawal flow. The minter
    ///      contract has full burn authority over user balances; users authorise
    ///      this implicitly by calling `BridgeMinter.burn(...)`, which validates
    ///      `from == msg.sender` upstream.
    function burn(address from, uint256 amount) external onlyBridgeMinter {
        _burn(from, amount);
    }
}
