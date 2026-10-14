// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {EticaDirectMetaPair} from "./EticaDirectMetaPair.sol";

/// @notice Stateless deployer that keeps {EticaDirectMetaPair} creation code out
///         of {EticaDirectFactory} (EIP-170). The factory calls `deploy`, then
///         `initialize`s the window itself; a window deployed by anyone else is
///         simply never registered.
contract EticaDirectMetaPairDeployer {
    function deploy(address factory) external returns (address pair) {
        pair = address(new EticaDirectMetaPair(factory));
    }
}
