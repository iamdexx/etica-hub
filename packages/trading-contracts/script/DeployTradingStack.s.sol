// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import {Script, console2} from "forge-std/Script.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {DutchOrderReactor} from "uniswapx/src/reactors/DutchOrderReactor.sol";
import {OrderQuoter} from "uniswapx/src/lens/OrderQuoter.sol";
import {EticaProtocolFeeController} from "../src/EticaProtocolFeeController.sol";

/// @notice Deploys UniswapX DutchOrderReactor + OrderQuoter (verbatim) plus
///         EticaHub's ETX-denominated fee controller, and wires the fee
///         controller onto the reactor.
///
/// Required environment variables:
///   PERMIT2_ADDRESS   — Permit2 contract (must be deployed first via
///                       packages/contracts/script/deploy-permit2.sh)
///   ETX_ADDRESS       — EticaHub ETX token (0xa5a1bc...650044 on mainnet)
///   TREASURY_ADDRESS  — recipient of ETX protocol fees
///   REACTOR_OWNER     — owner of both the reactor (for future upgrades of
///                       feeController) and the fee controller (for BPS / treasury updates)
///   INITIAL_FEE_BPS   — optional, defaults to 0 (fee-off at launch)
contract DeployTradingStack is Script {
    function run()
        external
        returns (DutchOrderReactor reactor, OrderQuoter quoter, EticaProtocolFeeController feeController)
    {
        address permit2 = vm.envAddress("PERMIT2_ADDRESS");
        address etx = vm.envAddress("ETX_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address reactorOwner = vm.envAddress("REACTOR_OWNER");
        uint256 initialFeeBps = vm.envOr("INITIAL_FEE_BPS", uint256(0));

        require(permit2.code.length > 0, "PERMIT2 not deployed at PERMIT2_ADDRESS");

        vm.startBroadcast();

        reactor = new DutchOrderReactor(IPermit2(permit2), reactorOwner);
        console2.log("DutchOrderReactor:", address(reactor));

        quoter = new OrderQuoter();
        console2.log("OrderQuoter:      ", address(quoter));

        feeController = new EticaProtocolFeeController(etx, treasury, reactorOwner, initialFeeBps);
        console2.log("FeeController:    ", address(feeController));

        // Wire the fee controller on the reactor. Only callable by the reactor's
        // protocolFeeOwner, which is reactorOwner (set in the ctor above), so
        // this tx must be signed by reactorOwner's key.
        reactor.setProtocolFeeController(address(feeController));
        console2.log("Fee controller wired on reactor.");

        vm.stopBroadcast();
    }
}
