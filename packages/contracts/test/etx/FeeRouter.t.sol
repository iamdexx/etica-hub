// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EticaSwapFactory} from "../../src/swap/EticaSwapFactory.sol";
import {EticaSwapRouter} from "../../src/swap/EticaSwapRouter.sol";
import {EticaSwapPair} from "../../src/swap/EticaSwapPair.sol";
import {WEGAZ} from "../../src/swap/WEGAZ.sol";

import {ETXToken} from "../../src/etx/ETXToken.sol";
import {xETXVault} from "../../src/etx/xETXVault.sol";
import {FeeRouter, IEticaSwapRouterLike, IxETXVault} from "../../src/etx/FeeRouter.sol";

import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice End-to-end: LPs pay fees → FeeRouter harvests LP → swaps to ETI →
///         distributes to xETXVault → stakers earn real yield.
contract FeeRouterTest is Test {
    EticaSwapFactory internal factory;
    EticaSwapRouter internal router;
    WEGAZ internal wegaz;

    ETXToken internal etx;
    MockERC20 internal eti; // mock standing in for real ETI
    MockERC20 internal dai; // generic swap token

    xETXVault internal vault;
    FeeRouter internal feeRouter;

    address internal owner = address(this);
    address internal treasury = address(0xB2B4);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        wegaz = new WEGAZ();
        factory = new EticaSwapFactory(owner);
        router = new EticaSwapRouter(address(factory), address(wegaz));

        etx = new ETXToken(address(this));
        eti = new MockERC20("Etica", "ETI");
        dai = new MockERC20("Dai", "DAI");

        vault = new xETXVault(IERC20(address(etx)), IERC20(address(eti)), owner);

        feeRouter = new FeeRouter(
            IEticaSwapRouterLike(address(router)),
            IERC20(address(eti)),
            IxETXVault(address(vault)),
            owner,
            0
        );

        vault.setDistributor(address(feeRouter));
        factory.setFeeTo(address(feeRouter));

        // seed liquidity for DAI/ETI pair
        dai.mint(alice, 1_000_000 ether);
        eti.mint(alice, 1_000_000 ether);
        vm.startPrank(alice);
        dai.approve(address(router), type(uint256).max);
        eti.approve(address(router), type(uint256).max);
        router.addLiquidity(
            address(dai),
            address(eti),
            100_000 ether,
            100_000 ether,
            0,
            0,
            alice,
            block.timestamp + 1
        );
        vm.stopPrank();

        // bob stakes ETX in vault
        etx.transfer(bob, 1_000 ether);
        vm.startPrank(bob);
        etx.approve(address(vault), type(uint256).max);
        vault.stake(1_000 ether);
        vm.stopPrank();
    }

    function test_endToEnd_feeFlowsToStakers() public {
        // generate volume so _mintFee accrues LP tokens to FeeRouter
        uint256 traderIn = 1_000 ether;
        dai.mint(address(this), traderIn * 100);
        dai.approve(address(router), type(uint256).max);
        eti.approve(address(router), type(uint256).max);
        address[] memory path = new address[](2);
        path[0] = address(dai);
        path[1] = address(eti);
        for (uint256 i; i < 50; i++) {
            router.swapExactTokensForTokens(traderIn, 0, path, address(this), block.timestamp + 1);
            (path[0], path[1]) = (path[1], path[0]);
            uint256 bal = IERC20(path[0]).balanceOf(address(this));
            uint256 amt = bal / 2;
            if (amt > 0) {
                router.swapExactTokensForTokens(amt, 0, path, address(this), block.timestamp + 1);
            }
            (path[0], path[1]) = (path[1], path[0]);
        }

        // touch the pair so _mintFee fires (it only fires on mint/burn)
        address pair = factory.getPair(address(dai), address(eti));
        // trigger a dust mint to force _mintFee to run and mint LP to feeTo
        vm.startPrank(alice);
        dai.transfer(pair, 1 ether);
        eti.transfer(pair, 1 ether);
        EticaSwapPair(pair).mint(alice);
        vm.stopPrank();

        uint256 feeLp = EticaSwapPair(pair).balanceOf(address(feeRouter));
        assertGt(feeLp, 0, "FeeRouter should hold LP from fee accrual");

        // FeeRouter harvests the pair
        (uint256 a0, uint256 a1) = feeRouter.harvestPair(pair);
        assertGt(a0 + a1, 0);

        // swap the non-ETI token (DAI) to ETI
        address[] memory swapPath = new address[](2);
        swapPath[0] = address(dai);
        swapPath[1] = address(eti);
        uint256 daiBal = dai.balanceOf(address(feeRouter));
        if (daiBal > 0) {
            feeRouter.swapToEti(address(dai), swapPath, 0);
        }

        uint256 etiBal = eti.balanceOf(address(feeRouter));
        assertGt(etiBal, 0, "FeeRouter should hold ETI after swap");

        // distribute to vault
        feeRouter.distribute();

        // bob waits out the reward window
        vm.warp(block.timestamp + 7 days);

        vm.prank(bob);
        vault.claimReward();

        assertGt(eti.balanceOf(bob), 0, "staker should have earned ETI");
    }

    function test_constructor_revertsIfVaultAssetMismatch() public {
        MockERC20 wrongReward = new MockERC20("X", "X");
        xETXVault wrongVault =
            new xETXVault(IERC20(address(etx)), IERC20(address(wrongReward)), owner);
        vm.expectRevert(bytes("FR: vault mismatch"));
        new FeeRouter(
            IEticaSwapRouterLike(address(router)),
            IERC20(address(eti)),
            IxETXVault(address(wrongVault)),
            owner,
            0
        );
    }

    function test_swapToEti_revertsIfPathEndNotEti() public {
        address[] memory badPath = new address[](2);
        badPath[0] = address(dai);
        badPath[1] = address(dai);
        vm.expectRevert(bytes("FR: path end != eti"));
        feeRouter.swapToEti(address(dai), badPath, 0);
    }
}
