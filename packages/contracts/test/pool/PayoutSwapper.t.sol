// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EticaV2Factory} from "../../src/v2/EticaV2Factory.sol";
import {EticaSwapRouter} from "../../src/swap/EticaSwapRouter.sol";
import {WEGAZ} from "../../src/swap/WEGAZ.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {PayoutSwapper} from "../../src/pool/PayoutSwapper.sol";

contract PayoutSwapperTest is Test {
    address constant OWNER = address(0x0111);
    address constant POOL = address(0x0901);
    address constant MINER = address(0xB0B);
    address constant LP = address(0xA11CE);

    EticaV2Factory factory;
    EticaSwapRouter router;
    WEGAZ wegaz;
    MockERC20 usdc;
    address pair;
    PayoutSwapper swapper;

    function setUp() public {
        wegaz = new WEGAZ();
        usdc = new MockERC20("USDC.e", "USDC.e");
        factory = new EticaV2Factory(address(0xFEE));
        router = new EticaSwapRouter(address(factory), address(wegaz));
        pair = factory.createPair(address(usdc), address(wegaz));

        // 10,000 EGAZ : 25 USDC.e (≈ $0.0025 per EGAZ, like mainnet)
        vm.deal(LP, 10_000 ether);
        usdc.mint(LP, 25 ether);
        vm.startPrank(LP);
        wegaz.deposit{value: 10_000 ether}();
        wegaz.approve(address(router), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        router.addLiquidity(
            address(wegaz), address(usdc), 10_000 ether, 25 ether, 0, 0, LP, block.timestamp
        );
        vm.stopPrank();

        swapper = new PayoutSwapper(address(wegaz), address(usdc), address(router), pair, OWNER);
        vm.prank(OWNER);
        swapper.setPayer(POOL, true);
        vm.deal(POOL, 1_000 ether);
    }

    function test_payInUsdc_deliversUsdcToMiner() public {
        (uint256 expected, uint256 impact) = swapper.quote(50 ether);
        assertGt(expected, 0);
        assertLt(impact, 100);
        vm.prank(POOL);
        uint256 out = swapper.payInUsdc{value: 50 ether}(MINER, expected * 995 / 1000);
        assertEq(out, expected);
        assertEq(usdc.balanceOf(MINER), expected);
        assertEq(address(swapper).balance, 0);
        assertEq(wegaz.balanceOf(address(swapper)), 0);
        assertEq(usdc.balanceOf(address(swapper)), 0);
    }

    function test_payInUsdc_revertsWhenImpactTooHigh() public {
        // 500 EGAZ into a 10,000 EGAZ reserve ≈ 4.76% > 1%
        (, uint256 impact) = swapper.quote(500 ether);
        vm.prank(POOL);
        vm.expectRevert(
            abi.encodeWithSelector(PayoutSwapper.ImpactTooHigh.selector, impact, uint16(100))
        );
        swapper.payInUsdc{value: 500 ether}(MINER, 0);
        assertEq(usdc.balanceOf(MINER), 0);
    }

    function test_payInUsdc_revertsBelowMinOut() public {
        (uint256 expected,) = swapper.quote(50 ether);
        vm.prank(POOL);
        vm.expectRevert();
        swapper.payInUsdc{value: 50 ether}(MINER, expected + 1);
    }

    function test_payInUsdc_onlyPayer() public {
        vm.deal(MINER, 1 ether);
        vm.prank(MINER);
        vm.expectRevert(PayoutSwapper.NotPayer.selector);
        swapper.payInUsdc{value: 1 ether}(MINER, 0);
    }

    function test_setMaxImpactBps_boundsAndOwner() public {
        vm.prank(MINER);
        vm.expectRevert();
        swapper.setMaxImpactBps(200);
        vm.startPrank(OWNER);
        vm.expectRevert(PayoutSwapper.BpsOutOfRange.selector);
        swapper.setMaxImpactBps(0);
        vm.expectRevert(PayoutSwapper.BpsOutOfRange.selector);
        swapper.setMaxImpactBps(5001);
        swapper.setMaxImpactBps(500);
        vm.stopPrank();
        assertEq(swapper.maxImpactBps(), 500);
        // 500 EGAZ (4.76%) now passes
        (uint256 expected,) = swapper.quote(500 ether);
        vm.prank(POOL);
        swapper.payInUsdc{value: 500 ether}(MINER, expected);
        assertEq(usdc.balanceOf(MINER), expected);
    }
}
