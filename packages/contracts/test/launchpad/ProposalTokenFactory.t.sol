// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

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

/// @dev Minimal fixed-supply ERC-20 used to stand in for mainnet ETI in
///      unit tests. Not part of the deployed system; lives only here.
contract MockETI is ERC20 {
    constructor(address holder, uint256 supply) ERC20("Mock ETI", "METI") {
        _mint(holder, supply);
    }
}

contract ProposalTokenFactoryTest is Test {
    address internal constant FEE_SETTER = address(0xFEE5E77E8);
    address internal constant TREASURY = address(0x7AEA54);
    address internal constant OWNER = address(0x0FFEC);
    address internal constant AUTHOR = address(0xA477407);
    address internal constant STRANGER = address(0x5747E);

    bytes32 internal constant PROPOSAL_HASH = keccak256("proposal-42");

    uint256 internal constant LAUNCH_FEE_ETX = 250 ether;
    uint256 internal constant LAUNCH_FEE_ETI = 250 ether;
    uint256 internal constant MIN_LP_ETX = 100 ether;
    uint256 internal constant MIN_LP_ETI = 50 ether;
    uint256 internal constant AUTHOR_ETX_BAL = 10_000 ether;
    uint256 internal constant AUTHOR_ETI_BAL = 10_000 ether;

    ETXToken internal etx;
    MockETI internal eti;
    EticaSwapFactory internal swapFactory;
    EticaSwapRouter internal router;
    WEGAZ internal wegaz;
    MockEticaCore internal core;
    ProposalTokenFactory internal launchpad;

    function setUp() public {
        // Mint ETX + ETI entirely to AUTHOR so they can pay fees + LP.
        etx = new ETXToken(AUTHOR);
        eti = new MockETI(AUTHOR, AUTHOR_ETI_BAL);

        // Real swap factory + router so we can observe the two pools
        // (token/ETX + token/ETI) opened by the launchpad end-to-end. The
        // factory enforces ETX-only pairing for everyone except addresses in
        // `trustedCreators`, so the launchpad must be whitelisted after
        // deploy for its token/ETI pool to be allowed.
        swapFactory = new EticaSwapFactory(FEE_SETTER, address(etx));
        wegaz = new WEGAZ();
        router = new EticaSwapRouter(address(swapFactory), address(wegaz));

        core = new MockEticaCore();
        core.register(PROPOSAL_HASH, AUTHOR);

        launchpad = new ProposalTokenFactory(_constructorArgs(TREASURY, OWNER));

        vm.prank(FEE_SETTER);
        swapFactory.setTrustedCreator(address(launchpad), true);

        assertGe(etx.balanceOf(AUTHOR), AUTHOR_ETX_BAL, "author ETX balance too low");
        assertGe(eti.balanceOf(AUTHOR), AUTHOR_ETI_BAL, "author ETI balance too low");
    }

    // -------------------------------------------------------------- helpers

    function _constructorArgs(address treasury_, address owner_)
        internal
        view
        returns (ProposalTokenFactory.ConstructorArgs memory)
    {
        return ProposalTokenFactory.ConstructorArgs({
            eticaCore: IEticaCore(address(core)),
            etx: IERC20(address(etx)),
            eti: IERC20(address(eti)),
            router: IEticaSwapRouterLike(address(router)),
            treasury: treasury_,
            launchFeeEtx: LAUNCH_FEE_ETX,
            launchFeeEti: LAUNCH_FEE_ETI,
            minLpEtxAmount: MIN_LP_ETX,
            minLpEtiAmount: MIN_LP_ETI,
            owner: owner_
        });
    }

    function _defaultParams() internal view returns (ProposalTokenFactory.LaunchParams memory) {
        return ProposalTokenFactory.LaunchParams({
            proposalHash: PROPOSAL_HASH,
            name: "Proposal 42 Funding",
            symbol: "P42F",
            totalSupply: 1_000_000 ether,
            lpEtxAmount: 1_000 ether,
            lpEtiAmount: 500 ether,
            deadline: block.timestamp + 1 hours
        });
    }

    function _approveFactoryForLaunch(address who, uint256 lpEtxAmount, uint256 lpEtiAmount)
        internal
    {
        vm.startPrank(who);
        etx.approve(address(launchpad), LAUNCH_FEE_ETX + lpEtxAmount);
        eti.approve(address(launchpad), LAUNCH_FEE_ETI + lpEtiAmount);
        vm.stopPrank();
    }

    // --------------------------------------------------------- constructor

    function test_constructor_rejectsZeroAddresses() public {
        ProposalTokenFactory.ConstructorArgs memory a = _constructorArgs(TREASURY, OWNER);

        a.eticaCore = IEticaCore(address(0));
        vm.expectRevert(ProposalTokenFactory.ZeroAddress.selector);
        new ProposalTokenFactory(a);

        a = _constructorArgs(TREASURY, OWNER);
        a.etx = IERC20(address(0));
        vm.expectRevert(ProposalTokenFactory.ZeroAddress.selector);
        new ProposalTokenFactory(a);

        a = _constructorArgs(TREASURY, OWNER);
        a.eti = IERC20(address(0));
        vm.expectRevert(ProposalTokenFactory.ZeroAddress.selector);
        new ProposalTokenFactory(a);

        a = _constructorArgs(TREASURY, OWNER);
        a.router = IEticaSwapRouterLike(address(0));
        vm.expectRevert(ProposalTokenFactory.ZeroAddress.selector);
        new ProposalTokenFactory(a);

        a = _constructorArgs(address(0), OWNER);
        vm.expectRevert(ProposalTokenFactory.ZeroAddress.selector);
        new ProposalTokenFactory(a);
    }

    function test_constructor_storesConfig() public view {
        assertEq(address(launchpad.eticaCore()), address(core));
        assertEq(address(launchpad.etx()), address(etx));
        assertEq(address(launchpad.eti()), address(eti));
        assertEq(address(launchpad.router()), address(router));
        assertEq(launchpad.treasury(), TREASURY);
        assertEq(launchpad.launchFeeEtx(), LAUNCH_FEE_ETX);
        assertEq(launchpad.launchFeeEti(), LAUNCH_FEE_ETI);
        assertEq(launchpad.minLpEtxAmount(), MIN_LP_ETX);
        assertEq(launchpad.minLpEtiAmount(), MIN_LP_ETI);
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

    function test_setLaunchFeeEtx_onlyOwner() public {
        vm.expectRevert();
        launchpad.setLaunchFeeEtx(1234 ether);

        vm.prank(OWNER);
        launchpad.setLaunchFeeEtx(1234 ether);
        assertEq(launchpad.launchFeeEtx(), 1234 ether);
    }

    function test_setLaunchFeeEti_onlyOwner() public {
        vm.expectRevert();
        launchpad.setLaunchFeeEti(1234 ether);

        vm.prank(OWNER);
        launchpad.setLaunchFeeEti(1234 ether);
        assertEq(launchpad.launchFeeEti(), 1234 ether);
    }

    function test_setMinLpEtx_onlyOwner() public {
        vm.expectRevert();
        launchpad.setMinLpEtxAmount(42 ether);

        vm.prank(OWNER);
        launchpad.setMinLpEtxAmount(42 ether);
        assertEq(launchpad.minLpEtxAmount(), 42 ether);
    }

    function test_setMinLpEti_onlyOwner() public {
        vm.expectRevert();
        launchpad.setMinLpEtiAmount(42 ether);

        vm.prank(OWNER);
        launchpad.setMinLpEtiAmount(42 ether);
        assertEq(launchpad.minLpEtiAmount(), 42 ether);
    }

    // -------------------------------------------------------------- gating

    function test_launch_revertsIfProposalUnknown() public {
        _approveFactoryForLaunch(AUTHOR, 1_000 ether, 500 ether);
        ProposalTokenFactory.LaunchParams memory p = _defaultParams();
        p.proposalHash = keccak256("does-not-exist");

        vm.prank(AUTHOR);
        vm.expectRevert(
            abi.encodeWithSelector(ProposalTokenFactory.ProposalUnknown.selector, p.proposalHash)
        );
        launchpad.launchProposalToken(p);
    }

    function test_launch_revertsIfCallerNotAuthor() public {
        // Fund STRANGER with enough of both tokens so the failure is clearly
        // the author check, not a transferFrom insufficiency.
        vm.prank(AUTHOR);
        etx.transfer(STRANGER, 2_000 ether);
        vm.prank(AUTHOR);
        eti.transfer(STRANGER, 2_000 ether);

        _approveFactoryForLaunch(STRANGER, 1_000 ether, 500 ether);

        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProposalTokenFactory.NotProposalAuthor.selector, STRANGER, AUTHOR
            )
        );
        launchpad.launchProposalToken(_defaultParams());
    }

    function test_launch_revertsIfLpEtxBelowMin() public {
        _approveFactoryForLaunch(AUTHOR, MIN_LP_ETX - 1, 500 ether);
        ProposalTokenFactory.LaunchParams memory p = _defaultParams();
        p.lpEtxAmount = MIN_LP_ETX - 1;

        vm.prank(AUTHOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProposalTokenFactory.LpEtxTooLow.selector, MIN_LP_ETX - 1, MIN_LP_ETX
            )
        );
        launchpad.launchProposalToken(p);
    }

    function test_launch_revertsIfLpEtiBelowMin() public {
        _approveFactoryForLaunch(AUTHOR, 1_000 ether, MIN_LP_ETI - 1);
        ProposalTokenFactory.LaunchParams memory p = _defaultParams();
        p.lpEtiAmount = MIN_LP_ETI - 1;

        vm.prank(AUTHOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProposalTokenFactory.LpEtiTooLow.selector, MIN_LP_ETI - 1, MIN_LP_ETI
            )
        );
        launchpad.launchProposalToken(p);
    }

    function test_launch_revertsIfSupplyTooLow() public {
        _approveFactoryForLaunch(AUTHOR, 1_000 ether, 500 ether);
        ProposalTokenFactory.LaunchParams memory p = _defaultParams();
        p.totalSupply = 1_000;

        vm.prank(AUTHOR);
        vm.expectRevert(abi.encodeWithSelector(ProposalTokenFactory.SupplyTooLow.selector, 1_000));
        launchpad.launchProposalToken(p);
    }

    function test_launch_revertsOnSecondAttempt() public {
        _approveFactoryForLaunch(AUTHOR, 10_000 ether, 5_000 ether);
        vm.prank(AUTHOR);
        launchpad.launchProposalToken(_defaultParams());

        // Second launch for same proposal hash should fail.
        _approveFactoryForLaunch(AUTHOR, 1_000 ether, 500 ether);
        vm.prank(AUTHOR);
        vm.expectRevert(
            abi.encodeWithSelector(ProposalTokenFactory.AlreadyLaunched.selector, PROPOSAL_HASH)
        );
        launchpad.launchProposalToken(_defaultParams());
    }

    // ------------------------------------------------------------- happy path

    function test_launch_happyPath_fullDistribution() public {
        uint256 initialTreasuryEtx = etx.balanceOf(TREASURY);
        uint256 initialTreasuryEti = eti.balanceOf(TREASURY);
        uint256 initialAuthorEtx = etx.balanceOf(AUTHOR);
        uint256 initialAuthorEti = eti.balanceOf(AUTHOR);

        _approveFactoryForLaunch(AUTHOR, 1_000 ether, 500 ether);

        vm.prank(AUTHOR);
        (address token, address vesting) = launchpad.launchProposalToken(_defaultParams());

        // Mapping + addresses set.
        assertEq(launchpad.proposalToToken(PROPOSAL_HASH), token, "token mapping");
        assertEq(launchpad.proposalToVesting(PROPOSAL_HASH), vesting, "vesting mapping");

        // Fees routed to treasury, LP amounts pulled.
        assertEq(
            etx.balanceOf(TREASURY), initialTreasuryEtx + LAUNCH_FEE_ETX, "ETX fee to treasury"
        );
        assertEq(
            eti.balanceOf(TREASURY), initialTreasuryEti + LAUNCH_FEE_ETI, "ETI fee to treasury"
        );
        assertEq(
            etx.balanceOf(AUTHOR),
            initialAuthorEtx - LAUNCH_FEE_ETX - 1_000 ether,
            "author ETX debited"
        );
        assertEq(
            eti.balanceOf(AUTHOR),
            initialAuthorEti - LAUNCH_FEE_ETI - 500 ether,
            "author ETI debited"
        );

        // Supply split — 25% / 25% / 25% / 25%.
        ProposalToken pt = ProposalToken(token);
        assertEq(pt.totalSupply(), 1_000_000 ether, "total supply");

        uint256 expectedLpEtx = 250_000 ether;
        uint256 expectedLpEti = 250_000 ether;
        uint256 expectedVest = 250_000 ether;
        uint256 expectedLiquid = 250_000 ether;

        address pairEtx = swapFactory.getPair(token, address(etx));
        address pairEti = swapFactory.getPair(token, address(eti));
        assertTrue(pairEtx != address(0), "ETX pair exists");
        assertTrue(pairEti != address(0), "ETI pair exists");
        assertEq(pt.balanceOf(pairEtx), expectedLpEtx, "ETX pair holds 25%");
        assertEq(pt.balanceOf(pairEti), expectedLpEti, "ETI pair holds 25%");
        assertEq(pt.balanceOf(AUTHOR), expectedLiquid, "author holds liquid 25%");
        assertEq(pt.balanceOf(vesting), expectedVest, "vesting holds 25%");

        // LP tokens owned by the author on both pools.
        assertGt(IEticaSwapPair(pairEtx).balanceOf(AUTHOR), 0, "author received ETX LP");
        assertGt(IEticaSwapPair(pairEti).balanceOf(AUTHOR), 0, "author received ETI LP");

        // Each pool seeded with the author's contribution on the hub side.
        assertEq(etx.balanceOf(pairEtx), 1_000 ether, "ETX pair holds 1_000 ETX");
        assertEq(eti.balanceOf(pairEti), 500 ether, "ETI pair holds 500 ETI");

        // Factory holds no dangling funds.
        assertEq(etx.balanceOf(address(launchpad)), 0, "factory ETX drained");
        assertEq(eti.balanceOf(address(launchpad)), 0, "factory ETI drained");
        assertEq(pt.balanceOf(address(launchpad)), 0, "factory token drained");

        // Token metadata.
        assertEq(pt.name(), "Proposal 42 Funding");
        assertEq(pt.symbol(), "P42F");
        assertEq(pt.proposalHash(), PROPOSAL_HASH);
        assertEq(pt.proposer(), AUTHOR);
    }

    function test_launch_emitsProposalTokenLaunched() public {
        _approveFactoryForLaunch(AUTHOR, 1_000 ether, 500 ether);
        vm.recordLogs();

        vm.prank(AUTHOR);
        launchpad.launchProposalToken(_defaultParams());

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256(
            "ProposalTokenLaunched(bytes32,address,address,address,uint256,uint256,uint256,uint256,uint256)"
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
        _approveFactoryForLaunch(AUTHOR, 1_000 ether, 500 ether);

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
        _approveFactoryForLaunch(AUTHOR, 1_000 ether, 500 ether);
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

    function test_launchedToken_isTradableViaETIHub() public {
        _approveFactoryForLaunch(AUTHOR, 1_000 ether, 500 ether);
        vm.prank(AUTHOR);
        (address token,) = launchpad.launchProposalToken(_defaultParams());

        // STRANGER shows up with 5 ETI and wants to buy the new token.
        vm.prank(AUTHOR);
        eti.transfer(STRANGER, 5 ether);

        vm.startPrank(STRANGER);
        eti.approve(address(router), 5 ether);
        address[] memory path = new address[](2);
        path[0] = address(eti);
        path[1] = token;
        uint256[] memory out =
            router.swapExactTokensForTokens(5 ether, 0, path, STRANGER, block.timestamp + 1 hours);
        vm.stopPrank();

        assertGt(out[out.length - 1], 0, "got some proposal tokens via ETI hub");
    }
}
