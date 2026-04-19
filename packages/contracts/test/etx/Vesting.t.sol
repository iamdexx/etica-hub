// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ETXToken} from "../../src/etx/ETXToken.sol";
import {EticaHubVesting} from "../../src/etx/EticaHubVesting.sol";

contract VestingTest is Test {
    ETXToken internal etx;
    EticaHubVesting internal vesting;

    address internal constant BENEFICIARY = address(0xBEEF);

    uint64 internal constant FOUR_YEARS = 4 * 365 days;
    uint64 internal constant SIX_MONTHS = 182 days;

    function setUp() public {
        etx = new ETXToken(address(this));
        vesting = new EticaHubVesting(BENEFICIARY, uint64(block.timestamp), FOUR_YEARS, SIX_MONTHS);
        etx.transfer(address(vesting), 20_000_000 * 1e18);
    }

    function test_beforeCliff_releasesNothing() public {
        vm.warp(block.timestamp + SIX_MONTHS - 1);
        assertEq(vesting.releasable(address(etx)), 0);
    }

    function test_atCliff_releasesCliffAmount() public {
        // 6 months / 48 months = 12.5% of 20M = 2.5M
        vm.warp(block.timestamp + SIX_MONTHS);
        uint256 released = vesting.releasable(address(etx));
        uint256 expected = (uint256(20_000_000 ether) * uint256(SIX_MONTHS)) / uint256(FOUR_YEARS);
        assertApproxEqAbs(released, expected, 1e18);
    }

    function test_halfway_releasesHalf() public {
        vm.warp(block.timestamp + FOUR_YEARS / 2);
        uint256 released = vesting.releasable(address(etx));
        assertApproxEqAbs(released, 10_000_000 * 1e18, 1e18);
    }

    function test_afterEnd_releasesAll() public {
        vm.warp(block.timestamp + FOUR_YEARS + 1);
        vesting.release(address(etx));
        assertEq(etx.balanceOf(BENEFICIARY), 20_000_000 * 1e18);
    }

    function test_nonBeneficiaryCanCallRelease_butFundsGoToBeneficiary() public {
        vm.warp(block.timestamp + FOUR_YEARS + 1);
        vm.prank(address(0xBAD));
        vesting.release(address(etx));
        assertEq(etx.balanceOf(BENEFICIARY), 20_000_000 * 1e18);
    }
}
