// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {EticaProtocolFeeController} from "../src/EticaProtocolFeeController.sol";
import {ResolvedOrder, OrderInfo, InputToken, OutputToken} from "uniswapx/src/base/ReactorStructs.sol";
import {IReactor} from "uniswapx/src/interfaces/IReactor.sol";
import {IValidationCallback} from "uniswapx/src/interfaces/IValidationCallback.sol";

contract EticaProtocolFeeControllerTest is Test {
    address constant ETX = address(0xE7);
    address constant OTHER = address(0x0E);
    address constant TREASURY = address(0xA0);
    address constant OWNER = address(0xB0);
    address constant USER = address(0xC0);

    EticaProtocolFeeController feeController;

    function setUp() public {
        feeController = new EticaProtocolFeeController(ETX, TREASURY, OWNER, 10); // 10 bps
    }

    // ---------- constructor ----------

    function test_constructor_setsState() public view {
        assertEq(feeController.ETX(), ETX);
        assertEq(feeController.treasury(), TREASURY);
        assertEq(feeController.owner(), OWNER);
        assertEq(feeController.feeBps(), 10);
    }

    function test_constructor_rejectsZeroEtx() public {
        vm.expectRevert(EticaProtocolFeeController.ZeroAddress.selector);
        new EticaProtocolFeeController(address(0), TREASURY, OWNER, 0);
    }

    function test_constructor_rejectsZeroTreasury() public {
        vm.expectRevert(EticaProtocolFeeController.ZeroAddress.selector);
        new EticaProtocolFeeController(ETX, address(0), OWNER, 0);
    }

    function test_constructor_rejectsZeroOwner() public {
        vm.expectRevert(EticaProtocolFeeController.ZeroAddress.selector);
        new EticaProtocolFeeController(ETX, TREASURY, address(0), 0);
    }

    function test_constructor_rejectsFeeAboveCap() public {
        vm.expectRevert(EticaProtocolFeeController.FeeTooHigh.selector);
        new EticaProtocolFeeController(ETX, TREASURY, OWNER, 101);
    }

    // ---------- owner-only setters ----------

    function test_setFeeBps_onlyOwner() public {
        vm.expectRevert(EticaProtocolFeeController.OnlyOwner.selector);
        feeController.setFeeBps(50);
    }

    function test_setFeeBps_rejectsAboveCap() public {
        vm.prank(OWNER);
        vm.expectRevert(EticaProtocolFeeController.FeeTooHigh.selector);
        feeController.setFeeBps(101);
    }

    function test_setFeeBps_worksAtCap() public {
        vm.prank(OWNER);
        feeController.setFeeBps(100);
        assertEq(feeController.feeBps(), 100);
    }

    function test_setTreasury_onlyOwner() public {
        vm.expectRevert(EticaProtocolFeeController.OnlyOwner.selector);
        feeController.setTreasury(address(0xBEEF));
    }

    function test_setTreasury_rejectsZero() public {
        vm.prank(OWNER);
        vm.expectRevert(EticaProtocolFeeController.ZeroAddress.selector);
        feeController.setTreasury(address(0));
    }

    function test_setOwner_rotates() public {
        vm.prank(OWNER);
        feeController.setOwner(address(0xBEEF));
        assertEq(feeController.owner(), address(0xBEEF));

        // Old owner is locked out.
        vm.prank(OWNER);
        vm.expectRevert(EticaProtocolFeeController.OnlyOwner.selector);
        feeController.setFeeBps(5);
    }

    // ---------- getFeeOutputs ----------

    function test_getFeeOutputs_zeroBps_returnsEmpty() public {
        vm.prank(OWNER);
        feeController.setFeeBps(0);

        ResolvedOrder memory order = _orderEtxInput(1_000_000);
        OutputToken[] memory outs = feeController.getFeeOutputs(order);
        assertEq(outs.length, 0);
    }

    function test_getFeeOutputs_etxInput_skims() public view {
        ResolvedOrder memory order = _orderEtxInput(1_000_000);
        OutputToken[] memory outs = feeController.getFeeOutputs(order);
        assertEq(outs.length, 1);
        assertEq(outs[0].token, ETX);
        // 10 bps = 0.1% -> 1_000_000 * 10 / 10_000 = 1_000
        assertEq(outs[0].amount, 1_000);
        assertEq(outs[0].recipient, TREASURY);
    }

    function test_getFeeOutputs_etxOutput_skims() public view {
        ResolvedOrder memory order = _orderEtxOutput(5_000_000);
        OutputToken[] memory outs = feeController.getFeeOutputs(order);
        assertEq(outs.length, 1);
        assertEq(outs[0].token, ETX);
        assertEq(outs[0].amount, 5_000);
        assertEq(outs[0].recipient, TREASURY);
    }

    function test_getFeeOutputs_noEtxLeg_returnsEmpty() public view {
        ResolvedOrder memory order = _orderOtherBoth();
        OutputToken[] memory outs = feeController.getFeeOutputs(order);
        assertEq(outs.length, 0);
    }

    function test_getFeeOutputs_tinyTrade_truncatesToZero_returnsEmpty() public view {
        // 10 bps of an amount below 10_000 truncates to 0 -> no fee output.
        ResolvedOrder memory order = _orderEtxInput(500);
        OutputToken[] memory outs = feeController.getFeeOutputs(order);
        assertEq(outs.length, 0);
    }

    function testFuzz_getFeeOutputs_etxInput(uint128 amount, uint256 bps) public {
        bps = bound(bps, 0, 100);
        vm.prank(OWNER);
        feeController.setFeeBps(bps);

        ResolvedOrder memory order = _orderEtxInput(amount);
        OutputToken[] memory outs = feeController.getFeeOutputs(order);

        uint256 expected = (uint256(amount) * bps) / 10_000;
        if (expected == 0) {
            assertEq(outs.length, 0);
        } else {
            assertEq(outs.length, 1);
            assertEq(outs[0].amount, expected);
            assertEq(outs[0].token, ETX);
            assertEq(outs[0].recipient, TREASURY);
        }
    }

    // ---------- helpers ----------

    function _baseOrderInfo() internal pure returns (OrderInfo memory info) {
        info = OrderInfo({
            reactor: IReactor(address(0)),
            swapper: USER,
            nonce: 0,
            deadline: 0,
            additionalValidationContract: IValidationCallback(address(0)),
            additionalValidationData: ""
        });
    }

    function _orderEtxInput(uint256 amount) internal pure returns (ResolvedOrder memory order) {
        OutputToken[] memory outputs = new OutputToken[](1);
        outputs[0] = OutputToken({token: OTHER, amount: amount, recipient: USER});
        order = ResolvedOrder({
            info: _baseOrderInfo(),
            input: InputToken({token: ERC20(ETX), amount: amount, maxAmount: amount}),
            outputs: outputs,
            sig: "",
            hash: bytes32(0)
        });
    }

    function _orderEtxOutput(uint256 amount) internal pure returns (ResolvedOrder memory order) {
        OutputToken[] memory outputs = new OutputToken[](1);
        outputs[0] = OutputToken({token: ETX, amount: amount, recipient: USER});
        order = ResolvedOrder({
            info: _baseOrderInfo(),
            input: InputToken({token: ERC20(OTHER), amount: amount, maxAmount: amount}),
            outputs: outputs,
            sig: "",
            hash: bytes32(0)
        });
    }

    function _orderOtherBoth() internal pure returns (ResolvedOrder memory order) {
        OutputToken[] memory outputs = new OutputToken[](1);
        outputs[0] = OutputToken({token: OTHER, amount: 1_000, recipient: USER});
        order = ResolvedOrder({
            info: _baseOrderInfo(),
            input: InputToken({token: ERC20(OTHER), amount: 1_000, maxAmount: 1_000}),
            outputs: outputs,
            sig: "",
            hash: bytes32(0)
        });
    }
}
