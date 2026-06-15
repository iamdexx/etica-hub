// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title ETRX — Etica-side bridged TRX, 1:1 backed by TRX locked on TRON
///
/// @notice eTRX is the on-Etica representation of TRX. The keeper takes each
///         twin's accrued TRX revenue on TRON, locks it in the TRON-side reserve,
///         and mints an equal amount of eTRX here. eTRX is then swapped for ETX
///         on the EticaHub DEX (the eTRX/ETX pool) and the ETX is delivered to
///         the holder's payout wallet — this is the "mining ETX" payout leg.
///
/// @dev    1:1 BACKED INVARIANT: `totalSupply()` of eTRX == TRX locked on the
///         TRON side. Mint happens ONLY against newly-locked TRX; burn releases
///         a redemption claim back on TRON. All such policy (proofs, rate limits,
///         veto windows) is enforced upstream by the bridge minter — this token
///         holds no business logic beyond restricted mint/burn.
///
/// @dev    Mint/burn authority is delegated to a single `bridgeMinter`, set once
///         at construction and immutable (no setter). There is no free mint, no
///         admin mint, no owner. To migrate, deploy a new eTRX and re-point the
///         bridge. This mirrors {WrappedETX} so eTRX slots into the existing
///         bridge tooling unchanged.
contract ETRX is ERC20Permit {
    /// @notice The only address allowed to mint and burn eTRX.
    address public immutable bridgeMinter;

    error ETRX_ZeroAddress();
    error ETRX_OnlyBridgeMinter(address caller);

    modifier onlyBridgeMinter() {
        if (msg.sender != bridgeMinter) revert ETRX_OnlyBridgeMinter(msg.sender);
        _;
    }

    constructor(address _bridgeMinter)
        ERC20("Etica Wrapped TRX", "eTRX")
        ERC20Permit("Etica Wrapped TRX")
    {
        if (_bridgeMinter == address(0)) {
            revert ETRX_ZeroAddress();
        }
        bridgeMinter = _bridgeMinter;
    }

    /// @notice Mint `amount` eTRX to `to` against TRX freshly locked on TRON.
    ///         Only callable by `bridgeMinter`, which enforces the 1:1 backing.
    function mint(address to, uint256 amount) external onlyBridgeMinter {
        _mint(to, amount);
    }

    /// @notice Burn `amount` eTRX from `from` when redeeming back to TRON TRX.
    /// @dev    The minter validates `from`/authorization upstream before calling.
    function burn(address from, uint256 amount) external onlyBridgeMinter {
        _burn(from, amount);
    }
}
