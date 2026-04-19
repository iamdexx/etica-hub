// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

/// @notice ERC20 representation of ETI on Ethereum. Only the bridge minter
/// contract can mint/burn. Owner (treasury) can rotate the minter if the
/// bridge is migrated.
contract WrappedETI is ERC20, Ownable {
    error NotMinter();

    address public minter;

    event MinterChanged(address indexed oldMinter, address indexed newMinter);

    constructor(address owner_) ERC20("Wrapped ETI", "wETI") Ownable(owner_) {}

    function setMinter(address newMinter) external onlyOwner {
        address old = minter;
        minter = newMinter;
        emit MinterChanged(old, newMinter);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }

    /// @notice Burn `amount` wETI from `from`. Callable only by the minter,
    /// and always spends ERC20 allowance — this ensures even a future
    /// (rotated) minter cannot burn arbitrary holder balances without their
    /// explicit approval. Users approve the minter before calling
    /// `EthereumBridgeMinter.burn`.
    function burnFrom(address from, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _spendAllowance(from, msg.sender, amount);
        _burn(from, amount);
    }
}
