// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EticaSwapFactory} from "../../src/swap/EticaSwapFactory.sol";
import {EticaSwapRouter} from "../../src/swap/EticaSwapRouter.sol";
import {WEGAZ} from "../../src/swap/WEGAZ.sol";
import {IEticaSwapPair} from "../../src/swap/interfaces/IEticaSwapPair.sol";

import {ETXToken} from "../../src/etx/ETXToken.sol";
import {
    ProposalTokenFactory,
    IEticaSwapRouterLike
} from "../../src/launchpad/ProposalTokenFactory.sol";
import {ProposalToken} from "../../src/launchpad/ProposalToken.sol";
import {ProposalTokenVesting} from "../../src/launchpad/ProposalTokenVesting.sol";
import {IEticaCore} from "../../src/launchpad/IEticaCore.sol";

import {MockEticaCore} from "./MockEticaCore.sol";

contract ProposalTokenFactoryTest is Test {
    address internal constant FEE_SETTER = address(0xFEE5E77E8);
    address internal constant TREASURY = address(0x7AEA54);
    address internal constant OWNER = address(0x0FFEC);
    address internal constant AUTHOR = address(0xA477407);
    address internal constant STRANGER = address(0x5747E);

    bytes32 internal constant PROPOSAL_HASH = keccak256("proposal-42");

    uint256 internal constant LAUNCH_FEE = 500 ether;
    uint256 internal constant MIN_LP = 100 ether;
    uint256 internal constant AUTHOR_ETX_BAL = 10_000 ether;

    ETXToken internal etx;
    EticaSwapFactory internal swapFactory;
    EticaSwapRouter internal router;
    WEGAZ internal wegaz;
    MockEticaCore internal core;
    ProposalTokenFactory internal launchpad;

    function setUp() public {
        // Mint ETX entirely to AUTHOR so they can pay fee + provide LP.
        etx = new ETXToken(AUTHOR);

        // Stand up a real swap factory + router so we can observe the
        // proposal-token/ETX pool created by the launchpad end-to-end.
        swapFactory = new EticaSwapFactory(FEE_SETTER);
        wegaz = new WEGAZ();
        router = new EticaSwapRouter(address(swapFactory), address(wegaz));

        core = new MockEticaCore();
        core.register(PROPOSAL_HASH, AUTHOR);

        launchpad = new ProposalTokenFactory(
            IEticaCore(address(core)),
            IERC20(address(etx)),
            IEticaSwapRouterLike(address(router)),
            TREASURY,
            LAUNCH_FEE,
            MIN_LP,
            OWNER
        );

        // Give AUTHOR some working ETX balance, topping up from what the
        // ETXToken constructor minted to them.
        assertGe(etx.balanceOf(AUTHOR), AUTHOR_ETX_BAL, "author ETX balance too low");
    }

    // -------------------------------------------------------------- helpers

    function _defaultParams() internal view returns (ProposalTokenFactory.LaunchParams memory) {
        return ProposalTokenFactory.LaunchParams({
            proposalHash: PROPOSAL_HASH,
            name: "Proposal 42 Funding",
            symbol: "P42F",
            totalSupply: 1_000_000 ether,
            lpEtxAmount: 1_000 ether,
            deadline: block.timestamp + 1 hours
        });
    }

    function _approveFactoryForLaunch(address who, uint256 lpEtxAmount) internal {
        vm.prank(who);
        etx.approve(address(launchpad), LAUNCH_FEE + lpEtxAmount);
    }

    // --------------------------------------------------------- constructor

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(ProposalTokenFactory.ZeroAddress.selector);
        new ProposalTokenFactory(
            IEticaCore(address(0)),
            IERC20(address(etx)),
            IEticaSwapRouterLike(address(router)),
            TREASURY,
            LAUNCH_FEE,
            MIN_LP,
            OWNER
        );

        vm.expectRevert(ProposalTokenFactory.ZeroAddress.selector);
        new ProposalTokenFactory(
            IEticaCore(address(core)),
            IERC20(address(0)),
            IEticaSwapRouterLike(address(router)),
            TREASURY,
            LAUNCH_FEE,
            MIN_LP,
            OWNER
        );

        vm.expectRevert(ProposalTokenFactory.ZeroAddress.selector);
        new ProposalTokenFactory(
            IEticaCore(address(core)),
            IERC20(address(etx)),
            IEticaSwapRouterLike(address(0)),
            TREASURY,
            LAUNCH_FEE,
            MIN_LP,
            OWNER
        );

        vm.expectRevert(ProposalTokenFactory.ZeroAddress.selector);
        new ProposalTokenFactory(
            IEticaCore(address(core)),
            IERC20(address(etx)),
            IEticaSwapRouterLike(address(router)),
            address(0),
            LAUNCH_FEE,
            MIN_LP,
            OWNER
        );
    }

    function test_constructor_storesConfig() public view {
        assertEq(address(launchpad.eticaCore()), address(core));
        assertEq(address(launchpad.etx()), address(etx));
        assertEq(address(launchpad.router()), address(router));
        assertEq(launchpad.treasury(), TREASURY);
        assertEq(launchpad.launchFeeEtx(), LAUNCH_FEE);
        assertEq(launchpad.minLpEtxAmount(), MIN_LP);
        assertEq(launchpad.owner(), OWNER);
    }

    // ----------------------------------------------------------------- admin

    function test_setTreasury_onlyOwner() public {
        vm.expectRevert();
        launchpad.setTreasury(AUTHOR);

        vm.prank(OWNER);
        launchpad.setTreasury(AUTHOR);
        assertEq(launchpad.treasury(), AUTHOR);
    }

    function test_setTreasury_rejectsZero() public {
        vm.prank(OWNER);
        vm.expectRevert(ProposalTokenFactory.ZeroAddress.selector);
        launchpad.setTreasury(address(0));
    }

    function test_setLaunchFee_onlyOwner() public {
        vm.expectRevert();
        launchpad.setLaunchFeeEtx(1234 ether);

        vm.prank(OWNER);
        launchpad.setLaunchFeeEtx(1234 ether);
        assertEq(launchpad.launchFeeEtx(), 1234 ether);
    }

    function test_setMinLp_onlyOwner() public {
        vm.expectRevert();
        launchpad.setMinLpEtxAmount(42 ether);

        vm.prank(OWNER);
        launchpad.setMinLpEtxAmount(42 ether);
        assertEq(launchpad.minLpEtxAmount(), 42 ether);
    }

    // -------------------------------------------------------------- gating

    function test_launch_revertsIfProposalUnknown() public {
        _approveFactoryForLaunch(AUTHOR, 1_000 ether);
        ProposalTokenFactory.LaunchParams memory p = _defaultParams();
        p.proposalHash = keccak256("does-not-exist");

        vm.prank(AUTHOR);
        vm.expectRevert(
            abi.encodeWithSelector(ProposalTokenFactory.ProposalUnknown.selector, p.proposalHash)
        );
        launchpad.launchProposalToken(p);
    }

    function test_launch_revertsIfCallerNotAuthor() public {
        _approveFactoryForLaunch(STRANGER, 1_000 ether);

        // Fund STRANGER with ETX so the failure is clearly the author check,
        // not a transferFrom insufficiency.
        vm.prank(AUTHOR);
        etx.transfer(STRANGER, 2_000 ether);

        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProposalTokenFactory.NotProposalAuthor.selector, STRANGER, AUTHOR
            )
        );
        launchpad.launchProposalToken(_defaultParams());
    }

    function test_launch_revertsIfLpEtxBelowMin() public {
        _approveFactoryForLaunch(AUTHOR, MIN_LP - 1);
        ProposalTokenFactory.LaunchParams memory p = _defaultParams();
        p.lpEtxAmount = MIN_LP - 1;

        vm.prank(AUTHOR);
        vm.expectRevert(
            abi.encodeWithSelector(ProposalTokenFactory.LpEtxTooLow.selector, MIN_LP - 1, MIN_LP)
        );
        launchpad.launchProposalToken(p);
    }

    function test_launch_revertsIfSupplyTooLow() public {
        _approveFactoryForLaunch(AUTHOR, 1_000 ether);
        ProposalTokenFactory.LaunchParams memory p = _defaultParams();
        p.totalSupply = 1_000;

        vm.prank(AUTHOR);
        vm.expectRevert(abi.encodeWithSelector(ProposalTokenFactory.SupplyTooLow.selector, 1_000));
        launchpad.launchProposalToken(p);
    }

    function test_launch_revertsOnSecondAttempt() public {
        _approveFactoryForLaunch(AUTHOR, 10_000 ether);
        vm.prank(AUTHOR);
        launchpad.launchProposalToken(_defaultParams());

        // Second launch for same proposal hash should fail.
        _approveFactoryForLaunch(AUTHOR, 1_000 ether);
        vm.prank(AUTHOR);
        vm.expectRevert(
            abi.encodeWithSelector(ProposalTokenFactory.AlreadyLaunched.selector, PROPOSAL_HASH)
        );
        launchpad.launchProposalToken(_defaultParams());
    }

    // ------------------------------------------------------------- happy path

    function test_launch_happyPath_fullDistribution() public {
        uint256 initialTreasuryBal = etx.balanceOf(TREASURY);
        uint256 initialAuthorEtx = etx.balanceOf(AUTHOR);

        _approveFactoryForLaunch(AUTHOR, 1_000 ether);

        vm.prank(AUTHOR);
        (address token, address vesting) = launchpad.launchProposalToken(_defaultParams());

        // --- mapping + addresses set ---
        assertEq(launchpad.proposalToToken(PROPOSAL_HASH), token, "token mapping");
        assertEq(launchpad.proposalToVesting(PROPOSAL_HASH), vesting, "vesting mapping");

        // --- fee routed to treasury, LP ETX pulled ---
        assertEq(etx.balanceOf(TREASURY), initialTreasuryBal + LAUNCH_FEE, "fee to treasury");
        assertEq(
            etx.balanceOf(AUTHOR), initialAuthorEtx - LAUNCH_FEE - 1_000 ether, "author ETX debited"
        );

        // --- supply split ---
        ProposalToken pt = ProposalToken(token);
        assertEq(pt.totalSupply(), 1_000_000 ether, "total supply");

        // 50% to LP pair, 25% liquid to author, 25% to vesting contract
        uint256 expectedLp = 500_000 ether;
        uint256 expectedVest = 250_000 ether;
        uint256 expectedLiquid = 250_000 ether;

        address pair = swapFactory.getPair(token, address(etx));
        assertTrue(pair != address(0), "pair exists");
        assertEq(pt.balanceOf(pair), expectedLp, "pair holds LP supply");
        assertEq(pt.balanceOf(AUTHOR), expectedLiquid, "author holds liquid 25%");
        assertEq(pt.balanceOf(vesting), expectedVest, "vesting holds 25%");

        // --- LP tokens owned by the author ---
        uint256 lpBal = IEticaSwapPair(pair).balanceOf(AUTHOR);
        assertGt(lpBal, 0, "author received LP tokens");

        // --- pool seeded with 1_000 ETX on the ETX side ---
        assertEq(etx.balanceOf(pair), 1_000 ether, "pair holds ETX LP");

        // --- factory holds no dangling funds ---
        assertEq(etx.balanceOf(address(launchpad)), 0, "factory ETX drained");
        assertEq(pt.balanceOf(address(launchpad)), 0, "factory token drained");

        // --- token metadata ---
        assertEq(pt.name(), "Proposal 42 Funding");
        assertEq(pt.symbol(), "P42F");
        assertEq(pt.proposalHash(), PROPOSAL_HASH);
        assertEq(pt.proposer(), AUTHOR);
    }

    function test_launch_emitsProposalTokenLaunched() public {
        _approveFactoryForLaunch(AUTHOR, 1_000 ether);
        vm.recordLogs();

        vm.prank(AUTHOR);
        launchpad.launchProposalToken(_defaultParams());

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256(
            "ProposalTokenLaunched(bytes32,address,address,address,uint256,uint256,uint256)"
        );
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == sig) {
                found = true;
                assertEq(logs[i].topics[1], PROPOSAL_HASH, "proposalHash topic");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), AUTHOR, "proposer topic");
                break;
            }
        }
        assertTrue(found, "event emitted");
    }

    // --------------------------------------------------------------- vesting

    function test_vesting_linearOver90Days() public {
        _approveFactoryForLaunch(AUTHOR, 1_000 ether);

        vm.prank(AUTHOR);
        (, address vesting) = launchpad.launchProposalToken(_defaultParams());

        ProposalTokenVesting v = ProposalTokenVesting(vesting);
        assertEq(v.beneficiary(), AUTHOR);
        assertEq(v.totalAmount(), 250_000 ether);
        assertEq(v.duration(), 90 days);
        assertEq(v.releasable(), 0, "nothing releasable at t=0");

        // 45 days in -> 50% vested.
        vm.warp(block.timestamp + 45 days);
        uint256 expected = 125_000 ether;
        assertApproxEqAbs(v.releasable(), expected, 1 ether, "50% vested at midpoint");

        vm.prank(AUTHOR);
        uint256 released = v.release();
        assertApproxEqAbs(released, expected, 1 ether, "release matches vested");

        // Fast forward past end -> 100% available.
        vm.warp(block.timestamp + 60 days);
        uint256 remaining = v.releasable();
        assertEq(released + remaining, 250_000 ether, "total vested matches");
        vm.prank(AUTHOR);
        v.release();
        assertEq(
            ProposalToken(launchpad.proposalToToken(PROPOSAL_HASH)).balanceOf(AUTHOR),
            250_000 ether + 250_000 ether, // liquid 25% + vested 25%
            "author got all vested tokens"
        );
    }

    // --------------------------------------------------- tradability via DEX

    function test_launchedToken_isTradableViaETXHub() public {
        _approveFactoryForLaunch(AUTHOR, 1_000 ether);
        vm.prank(AUTHOR);
        (address token,) = launchpad.launchProposalToken(_defaultParams());

        // STRANGER shows up with 10 ETX and wants to buy the new token.
        vm.prank(AUTHOR);
        etx.transfer(STRANGER, 10 ether);

        vm.startPrank(STRANGER);
        etx.approve(address(router), 10 ether);
        address[] memory path = new address[](2);
        path[0] = address(etx);
        path[1] = token;
        uint256[] memory out =
            router.swapExactTokensForTokens(10 ether, 0, path, STRANGER, block.timestamp + 1 hours);
        vm.stopPrank();

        assertGt(out[out.length - 1], 0, "got some proposal tokens");
        assertEq(ProposalToken(token).balanceOf(STRANGER), out[out.length - 1], "balance matches");
    }
}
