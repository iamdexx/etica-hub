// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TVLCapISM, IBridgeMinterTvlView, IERC20Supply} from "../../src/bridge/TVLCapISM.sol";
import {BridgeMessage} from "../../src/bridge/IBridgeMinter.sol";

contract WetxStub is IERC20Supply {
    uint256 public override totalSupply;

    function setSupply(uint256 s) external {
        totalSupply = s;
    }
}

    contract MinterStub is IBridgeMinterTvlView {
        uint128 public override tvlCapEtx;
        address public override wetx;

        constructor(address wetx_) {
            wetx = wetx_;
        }

        function setCap(uint128 cap) external {
            tvlCapEtx = cap;
        }
    }

        contract TVLCapISMTest is Test {
            TVLCapISM internal ism;
            MinterStub internal minter;
            WetxStub internal wetx;

            function setUp() public {
                wetx = new WetxStub();
                minter = new MinterStub(address(wetx));
                ism = new TVLCapISM(IBridgeMinterTvlView(address(minter)));
            }

            /* -------------------------------------------------------------------- */
            /*                                HELPERS                               */
            /* -------------------------------------------------------------------- */

            function _msg(uint128 amount) internal view returns (bytes memory) {
                BridgeMessage memory m = BridgeMessage({
                    nonce: bytes32(uint256(0xABCD)),
                    srcDomain: 61803,
                    destDomain: 1,
                    sender: address(0xCAFE),
                    recipient: address(0xBEEF),
                    amount: amount,
                    srcBlockNumber: 12345,
                    timestamp: uint64(block.timestamp)
                });
                bytes memory header = new bytes(77);
                return bytes.concat(header, abi.encode(m));
            }

            /* -------------------------------------------------------------------- */
            /*                            CONSTRUCTOR                               */
            /* -------------------------------------------------------------------- */

            function test_constructor_setsImmutables() public view {
                assertEq(address(ism.minter()), address(minter));
            }

            function test_constructor_revertsOnZero() public {
                vm.expectRevert(TVLCapISM.TVLCapISM_ZeroAddress.selector);
                new TVLCapISM(IBridgeMinterTvlView(address(0)));
            }

            function test_moduleType_returnsNull() public view {
                assertEq(ism.moduleType(), 6);
            }

            /* -------------------------------------------------------------------- */
            /*                                wouldFit                              */
            /* -------------------------------------------------------------------- */

            function test_wouldFit_true_underCap() public {
                minter.setCap(1_000 ether);
                wetx.setSupply(900 ether);
                assertTrue(ism.wouldFit(50 ether));
            }

            function test_wouldFit_true_exactlyAtCap() public {
                minter.setCap(1_000 ether);
                wetx.setSupply(900 ether);
                assertTrue(ism.wouldFit(100 ether));
            }

            function test_wouldFit_false_overCap() public {
                minter.setCap(1_000 ether);
                wetx.setSupply(900 ether);
                assertFalse(ism.wouldFit(101 ether));
            }

            function test_wouldFit_false_capZero() public {
                minter.setCap(0);
                wetx.setSupply(0);
                assertFalse(ism.wouldFit(1));
            }

            function test_wouldFit_true_zeroAmountAtCap() public {
                // Edge case: a zero-amount message slips in at supply == cap.
                // We treat zero as "always fits" to preserve handler-side semantics.
                minter.setCap(1_000 ether);
                wetx.setSupply(1_000 ether);
                assertTrue(ism.wouldFit(0));
            }

            /* -------------------------------------------------------------------- */
            /*                                verify                                */
            /* -------------------------------------------------------------------- */

            function test_verify_passes_underCap() public {
                minter.setCap(1_000 ether);
                wetx.setSupply(500 ether);
                assertTrue(ism.verify("", _msg(100 ether)));
            }

            function test_verify_rejects_overCap() public {
                minter.setCap(1_000 ether);
                wetx.setSupply(950 ether);
                assertFalse(ism.verify("", _msg(60 ether)));
            }

            function test_verify_rejects_messageTooShort() public {
                minter.setCap(type(uint128).max);
                bytes memory short = new bytes(76);
                assertFalse(ism.verify("", short));
            }

            function test_verify_rejects_bodyWrongLength() public {
                minter.setCap(type(uint128).max);
                // 77 bytes of header + 64 bytes of garbage body (not a BridgeMessage)
                bytes memory header = new bytes(77);
                bytes memory body = new bytes(64);
                assertFalse(ism.verify("", bytes.concat(header, body)));
            }

            function test_verify_acceptsAtSupplyZero() public {
                minter.setCap(uint128(1_000_000 ether));
                // No wETX outstanding yet — first inbound after deploy.
                assertTrue(ism.verify("", _msg(uint128(1_000 ether))));
            }
        }
