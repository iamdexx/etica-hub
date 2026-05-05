// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {HeartbeatISM, IBridgeMinterHeartbeatView} from "../../src/bridge/HeartbeatISM.sol";

contract MinterStub is IBridgeMinterHeartbeatView {
    uint64 public override lastHeartbeatAt;
    uint64 public override heartbeatTimeoutSeconds;

    function setHeartbeat(uint64 last, uint64 timeout) external {
        lastHeartbeatAt = last;
        heartbeatTimeoutSeconds = timeout;
    }
}

    contract HeartbeatISMTest is Test {
        HeartbeatISM internal ism;
        MinterStub internal minter;

        function setUp() public {
            minter = new MinterStub();
            ism = new HeartbeatISM(IBridgeMinterHeartbeatView(address(minter)));

            // Pin block.timestamp away from zero so freshness math reads naturally.
            vm.warp(1_700_000_000);
        }

        /* -------------------------------------------------------------------- */
        /*                            CONSTRUCTOR                               */
        /* -------------------------------------------------------------------- */

        function test_constructor_setsImmutables() public view {
            assertEq(address(ism.minter()), address(minter));
        }

        function test_constructor_revertsOnZero() public {
            vm.expectRevert(HeartbeatISM.HeartbeatISM_ZeroAddress.selector);
            new HeartbeatISM(IBridgeMinterHeartbeatView(address(0)));
        }

        function test_moduleType_returnsNull() public view {
            assertEq(ism.moduleType(), 6);
        }

        /* -------------------------------------------------------------------- */
        /*                              FRESHNESS                               */
        /* -------------------------------------------------------------------- */

        function test_isFresh_falseOnNeverHeartbeated() public view {
            assertFalse(ism.isFresh());
        }

        function test_isFresh_trueWhenWithinTimeout() public {
            minter.setHeartbeat(uint64(block.timestamp - 1 hours), 4 hours);
            assertTrue(ism.isFresh());
        }

        function test_isFresh_trueAtExactTimeoutBoundary() public {
            // Exactly equal: last + timeout == now → still fresh.
            minter.setHeartbeat(uint64(block.timestamp - 4 hours), 4 hours);
            assertTrue(ism.isFresh());
        }

        function test_isFresh_falseWhenStaleByOneSecond() public {
            minter.setHeartbeat(uint64(block.timestamp - 4 hours - 1), 4 hours);
            assertFalse(ism.isFresh());
        }

        function test_verify_reflectsFreshness_pass() public {
            minter.setHeartbeat(uint64(block.timestamp), 4 hours);
            assertTrue(ism.verify("", ""));
        }

        function test_verify_reflectsFreshness_fail() public {
            minter.setHeartbeat(uint64(block.timestamp - 5 hours), 4 hours);
            assertFalse(ism.verify("", ""));
        }

        function test_verify_neverHeartbeatedRejects() public view {
            // Default state: lastHeartbeatAt == 0 → always rejects, even with a
            // huge timeout, so a freshly deployed bridge cannot be exploited
            // before the operator's bot wires up the first heartbeat.
            assertFalse(ism.verify("", ""));
        }

        function testFuzz_freshnessBoundary(uint64 timeout, uint64 ageSeconds) public {
            // Bound to plausible operational ranges to avoid overflow noise.
            timeout = uint64(bound(timeout, 1 minutes, 30 days));
            ageSeconds = uint64(bound(ageSeconds, 0, 60 days));

            uint64 last = uint64(block.timestamp) - ageSeconds;
            minter.setHeartbeat(last, timeout);

            if (ageSeconds <= timeout) {
                assertTrue(ism.isFresh());
            } else {
                assertFalse(ism.isFresh());
            }
        }
    }
