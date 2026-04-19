// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

/// @notice Safe transfer helpers that tolerate ERC20s that don't return a boolean.
library TransferHelper {
    function safeApprove(address token, address to, uint256 value) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x095ea7b3, to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TH: APPROVE_FAILED");
    }

    function safeTransfer(address token, address to, uint256 value) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TH: TRANSFER_FAILED");
    }

    function safeTransferFrom(address token, address from, address to, uint256 value) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TH: TRANSFER_FROM_FAILED");
    }

    function safeTransferEGAZ(address to, uint256 value) internal {
        (bool ok,) = to.call{value: value}(new bytes(0));
        require(ok, "TH: EGAZ_TRANSFER_FAILED");
    }
}
