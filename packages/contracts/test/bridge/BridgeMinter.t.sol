// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BridgeMinter, IMailbox} from "../../src/bridge/BridgeMinter.sol";
import {WrappedETX} from "../../src/bridge/WrappedETX.sol";
import {BridgeMessage, IBridgeMinter, VetoReason} from "../../src/bridge/IBridgeMinter.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Mailbox stub. Records the latest dispatch and lets tests inject
///         inbound `handle` calls back into the minter under the mailbox role.
contract MockMailbox {
    BridgeMinter public minter;
    uint32 public lastDestDomain;
    bytes32 public lastRecipient;
    bytes public lastBody;
    uint256 public lastValue;
    uint256 public dispatchCount;

    function setMinter(BridgeMinter _minter) external {
        minter = _minter;
    }

    function dispatch(uint32 destDomain, bytes32 recipient, bytes calldata body)
        external
        payable
        returns (bytes32)
    {
        lastDestDomain = destDomain;
        lastRecipient = recipient;
        lastBody = body;
        lastValue = msg.value;
        dispatchCount += 1;
        return keccak256(body);
    }

    function deliverInboundDeposit(uint32 origin, bytes32 sender, bytes calldata body) external {
        minter.handle(origin, sender, body);
    }
}

/// @notice Recipient that rejects native gas — used to exercise refund-failure
/// reverts on bond return + slash distribution.
contract RejectingRecipient {
    receive() external payable {
        revert("nope");
    }
}

contract BridgeMinterTest is Test {
    BridgeMinter internal minter;
    WrappedETX internal wetx;
    MockMailbox internal mailbox;

    address internal constant OWNER = address(0x0117E2);
    address internal constant USER = address(0xCAFE);
    address internal constant RECIPIENT = address(0xE71CA);
    address internal constant SUBMITTER = address(0xBA9D);
    address internal constant VETO_AUTH = address(0xBEEF);
    address internal constant FRAUD_AUTH = address(0xFEED);
    address internal constant TREASURY = address(0x77E45);
    address internal constant MANUAL_REWARD = address(0xB07);
    address internal constant INSURANCE_SWEEP = address(0x115);
    address internal constant PROVER = address(0x9009);
    address internal constant ATTACKER = address(0xBAD);

    uint32 internal constant SELF_DOMAIN = 1; // Eth
    uint32 internal constant ETICA_DOMAIN = 61803;
    uint32 internal constant BNB_DOMAIN = 56;

    uint64 internal constant OP_TIMELOCK = 24 hours;
    uint64 internal constant CHALLENGE = 48 hours;
    uint16 internal constant BOND_BPS = 2_500; // 25%
    uint16 internal constant FEE_BPS = 10; // 0.1%
    uint128 internal constant TVL_CAP = 1_000_000 ether; // 1M ETX
    uint128 internal constant DAILY_BPS = 500; // 5%
    uint128 internal constant PER_CLAIM_BPS = 100; // 1%

    bytes32 internal constant TRUSTED_VAULT_ETICA = bytes32(uint256(uint160(0xABCD1234)));
    bytes32 internal constant TRUSTED_VAULT_BNB = bytes32(uint256(uint160(0xABCD5678)));

    uint256 internal constant ONE = 1e18;

    function setUp() public {
        mailbox = new MockMailbox();
        minter = new BridgeMinter(
            OWNER,
            address(mailbox),
            SELF_DOMAIN,
            OP_TIMELOCK,
            TVL_CAP,
            BOND_BPS,
            FEE_BPS,
            CHALLENGE,
            DAILY_BPS,
            PER_CLAIM_BPS
        );
        mailbox.setMinter(minter);
        wetx = minter.wetx();

        _wireLaunchDefaults();
    }

    /* ----------------------------- helpers ------------------------------ */

    function _wireLaunchDefaults() internal {
        uint256[] memory ids = new uint256[](7);
        vm.startPrank(OWNER);
        ids[0] = minter.requestSetVetoAuthority(VETO_AUTH);
        ids[1] = minter.requestSetFraudProverAuthority(FRAUD_AUTH);
        ids[2] = minter.requestSetTreasuryRecipient(TREASURY);
        ids[3] = minter.requestSetManualVetoerRewardRecipient(MANUAL_REWARD);
        ids[4] = minter.requestSetInsuranceSweepRecipient(INSURANCE_SWEEP);
        ids[5] = minter.requestSetTrustedVault(ETICA_DOMAIN, TRUSTED_VAULT_ETICA);
        ids[6] = minter.requestSetAllowedDestDomain(ETICA_DOMAIN, true);
        vm.stopPrank();

        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.startPrank(OWNER);
        for (uint256 i = 0; i < ids.length; i++) {
            minter.executeOp(ids[i]);
        }
        vm.stopPrank();
    }

    function _msg(bytes32 nonce, address recipient, uint128 amount)
        internal
        view
        returns (BridgeMessage memory)
    {
        return BridgeMessage({
            nonce: nonce,
            srcDomain: ETICA_DOMAIN,
            destDomain: SELF_DOMAIN,
            sender: USER,
            recipient: recipient,
            amount: amount,
            srcBlockNumber: uint64(block.number),
            timestamp: uint64(block.timestamp)
        });
    }

    function _record(bytes32 nonce, address recipient, uint128 amount) internal {
        BridgeMessage memory m = _msg(nonce, recipient, amount);
        mailbox.deliverInboundDeposit(ETICA_DOMAIN, TRUSTED_VAULT_ETICA, abi.encode(m));
    }

    function _submit(bytes32 nonce, address submitter, uint128 amount) internal returns (uint128) {
        uint128 bond = minter.bondRequiredFor(amount);
        vm.deal(submitter, bond);
        vm.prank(submitter);
        return minter.submitClaim{value: bond}(nonce);
    }

    /* -------------------------------------------------------------------- */
    /*                            CONSTRUCTOR                               */
    /* -------------------------------------------------------------------- */

    function test_constructor_setsImmutablesAndInitialState() public view {
        assertEq(address(minter.hyperlaneMailbox()), address(mailbox));
        assertEq(uint256(minter.selfDomain()), uint256(SELF_DOMAIN));
        assertEq(uint256(minter.opTimelock()), uint256(OP_TIMELOCK));
        assertEq(uint256(minter.tvlCapEtx()), uint256(TVL_CAP));
        assertEq(uint256(minter.bondBps()), uint256(BOND_BPS));
        assertEq(uint256(minter.bridgeFeeBps()), uint256(FEE_BPS));
        assertEq(uint256(minter.challengeWindowSeconds()), uint256(CHALLENGE));
        assertEq(uint256(minter.dailyMintCapBps()), uint256(DAILY_BPS));
        assertEq(uint256(minter.perClaimCapBps()), uint256(PER_CLAIM_BPS));
        assertEq(minter.owner(), OWNER);
        assertEq(minter.paused(), false);
        // currentDayUtc was captured in the constructor at the original
        // block.timestamp; setUp's vm.warp may have rolled the day index since.
        assertLe(uint256(minter.currentDayUtc()), block.timestamp / 86_400);
    }

    function test_constructor_deploysWrappedETXAndOwnsMint() public view {
        assertEq(address(wetx.bridgeMinter()), address(minter));
        assertEq(wetx.totalSupply(), 0);
        assertEq(wetx.symbol(), "wETX");
    }

    function test_constructor_zeroMailboxReverts() public {
        vm.expectRevert(BridgeMinter.BridgeMinter_ZeroAddress.selector);
        new BridgeMinter(
            OWNER,
            address(0),
            SELF_DOMAIN,
            OP_TIMELOCK,
            TVL_CAP,
            BOND_BPS,
            FEE_BPS,
            CHALLENGE,
            DAILY_BPS,
            PER_CLAIM_BPS
        );
    }

    function test_constructor_zeroSelfDomainReverts() public {
        vm.expectRevert(BridgeMinter.BridgeMinter_ZeroAmount.selector);
        new BridgeMinter(
            OWNER,
            address(mailbox),
            0,
            OP_TIMELOCK,
            TVL_CAP,
            BOND_BPS,
            FEE_BPS,
            CHALLENGE,
            DAILY_BPS,
            PER_CLAIM_BPS
        );
    }

    function test_constructor_bondOutOfRangeReverts() public {
        vm.expectRevert();
        new BridgeMinter(
            OWNER,
            address(mailbox),
            SELF_DOMAIN,
            OP_TIMELOCK,
            TVL_CAP,
            7_000, // > MAX_BOND_BPS (5_000)
            FEE_BPS,
            CHALLENGE,
            DAILY_BPS,
            PER_CLAIM_BPS
        );
    }

    function test_constructor_feeAboveCapReverts() public {
        vm.expectRevert();
        new BridgeMinter(
            OWNER,
            address(mailbox),
            SELF_DOMAIN,
            OP_TIMELOCK,
            TVL_CAP,
            BOND_BPS,
            500, // > MAX_BRIDGE_FEE_BPS (100)
            CHALLENGE,
            DAILY_BPS,
            PER_CLAIM_BPS
        );
    }

    function test_constructor_challengeWindowOutOfRangeReverts() public {
        vm.expectRevert();
        new BridgeMinter(
            OWNER,
            address(mailbox),
            SELF_DOMAIN,
            OP_TIMELOCK,
            TVL_CAP,
            BOND_BPS,
            FEE_BPS,
            30 minutes, // < MIN_CHALLENGE_WINDOW (1 hour)
            DAILY_BPS,
            PER_CLAIM_BPS
        );
    }

    /* -------------------------------------------------------------------- */
    /*                              HANDLE                                  */
    /* -------------------------------------------------------------------- */

    function test_handle_recordsDeposit() public {
        bytes32 nonce = bytes32(uint256(0x1));
        BridgeMessage memory m = _msg(nonce, RECIPIENT, uint128(1_000 * ONE));
        mailbox.deliverInboundDeposit(ETICA_DOMAIN, TRUSTED_VAULT_ETICA, abi.encode(m));

        (address recipient, uint128 amount,,,, BridgeMinter.ClaimState state,, uint32 origin) =
            minter.claims(nonce);
        assertEq(recipient, RECIPIENT);
        assertEq(uint256(amount), 1_000 * ONE);
        assertEq(uint8(state), uint8(BridgeMinter.ClaimState.RECORDED));
        assertEq(uint256(origin), uint256(ETICA_DOMAIN));
    }

    function test_handle_onlyMailbox() public {
        BridgeMessage memory m = _msg(bytes32(uint256(0x1)), RECIPIENT, uint128(1_000 * ONE));
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeMinter.BridgeMinter_OnlyMailbox.selector, ATTACKER)
        );
        minter.handle(ETICA_DOMAIN, TRUSTED_VAULT_ETICA, abi.encode(m));
    }

    function test_handle_untrustedOriginReverts() public {
        BridgeMessage memory m = _msg(bytes32(uint256(0x1)), RECIPIENT, uint128(1_000 * ONE));
        m.srcDomain = 999; // unknown
        vm.expectRevert(
            abi.encodeWithSelector(BridgeMinter.BridgeMinter_UntrustedOrigin.selector, uint32(999))
        );
        mailbox.deliverInboundDeposit(uint32(999), TRUSTED_VAULT_ETICA, abi.encode(m));
    }

    function test_handle_untrustedSenderReverts() public {
        bytes32 fake = bytes32(uint256(0xDEADBEEF));
        BridgeMessage memory m = _msg(bytes32(uint256(0x1)), RECIPIENT, uint128(1_000 * ONE));
        vm.expectRevert(
            abi.encodeWithSelector(BridgeMinter.BridgeMinter_UntrustedSender.selector, fake)
        );
        mailbox.deliverInboundDeposit(ETICA_DOMAIN, fake, abi.encode(m));
    }

    function test_handle_destDomainMismatchReverts() public {
        BridgeMessage memory m = _msg(bytes32(uint256(0x1)), RECIPIENT, uint128(1_000 * ONE));
        m.destDomain = 999;
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeMinter.BridgeMinter_DestDomainMismatch.selector, SELF_DOMAIN, uint32(999)
            )
        );
        mailbox.deliverInboundDeposit(ETICA_DOMAIN, TRUSTED_VAULT_ETICA, abi.encode(m));
    }

    function test_handle_zeroAmountReverts() public {
        BridgeMessage memory m = _msg(bytes32(uint256(0x1)), RECIPIENT, 0);
        vm.expectRevert(BridgeMinter.BridgeMinter_ZeroAmount.selector);
        mailbox.deliverInboundDeposit(ETICA_DOMAIN, TRUSTED_VAULT_ETICA, abi.encode(m));
    }

    function test_handle_zeroRecipientReverts() public {
        BridgeMessage memory m = _msg(bytes32(uint256(0x1)), address(0), uint128(1 * ONE));
        vm.expectRevert(BridgeMinter.BridgeMinter_RecipientZero.selector);
        mailbox.deliverInboundDeposit(ETICA_DOMAIN, TRUSTED_VAULT_ETICA, abi.encode(m));
    }

    function test_handle_doubleRecordReverts() public {
        bytes32 nonce = bytes32(uint256(0x1));
        _record(nonce, RECIPIENT, uint128(1 * ONE));
        BridgeMessage memory m = _msg(nonce, RECIPIENT, uint128(1 * ONE));
        vm.expectRevert(
            abi.encodeWithSelector(BridgeMinter.BridgeMinter_AlreadyRecorded.selector, nonce)
        );
        mailbox.deliverInboundDeposit(ETICA_DOMAIN, TRUSTED_VAULT_ETICA, abi.encode(m));
    }

    function test_handle_pausedReverts() public {
        vm.prank(OWNER);
        minter.pause();
        BridgeMessage memory m = _msg(bytes32(uint256(0x1)), RECIPIENT, uint128(1 * ONE));
        vm.expectRevert(BridgeMinter.BridgeMinter_Paused.selector);
        mailbox.deliverInboundDeposit(ETICA_DOMAIN, TRUSTED_VAULT_ETICA, abi.encode(m));
    }

    /* -------------------------------------------------------------------- */
    /*                            SUBMIT CLAIM                              */
    /* -------------------------------------------------------------------- */

    function test_submitClaim_happyPath() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);

        uint128 expectedBond = uint128((uint256(amount) * BOND_BPS) / 10_000);
        assertEq(uint256(minter.bondRequiredFor(amount)), uint256(expectedBond));

        vm.deal(SUBMITTER, expectedBond);
        vm.prank(SUBMITTER);
        uint128 paid = minter.submitClaim{value: expectedBond}(nonce);
        assertEq(uint256(paid), uint256(expectedBond));

        (,, address submitter, uint128 bondWei, uint64 expiresAt, BridgeMinter.ClaimState state,,) =
            minter.claims(nonce);
        assertEq(submitter, SUBMITTER);
        assertEq(uint256(bondWei), uint256(expectedBond));
        assertEq(uint256(expiresAt), block.timestamp + CHALLENGE);
        assertEq(uint8(state), uint8(BridgeMinter.ClaimState.PENDING));
    }

    function test_submitClaim_acceptsOverpayment() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);

        uint128 required = minter.bondRequiredFor(amount);
        uint128 paid = required + 1 ether;
        vm.deal(SUBMITTER, paid);
        vm.prank(SUBMITTER);
        minter.submitClaim{value: paid}(nonce);
        (,,, uint128 bondWei,,,,) = minter.claims(nonce);
        assertEq(uint256(bondWei), uint256(paid));
    }

    function test_submitClaim_underBondReverts() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);

        uint128 required = minter.bondRequiredFor(amount);
        uint128 short = required - 1;
        vm.deal(SUBMITTER, short);
        vm.prank(SUBMITTER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeMinter.BridgeMinter_InsufficientBond.selector, short, required
            )
        );
        minter.submitClaim{value: short}(nonce);
    }

    function test_submitClaim_unrecordedNonceReverts() public {
        bytes32 nonce = bytes32(uint256(0xDEAD));
        vm.deal(SUBMITTER, 1 ether);
        vm.prank(SUBMITTER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeMinter.BridgeMinter_WrongState.selector, BridgeMinter.ClaimState.NONE
            )
        );
        minter.submitClaim{value: 1 ether}(nonce);
    }

    function test_submitClaim_doubleSubmitReverts() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);
        _submit(nonce, SUBMITTER, amount);

        uint128 required = minter.bondRequiredFor(amount);
        vm.deal(SUBMITTER, required);
        vm.prank(SUBMITTER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeMinter.BridgeMinter_WrongState.selector, BridgeMinter.ClaimState.PENDING
            )
        );
        minter.submitClaim{value: required}(nonce);
    }

    /* -------------------------------------------------------------------- */
    /*                            EXECUTE CLAIM                             */
    /* -------------------------------------------------------------------- */

    function test_executeClaim_mintsAndRefundsBond() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);
        uint128 bond = _submit(nonce, SUBMITTER, amount);

        vm.warp(block.timestamp + CHALLENGE + 1);
        uint256 submitterBalBefore = SUBMITTER.balance;
        minter.executeClaim(nonce);

        assertEq(wetx.balanceOf(RECIPIENT), amount);
        assertEq(SUBMITTER.balance, submitterBalBefore + bond);
        (,,,,, BridgeMinter.ClaimState state,,) = minter.claims(nonce);
        assertEq(uint8(state), uint8(BridgeMinter.ClaimState.EXECUTED));
        assertEq(uint256(minter.mintedTodayEtx()), amount);
    }

    function test_executeClaim_beforeMaturityReverts() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);
        _submit(nonce, SUBMITTER, amount);

        // Read expiresAt from storage.
        (,,,, uint64 expiresAt,,,) = minter.claims(nonce);

        vm.warp(uint256(expiresAt) - 1);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeMinter.BridgeMinter_NotMatured.selector, expiresAt)
        );
        minter.executeClaim(nonce);
    }

    function test_executeClaim_perClaimCapEnforced() public {
        bytes32 nonce = bytes32(uint256(0x1));
        // perClaimCap = 1% of 1M = 10_000 ether. Try amount > cap.
        uint128 amount = uint128(20_000 * ONE);
        _record(nonce, RECIPIENT, amount);
        _submit(nonce, SUBMITTER, amount);

        vm.warp(block.timestamp + CHALLENGE + 1);
        uint128 cap = minter.perClaimCapEtx();
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeMinter.BridgeMinter_PerClaimCapExceeded.selector, amount, cap
            )
        );
        minter.executeClaim(nonce);
    }

    function test_executeClaim_dailyCapEnforced() public {
        // dailyCap = 5% of 1M = 50_000 ether. perClaimCap = 10_000 ether.
        // Six claims of 10_000 each -> sixth fails (50K matures, 60K would-be).
        uint128 amount = uint128(10_000 * ONE);

        for (uint256 i = 1; i <= 5; i++) {
            bytes32 nonce = bytes32(i);
            _record(nonce, RECIPIENT, amount);
            _submit(nonce, SUBMITTER, amount);
        }
        bytes32 sixth = bytes32(uint256(6));
        _record(sixth, RECIPIENT, amount);
        _submit(sixth, SUBMITTER, amount);

        vm.warp(block.timestamp + CHALLENGE + 1);
        for (uint256 i = 1; i <= 5; i++) {
            minter.executeClaim(bytes32(i));
        }
        uint128 dailyCap = minter.dailyMintCapEtx();
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeMinter.BridgeMinter_RateLimitExceeded.selector, dailyCap + amount, dailyCap
            )
        );
        minter.executeClaim(sixth);
    }

    function test_executeClaim_dailyCounterResetsAtUtcRollover() public {
        uint128 amount = uint128(10_000 * ONE);
        bytes32 a = bytes32(uint256(1));
        bytes32 b = bytes32(uint256(2));
        _record(a, RECIPIENT, amount);
        _submit(a, SUBMITTER, amount);

        vm.warp(block.timestamp + CHALLENGE + 1);
        minter.executeClaim(a);
        assertEq(uint256(minter.mintedTodayEtx()), amount);

        // Roll into the next UTC day before submitting + executing the second.
        _record(b, RECIPIENT, amount);
        _submit(b, SUBMITTER, amount);
        vm.warp(block.timestamp + 1 days + CHALLENGE + 1);
        minter.executeClaim(b);
        assertEq(uint256(minter.mintedTodayEtx()), amount);
    }

    function test_executeClaim_doubleExecuteReverts() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);
        _submit(nonce, SUBMITTER, amount);

        vm.warp(block.timestamp + CHALLENGE + 1);
        minter.executeClaim(nonce);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeMinter.BridgeMinter_WrongState.selector, BridgeMinter.ClaimState.EXECUTED
            )
        );
        minter.executeClaim(nonce);
    }

    function test_executeClaim_pausedReverts() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);
        _submit(nonce, SUBMITTER, amount);
        vm.warp(block.timestamp + CHALLENGE + 1);

        vm.prank(OWNER);
        minter.pause();
        vm.expectRevert(BridgeMinter.BridgeMinter_Paused.selector);
        minter.executeClaim(nonce);
    }

    function test_executeClaim_bondRefundFailureReverts() public {
        RejectingRecipient rr = new RejectingRecipient();
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);

        uint128 bond = minter.bondRequiredFor(amount);
        vm.deal(address(rr), bond);
        vm.prank(address(rr));
        minter.submitClaim{value: bond}(nonce);

        vm.warp(block.timestamp + CHALLENGE + 1);
        vm.expectRevert(BridgeMinter.BridgeMinter_BondRefundFailed.selector);
        minter.executeClaim(nonce);
    }

    /* -------------------------------------------------------------------- */
    /*                          MANUAL VETO PATH                            */
    /* -------------------------------------------------------------------- */

    function test_vetoClaimManual_slashesAndDistributes() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);
        uint128 bond = _submit(nonce, SUBMITTER, amount);

        uint256 rewardBalBefore = MANUAL_REWARD.balance;
        uint256 treasuryBalBefore = TREASURY.balance;

        vm.prank(VETO_AUTH);
        minter.vetoClaimManual(nonce, VetoReason.OPERATOR_MANUAL);

        uint128 expectedProver = uint128((uint256(bond) * 2_500) / 10_000);
        uint128 expectedTreasury = uint128((uint256(bond) * 5_000) / 10_000);
        uint128 expectedInsurance = bond - expectedProver - expectedTreasury;
        assertEq(MANUAL_REWARD.balance - rewardBalBefore, expectedProver);
        assertEq(TREASURY.balance - treasuryBalBefore, expectedTreasury);
        assertEq(uint256(minter.pendingInsuranceShareWei()), uint256(expectedInsurance));

        (,,,,, BridgeMinter.ClaimState state, VetoReason reason,) = minter.claims(nonce);
        assertEq(uint8(state), uint8(BridgeMinter.ClaimState.VETOED));
        assertEq(uint8(reason), uint8(VetoReason.OPERATOR_MANUAL));
    }

    function test_vetoClaimManual_onlyVetoAuthority() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);
        _submit(nonce, SUBMITTER, amount);

        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeMinter.BridgeMinter_OnlyVetoAuthority.selector, ATTACKER)
        );
        minter.vetoClaimManual(nonce, VetoReason.OPERATOR_MANUAL);
    }

    function test_vetoClaimManual_afterExpiryReverts() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);
        _submit(nonce, SUBMITTER, amount);

        vm.warp(block.timestamp + CHALLENGE + 1);
        (,,,, uint64 expiresAt,,,) = minter.claims(nonce);
        vm.prank(VETO_AUTH);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeMinter.BridgeMinter_NotMatured.selector, expiresAt)
        );
        minter.vetoClaimManual(nonce, VetoReason.OPERATOR_MANUAL);
    }

    function test_vetoClaimManual_nonPendingReverts() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);

        vm.prank(VETO_AUTH);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeMinter.BridgeMinter_WrongState.selector, BridgeMinter.ClaimState.RECORDED
            )
        );
        minter.vetoClaimManual(nonce, VetoReason.OPERATOR_MANUAL);
    }

    /* -------------------------------------------------------------------- */
    /*                       FRAUD-PROOF VETO PATH                          */
    /* -------------------------------------------------------------------- */

    function test_vetoClaimWithProof_distributesToProver() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);
        uint128 bond = _submit(nonce, SUBMITTER, amount);

        // "actualDeposit" diverges from the recorded claim — fraud established.
        BridgeMessage memory actual = _msg(nonce, address(0xAAAA), amount);
        uint256 proverBalBefore = PROVER.balance;

        vm.prank(FRAUD_AUTH);
        minter.vetoClaimWithProof(nonce, actual, PROVER);

        uint128 expectedProver = uint128((uint256(bond) * 2_500) / 10_000);
        assertEq(PROVER.balance - proverBalBefore, expectedProver);

        (,,,,, BridgeMinter.ClaimState state, VetoReason reason,) = minter.claims(nonce);
        assertEq(uint8(state), uint8(BridgeMinter.ClaimState.VETOED));
        assertEq(uint8(reason), uint8(VetoReason.FRAUD_PROVER_MERKLE));
    }

    function test_vetoClaimWithProof_onlyFraudAuthority() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);
        _submit(nonce, SUBMITTER, amount);

        BridgeMessage memory actual = _msg(nonce, address(0xAAAA), amount);
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeMinter.BridgeMinter_OnlyFraudProverAuthority.selector, ATTACKER
            )
        );
        minter.vetoClaimWithProof(nonce, actual, PROVER);
    }

    function test_vetoClaimWithProof_zeroProverReverts() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);
        _submit(nonce, SUBMITTER, amount);

        BridgeMessage memory actual = _msg(nonce, address(0xAAAA), amount);
        vm.prank(FRAUD_AUTH);
        vm.expectRevert(BridgeMinter.BridgeMinter_ZeroAddress.selector);
        minter.vetoClaimWithProof(nonce, actual, address(0));
    }

    function test_vetoClaimWithProof_proofMatchesClaimReverts() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);
        _submit(nonce, SUBMITTER, amount);

        // "actualDeposit" matches recorded claim — no fraud established.
        BridgeMessage memory actual = _msg(nonce, RECIPIENT, amount);
        vm.prank(FRAUD_AUTH);
        vm.expectRevert(BridgeMinter.BridgeMinter_ProofMatchesClaim.selector);
        minter.vetoClaimWithProof(nonce, actual, PROVER);
    }

    /* -------------------------------------------------------------------- */
    /*                                BURN                                  */
    /* -------------------------------------------------------------------- */

    function test_burn_dispatchesAndAccruesFee() public {
        // First mint some wETX to USER via the inbound flow.
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, USER, amount);
        _submit(nonce, SUBMITTER, amount);
        vm.warp(block.timestamp + CHALLENGE + 1);
        minter.executeClaim(nonce);
        assertEq(wetx.balanceOf(USER), amount);

        uint128 burnAmount = uint128(500 * ONE);
        vm.prank(USER);
        minter.burn{value: 0}(burnAmount, ETICA_DOMAIN, RECIPIENT);

        uint128 fee = uint128((uint256(burnAmount) * FEE_BPS) / 10_000);
        uint128 net = burnAmount - fee;
        assertEq(uint256(minter.totalFeesAccruedEtx()), uint256(fee));
        assertEq(wetx.balanceOf(USER), amount - burnAmount);
        assertEq(uint256(mailbox.dispatchCount()), 1);
        assertEq(uint256(mailbox.lastDestDomain()), uint256(ETICA_DOMAIN));
        assertEq(mailbox.lastRecipient(), TRUSTED_VAULT_ETICA);

        BridgeMessage memory decoded = abi.decode(mailbox.lastBody(), (BridgeMessage));
        assertEq(uint256(decoded.amount), uint256(net));
        assertEq(decoded.sender, USER);
        assertEq(decoded.recipient, RECIPIENT);
        assertEq(uint256(decoded.srcDomain), uint256(SELF_DOMAIN));
        assertEq(uint256(decoded.destDomain), uint256(ETICA_DOMAIN));
    }

    function test_burn_destNotAllowedReverts() public {
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(100 * ONE);
        _record(nonce, USER, amount);
        _submit(nonce, SUBMITTER, amount);
        vm.warp(block.timestamp + CHALLENGE + 1);
        minter.executeClaim(nonce);

        vm.prank(USER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeMinter.BridgeMinter_DestNotAllowed.selector, BNB_DOMAIN)
        );
        minter.burn(amount, BNB_DOMAIN, RECIPIENT);
    }

    function test_burn_zeroAmountReverts() public {
        vm.prank(USER);
        vm.expectRevert(BridgeMinter.BridgeMinter_ZeroAmount.selector);
        minter.burn(0, ETICA_DOMAIN, RECIPIENT);
    }

    function test_burn_zeroRecipientReverts() public {
        vm.prank(USER);
        vm.expectRevert(BridgeMinter.BridgeMinter_RecipientZero.selector);
        minter.burn(uint128(1 * ONE), ETICA_DOMAIN, address(0));
    }

    function test_burn_pausedReverts() public {
        vm.prank(OWNER);
        minter.pause();
        vm.prank(USER);
        vm.expectRevert(BridgeMinter.BridgeMinter_Paused.selector);
        minter.burn(uint128(1 * ONE), ETICA_DOMAIN, RECIPIENT);
    }

    /* -------------------------------------------------------------------- */
    /*                         INSURANCE SWEEP                              */
    /* -------------------------------------------------------------------- */

    function test_sweepInsuranceShare_drainsAccumulator() public {
        // Generate a slash to fill `pendingInsuranceShareWei`.
        bytes32 nonce = bytes32(uint256(0x1));
        uint128 amount = uint128(1_000 * ONE);
        _record(nonce, RECIPIENT, amount);
        _submit(nonce, SUBMITTER, amount);
        vm.prank(VETO_AUTH);
        minter.vetoClaimManual(nonce, VetoReason.OPERATOR_MANUAL);

        uint128 pending = minter.pendingInsuranceShareWei();
        assertGt(uint256(pending), 0);
        uint256 sweepBalBefore = INSURANCE_SWEEP.balance;

        minter.sweepInsuranceShare();

        assertEq(uint256(minter.pendingInsuranceShareWei()), 0);
        assertEq(INSURANCE_SWEEP.balance - sweepBalBefore, pending);
    }

    function test_sweepInsuranceShare_emptyReverts() public {
        vm.expectRevert(BridgeMinter.BridgeMinter_ZeroAmount.selector);
        minter.sweepInsuranceShare();
    }

    /* -------------------------------------------------------------------- */
    /*                                PAUSE                                 */
    /* -------------------------------------------------------------------- */

    function test_pause_onlyOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        minter.pause();
    }

    function test_pause_doubleReverts() public {
        vm.startPrank(OWNER);
        minter.pause();
        vm.expectRevert(BridgeMinter.BridgeMinter_Paused.selector);
        minter.pause();
        vm.stopPrank();
    }

    function test_unpause_isTimelocked() public {
        vm.prank(OWNER);
        minter.pause();
        vm.prank(OWNER);
        uint256 id = minter.requestUnpause();

        // Premature execute fails.
        vm.prank(OWNER);
        vm.expectRevert();
        minter.executeOp(id);

        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        minter.executeOp(id);
        assertEq(minter.paused(), false);
    }

    function test_unpause_whileNotPausedReverts() public {
        vm.prank(OWNER);
        vm.expectRevert(BridgeMinter.BridgeMinter_NotPaused.selector);
        minter.requestUnpause();
    }

    /* -------------------------------------------------------------------- */
    /*                         TIMELOCKED OPS                               */
    /* -------------------------------------------------------------------- */

    function test_op_executeBeforeTimelockReverts() public {
        vm.prank(OWNER);
        uint256 id = minter.requestSetBondBps(2_000);
        vm.prank(OWNER);
        vm.expectRevert();
        minter.executeOp(id);
    }

    function test_op_cancelBlocksExecute() public {
        vm.prank(OWNER);
        uint256 id = minter.requestSetBondBps(2_000);
        vm.prank(OWNER);
        minter.cancelOp(id);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vm.expectRevert();
        minter.executeOp(id);
    }

    function test_op_setBondBpsApplies() public {
        vm.prank(OWNER);
        uint256 id = minter.requestSetBondBps(2_000);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        minter.executeOp(id);
        assertEq(uint256(minter.bondBps()), 2_000);
    }

    function test_op_invalidBondBpsRequestReverts() public {
        vm.prank(OWNER);
        vm.expectRevert();
        minter.requestSetBondBps(50); // < MIN_BOND_BPS

        vm.prank(OWNER);
        vm.expectRevert();
        minter.requestSetBondBps(7_000); // > MAX_BOND_BPS
    }

    function test_op_setRateLimitsApplies() public {
        vm.prank(OWNER);
        uint256 id = minter.requestSetRateLimits(800, 200);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        minter.executeOp(id);
        assertEq(uint256(minter.dailyMintCapBps()), 800);
        assertEq(uint256(minter.perClaimCapBps()), 200);
    }

    function test_op_setTvlCapApplies() public {
        vm.prank(OWNER);
        uint256 id = minter.requestSetTvlCap(2_000_000 ether);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        minter.executeOp(id);
        assertEq(uint256(minter.tvlCapEtx()), 2_000_000 ether);
    }

    function test_op_setChallengeWindowApplies() public {
        vm.prank(OWNER);
        uint256 id = minter.requestSetChallengeWindow(72 hours);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        minter.executeOp(id);
        assertEq(uint256(minter.challengeWindowSeconds()), 72 hours);
    }

    function test_op_onlyOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        minter.requestSetBondBps(2_000);
    }

    /* -------------------------------------------------------------------- */
    /*                           OWNERSHIP                                  */
    /* -------------------------------------------------------------------- */

    function test_ownership_isTwoStep() public {
        address newOwner = address(0xC0FFEE);
        vm.prank(OWNER);
        minter.transferOwnership(newOwner);
        // Pending transfer; old owner still in charge until accept.
        assertEq(minter.owner(), OWNER);

        vm.prank(newOwner);
        minter.acceptOwnership();
        assertEq(minter.owner(), newOwner);
    }

    /* -------------------------------------------------------------------- */
    /*                       HEARTBEAT / SUCCESSOR                          */
    /* -------------------------------------------------------------------- */

    address internal constant HB_SIGNER = address(0xB07B07);
    address internal constant SUCCESSOR = address(0x5C0EE);

    /// @dev Drives the heartbeat-signer + successor-key timelocked ops to
    ///      completion so individual tests can focus on the post-config
    ///      behavior (heartbeat, checkHeartbeat, activateSuccessor).
    function _wireHeartbeatAndSuccessor() internal {
        uint256[] memory ids = new uint256[](2);
        vm.startPrank(OWNER);
        ids[0] = minter.requestSetHeartbeatSigner(HB_SIGNER);
        ids[1] = minter.requestSetSuccessorKey(SUCCESSOR);
        vm.stopPrank();
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.startPrank(OWNER);
        minter.executeOp(ids[0]);
        minter.executeOp(ids[1]);
        vm.stopPrank();
    }

    function test_constructor_initializesHeartbeatAndSuccessorDefaults() public view {
        assertEq(minter.heartbeatSigner(), address(0));
        assertEq(minter.successorKey(), address(0));
        assertEq(uint256(minter.heartbeatTimeoutSeconds()), 4 hours);
        assertEq(uint256(minter.successorTimelockSeconds()), 90 days);
        // The launch-defaults helper warps OP_TIMELOCK forward, so
        // `lastHeartbeatAt` is the deploy timestamp (= block.timestamp - OP_TIMELOCK).
        assertEq(uint256(minter.lastHeartbeatAt()), block.timestamp - OP_TIMELOCK);
    }

    function test_heartbeat_signerCanPing() public {
        _wireHeartbeatAndSuccessor();
        uint64 before = minter.lastHeartbeatAt();
        vm.warp(block.timestamp + 1 hours);
        vm.expectEmit(true, false, false, true);
        emit BridgeMinter.Heartbeat(HB_SIGNER, uint64(block.timestamp));
        vm.prank(HB_SIGNER);
        minter.heartbeat();
        assertGt(uint256(minter.lastHeartbeatAt()), uint256(before));
        assertEq(uint256(minter.lastHeartbeatAt()), block.timestamp);
    }

    function test_heartbeat_ownerCanPingWithoutSigner() public {
        // Signer is unset by default; owner must still be able to heartbeat.
        vm.warp(block.timestamp + 1 hours);
        vm.prank(OWNER);
        minter.heartbeat();
        assertEq(uint256(minter.lastHeartbeatAt()), block.timestamp);
    }

    function test_heartbeat_strangerReverts() public {
        _wireHeartbeatAndSuccessor();
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeMinter.BridgeMinter_OnlyHeartbeatSigner.selector, ATTACKER)
        );
        minter.heartbeat();
    }

    function test_checkHeartbeat_freshIsHealthy() public {
        // Owner pings, then we observe the view returns true while still inside
        // the timeout window.
        vm.prank(OWNER);
        minter.heartbeat();
        assertTrue(minter.checkHeartbeat());
    }

    function test_checkHeartbeat_stalePastTimeoutIsUnhealthy() public {
        vm.prank(OWNER);
        minter.heartbeat();
        // 4h is the default timeout; one second past returns false.
        vm.warp(block.timestamp + 4 hours + 1);
        assertFalse(minter.checkHeartbeat());
    }

    function test_checkHeartbeat_atExactBoundaryIsUnhealthy() public {
        vm.prank(OWNER);
        minter.heartbeat();
        // Strict less-than comparison: hitting the boundary is already stale.
        vm.warp(block.timestamp + 4 hours);
        assertFalse(minter.checkHeartbeat());
    }

    function test_activateSuccessor_unsetReverts() public {
        // No successor wired; even after a long silence the call reverts.
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert(BridgeMinter.BridgeMinter_SuccessorUnset.selector);
        minter.activateSuccessor();
    }

    function test_activateSuccessor_notReadyReverts() public {
        _wireHeartbeatAndSuccessor();
        // Operator just heartbeated; successor cannot fire for 90 days.
        vm.prank(OWNER);
        minter.heartbeat();
        uint64 readyAt = minter.lastHeartbeatAt() + minter.successorTimelockSeconds();

        vm.warp(block.timestamp + 89 days);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeMinter.BridgeMinter_SuccessorNotReady.selector, readyAt)
        );
        minter.activateSuccessor();
    }

    function test_activateSuccessor_transfersOwnerAfterTimeout() public {
        _wireHeartbeatAndSuccessor();
        address prevOwner = minter.owner();

        // Roll well past the 90d window.
        vm.warp(minter.lastHeartbeatAt() + minter.successorTimelockSeconds() + 1);

        vm.expectEmit(true, true, false, false);
        emit BridgeMinter.SuccessorActivated(prevOwner, SUCCESSOR);

        // Permissionless: a stranger drives the transfer.
        vm.prank(ATTACKER);
        minter.activateSuccessor();

        assertEq(minter.owner(), SUCCESSOR);
        // Heartbeat clock resets to the activation block.
        assertEq(uint256(minter.lastHeartbeatAt()), block.timestamp);
    }

    function test_activateSuccessor_ownerCanRecoverWithFreshHeartbeat() public {
        _wireHeartbeatAndSuccessor();
        // Roll close to the brink, but a fresh heartbeat resets the clock and
        // reverts an attempted activation.
        vm.warp(minter.lastHeartbeatAt() + minter.successorTimelockSeconds() - 1 hours);
        vm.prank(OWNER);
        minter.heartbeat();

        // Try to activate using the new (fresh) anchor: must revert NotReady.
        uint64 newReadyAt = minter.lastHeartbeatAt() + minter.successorTimelockSeconds();
        vm.expectRevert(
            abi.encodeWithSelector(BridgeMinter.BridgeMinter_SuccessorNotReady.selector, newReadyAt)
        );
        minter.activateSuccessor();

        // Owner unchanged.
        assertEq(minter.owner(), OWNER);
    }

    function test_op_setHeartbeatSignerApplies() public {
        vm.prank(OWNER);
        uint256 id = minter.requestSetHeartbeatSigner(HB_SIGNER);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        minter.executeOp(id);
        assertEq(minter.heartbeatSigner(), HB_SIGNER);
    }

    function test_op_setHeartbeatSignerCanZero() public {
        // Wire then unwire; zero is allowed, lets the owner disarm the bot path.
        vm.startPrank(OWNER);
        uint256 id1 = minter.requestSetHeartbeatSigner(HB_SIGNER);
        vm.stopPrank();
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        minter.executeOp(id1);
        assertEq(minter.heartbeatSigner(), HB_SIGNER);

        vm.prank(OWNER);
        uint256 id2 = minter.requestSetHeartbeatSigner(address(0));
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        minter.executeOp(id2);
        assertEq(minter.heartbeatSigner(), address(0));
    }

    function test_op_setHeartbeatTimeoutApplies() public {
        vm.prank(OWNER);
        uint256 id = minter.requestSetHeartbeatTimeout(2 hours);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        minter.executeOp(id);
        assertEq(uint256(minter.heartbeatTimeoutSeconds()), 2 hours);
    }

    function test_op_setHeartbeatTimeoutOutOfRangeReverts() public {
        vm.startPrank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeMinter.BridgeMinter_BadHeartbeatTimeout.selector, uint64(30 minutes)
            )
        );
        minter.requestSetHeartbeatTimeout(30 minutes);

        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeMinter.BridgeMinter_BadHeartbeatTimeout.selector, uint64(48 hours)
            )
        );
        minter.requestSetHeartbeatTimeout(48 hours);
        vm.stopPrank();
    }

    function test_op_setSuccessorKeyApplies() public {
        vm.prank(OWNER);
        uint256 id = minter.requestSetSuccessorKey(SUCCESSOR);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        minter.executeOp(id);
        assertEq(minter.successorKey(), SUCCESSOR);
    }

    function test_op_setSuccessorKeyCanZero() public {
        // Disarm by setting back to zero — useful before rotating to a new
        // successor without leaving an old key live during the gap.
        vm.startPrank(OWNER);
        uint256 id1 = minter.requestSetSuccessorKey(SUCCESSOR);
        vm.stopPrank();
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        minter.executeOp(id1);

        vm.prank(OWNER);
        uint256 id2 = minter.requestSetSuccessorKey(address(0));
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        minter.executeOp(id2);
        assertEq(minter.successorKey(), address(0));
    }

    function test_op_setSuccessorTimelockApplies() public {
        vm.prank(OWNER);
        uint256 id = minter.requestSetSuccessorTimelock(180 days);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        minter.executeOp(id);
        assertEq(uint256(minter.successorTimelockSeconds()), 180 days);
    }

    function test_op_setSuccessorTimelockOutOfRangeReverts() public {
        vm.startPrank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeMinter.BridgeMinter_BadSuccessorTimelock.selector, uint64(7 days)
            )
        );
        minter.requestSetSuccessorTimelock(7 days);

        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeMinter.BridgeMinter_BadSuccessorTimelock.selector, uint64(400 days)
            )
        );
        minter.requestSetSuccessorTimelock(400 days);
        vm.stopPrank();
    }

    function test_op_heartbeatSettersOnlyOwner() public {
        vm.startPrank(ATTACKER);
        bytes memory expected =
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER);

        vm.expectRevert(expected);
        minter.requestSetHeartbeatSigner(HB_SIGNER);

        vm.expectRevert(expected);
        minter.requestSetHeartbeatTimeout(2 hours);

        vm.expectRevert(expected);
        minter.requestSetSuccessorKey(SUCCESSOR);

        vm.expectRevert(expected);
        minter.requestSetSuccessorTimelock(120 days);
        vm.stopPrank();
    }
}
