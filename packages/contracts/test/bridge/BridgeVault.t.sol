// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BridgeVault, IMailbox} from "../../src/bridge/BridgeVault.sol";
import {BridgeInsuranceFund} from "../../src/bridge/BridgeInsuranceFund.sol";
import {FeeRouter} from "../../src/bridge/FeeRouter.sol";
import {ETXToken} from "../../src/etx/ETXToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Mailbox stub. Records the latest dispatch and lets tests inject
///         inbound `handle` calls back into the vault under the mailbox role.
contract MockMailbox {
    BridgeVault public vault;
    uint32 public lastDestDomain;
    bytes32 public lastRecipient;
    bytes public lastBody;
    uint256 public lastValue;
    uint256 public dispatchCount;

    function setVault(BridgeVault _vault) external {
        vault = _vault;
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

    function deliverBurnMessage(uint32 origin, bytes32 sender, bytes calldata body) external {
        vault.handle(origin, sender, body);
    }
}

contract BridgeVaultTest is Test {
    ETXToken internal etx;
    BridgeInsuranceFund internal fund;
    FeeRouter internal router;
    BridgeVault internal vault;
    MockMailbox internal mailbox;

    address internal constant OWNER = address(0x0117E2);
    address internal constant TREASURY = address(0x77E45);
    address internal constant HARVESTER = address(0x4A4E57);
    address internal constant USER = address(0xCAFE);
    address internal constant RECIPIENT_ETH = address(0xEEEE);
    address internal constant RECIPIENT_ETICA = address(0xE71CA);
    address internal constant VETO_AUTH = address(0xBEEF);
    address internal constant ATTACKER = address(0xBAD);

    uint32 internal constant SELF_DOMAIN = 61803;
    uint32 internal constant ETH_DOMAIN = 1;
    uint32 internal constant BNB_DOMAIN = 56;
    uint64 internal constant FUND_TIMELOCK = 30 days;
    uint64 internal constant SPLIT_TIMELOCK = 24 hours;
    uint64 internal constant OP_TIMELOCK = 48 hours;

    bytes32 internal constant TRUSTED_MINTER_ETH = bytes32(uint256(uint160(0xABCD1234)));
    bytes32 internal constant TRUSTED_MINTER_BNB = bytes32(uint256(uint160(0xABCD5678)));

    uint256 internal constant ONE = 1e18;

    function setUp() public {
        etx = new ETXToken(TREASURY);
        fund = new BridgeInsuranceFund(IERC20(address(etx)), OWNER, FUND_TIMELOCK);
        router = new FeeRouter(IERC20(address(etx)), OWNER, fund, HARVESTER, SPLIT_TIMELOCK);
        mailbox = new MockMailbox();
        vault = new BridgeVault(
            OWNER, IERC20(address(etx)), address(mailbox), fund, router, SELF_DOMAIN, OP_TIMELOCK
        );
        mailbox.setVault(vault);

        vm.prank(OWNER);
        fund.setBridgeVault(address(vault));
        vm.prank(OWNER);
        router.setBridgeVault(address(vault));

        // Seed user with ETX and grant vault unlimited approval.
        vm.prank(TREASURY);
        etx.transfer(USER, 100_000 * ONE);
        vm.prank(USER);
        etx.approve(address(vault), type(uint256).max);

        // Wire the launch defaults: allow ETH + BNB destinations, set trusted
        // minters, set veto authority.
        _wireLaunchDefaults();
    }

    function _wireLaunchDefaults() internal {
        uint256[] memory ids = new uint256[](4);
        vm.startPrank(OWNER);
        ids[0] = vault.requestSetAllowedDestDomain(ETH_DOMAIN, true);
        ids[1] = vault.requestSetTrustedMinter(ETH_DOMAIN, TRUSTED_MINTER_ETH);
        ids[2] = vault.requestSetVetoAuthority(VETO_AUTH);
        ids[3] = vault.requestSetAllowedDestDomain(BNB_DOMAIN, true);
        vm.stopPrank();

        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.startPrank(OWNER);
        for (uint256 i = 0; i < ids.length; i++) {
            vault.executeOp(ids[i]);
        }
        vm.stopPrank();
    }

    /* -------------------------------------------------------------------- */
    /*                            CONSTRUCTOR                               */
    /* -------------------------------------------------------------------- */

    function test_constructor_setsImmutables() public view {
        assertEq(address(vault.etx()), address(etx));
        assertEq(vault.hyperlaneMailbox(), address(mailbox));
        assertEq(address(vault.insuranceFund()), address(fund));
        assertEq(address(vault.feeRouter()), address(router));
        assertEq(vault.selfDomain(), SELF_DOMAIN);
        assertEq(vault.opTimelock(), OP_TIMELOCK);
        assertEq(vault.owner(), OWNER);
    }

    function test_constructor_setsLaunchDefaults() public view {
        assertEq(vault.tvlCapEtx(), 1_000_000e18);
        assertEq(vault.bridgeFeeBps(), 10);
        assertEq(vault.dailyWithdrawCapBps(), 500);
        assertEq(vault.perClaimCapBps(), 100);
        assertEq(vault.challengeWindowSeconds(), 48 hours);
        assertEq(vault.totalLockedEtx(), 0);
        assertEq(vault.depositCounter(), 0);
        assertFalse(vault.paused());
    }

    function test_constructor_revertsOnZeroEtx() public {
        vm.expectRevert(BridgeVault.BridgeVault_ZeroAddress.selector);
        new BridgeVault(
            OWNER, IERC20(address(0)), address(mailbox), fund, router, SELF_DOMAIN, OP_TIMELOCK
        );
    }

    function test_constructor_revertsOnZeroMailbox() public {
        vm.expectRevert(BridgeVault.BridgeVault_ZeroAddress.selector);
        new BridgeVault(
            OWNER, IERC20(address(etx)), address(0), fund, router, SELF_DOMAIN, OP_TIMELOCK
        );
    }

    function test_constructor_revertsOnZeroOwner() public {
        // Ownable rejects zero owner first.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new BridgeVault(
            address(0),
            IERC20(address(etx)),
            address(mailbox),
            fund,
            router,
            SELF_DOMAIN,
            OP_TIMELOCK
        );
    }

    function test_constructor_revertsOnZeroFundOrRouter() public {
        vm.expectRevert(BridgeVault.BridgeVault_ZeroAddress.selector);
        new BridgeVault(
            OWNER,
            IERC20(address(etx)),
            address(mailbox),
            BridgeInsuranceFund(address(0)),
            router,
            SELF_DOMAIN,
            OP_TIMELOCK
        );
        vm.expectRevert(BridgeVault.BridgeVault_ZeroAddress.selector);
        new BridgeVault(
            OWNER,
            IERC20(address(etx)),
            address(mailbox),
            fund,
            FeeRouter(address(0)),
            SELF_DOMAIN,
            OP_TIMELOCK
        );
    }

    /* -------------------------------------------------------------------- */
    /*                              DEPOSIT                                 */
    /* -------------------------------------------------------------------- */

    function test_deposit_happyPath_chargesFeeAndDispatches() public {
        uint128 amount = uint128(1000 * ONE);
        uint128 expectedFee = uint128(1 * ONE); // 0.1% of 1000
        uint128 expectedNet = amount - expectedFee;

        vm.prank(USER);
        bytes32 nonce = vault.deposit(amount, ETH_DOMAIN, RECIPIENT_ETH);

        // Vault holds the net.
        assertEq(etx.balanceOf(address(vault)), expectedNet);
        // Fee got split 20/80 by the router.
        assertEq(fund.balance(), (expectedFee * 2000) / 10_000);
        assertEq(etx.balanceOf(HARVESTER), expectedFee - (expectedFee * 2000) / 10_000);

        // Accounting.
        assertEq(vault.totalLockedEtx(), expectedNet);
        assertEq(vault.totalFeesAccruedEtx(), expectedFee);
        assertEq(vault.depositCounter(), 1);

        // Hyperlane dispatch happened.
        assertEq(mailbox.dispatchCount(), 1);
        assertEq(mailbox.lastDestDomain(), ETH_DOMAIN);
        assertEq(mailbox.lastRecipient(), TRUSTED_MINTER_ETH);
        (bytes32 dispatchedNonce, address dispatchedRecipient, uint128 dispatchedAmount) =
            abi.decode(mailbox.lastBody(), (bytes32, address, uint128));
        assertEq(dispatchedNonce, nonce);
        assertEq(dispatchedRecipient, RECIPIENT_ETH);
        assertEq(dispatchedAmount, expectedNet);
    }

    function test_deposit_revertsOnZeroAmount() public {
        vm.prank(USER);
        vm.expectRevert(BridgeVault.BridgeVault_ZeroAmount.selector);
        vault.deposit(0, ETH_DOMAIN, RECIPIENT_ETH);
    }

    function test_deposit_revertsOnZeroRecipient() public {
        vm.prank(USER);
        vm.expectRevert(BridgeVault.BridgeVault_ZeroAddress.selector);
        vault.deposit(uint128(100 * ONE), ETH_DOMAIN, address(0));
    }

    function test_deposit_revertsOnUnauthorizedDestDomain() public {
        vm.prank(USER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeVault.BridgeVault_InvalidDestDomain.selector, 999)
        );
        vault.deposit(uint128(100 * ONE), 999, RECIPIENT_ETH);
    }

    function test_deposit_revertsOnTVLCapExceeded() public {
        // Cap = 1M ETX. A deposit of 1.1M ETX gross => net 1.0989M ETX > 1M cap.
        vm.prank(TREASURY);
        etx.transfer(USER, 1_200_000 * ONE);

        vm.prank(USER);
        vm.expectRevert(); // cap-exceeded with computed values; precise selector tested below
        vault.deposit(uint128(1_100_000 * ONE), ETH_DOMAIN, RECIPIENT_ETH);
    }

    function test_deposit_revertsOnTVLCapExceeded_exact() public {
        // 1M ETX cap; net deposit = 1M ETX + 1 wei should exceed.
        // gross = (1M + 1) / 0.999 ≈ 1.0010010010M ETX
        // Easier: lower the cap via timelocked op so we can precisely compute.
        vm.prank(OWNER);
        uint256 idDaily = vault.requestSetRateLimits(500, 100); // unchanged
        // Instead lower cap by constructing values that overflow predictably:
        // current cap = 1e24; deposit 1e24 / 0.999 wei gross -> net 1e24 + 1 wei.
        // For test simplicity assert via wouldBe>cap revert text.

        // Top up user ample funds.
        vm.prank(TREASURY);
        etx.transfer(USER, 2_000_000 * ONE);

        // Compute a gross that yields net > cap:
        uint128 cap = vault.tvlCapEtx();
        // gross s.t. floor(gross * 10 / 10000) = fee, gross - fee > cap
        // Pick gross = cap + cap/100 + 1; fee ~ cap/1000; net ~ cap*1.00899 > cap
        uint128 gross = cap + cap / 100 + 1;
        uint128 fee = uint128((uint256(gross) * 10) / 10_000);
        uint128 net = gross - fee;

        vm.prank(USER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeVault.BridgeVault_TVLCapExceeded.selector, net, cap)
        );
        vault.deposit(gross, ETH_DOMAIN, RECIPIENT_ETH);
        // Silence unused var warning.
        idDaily;
    }

    function test_deposit_revertsWhenPaused() public {
        vm.prank(OWNER);
        vault.emergencyPause();
        vm.prank(USER);
        vm.expectRevert(BridgeVault.BridgeVault_Paused.selector);
        vault.deposit(uint128(100 * ONE), ETH_DOMAIN, RECIPIENT_ETH);
    }

    function test_deposit_zeroFeeWhenBpsZero() public {
        // Lower bridge fee to 0 via timelocked op.
        vm.prank(OWNER);
        uint256 id = vault.requestSetBridgeFeeBps(0);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vault.executeOp(id);

        uint128 amount = uint128(1000 * ONE);
        vm.prank(USER);
        vault.deposit(amount, ETH_DOMAIN, RECIPIENT_ETH);

        assertEq(etx.balanceOf(address(vault)), amount);
        assertEq(vault.totalFeesAccruedEtx(), 0);
        assertEq(fund.balance(), 0);
    }

    function test_deposit_uniqueNoncesPerCall() public {
        vm.startPrank(USER);
        bytes32 n1 = vault.deposit(uint128(100 * ONE), ETH_DOMAIN, RECIPIENT_ETH);
        bytes32 n2 = vault.deposit(uint128(100 * ONE), ETH_DOMAIN, RECIPIENT_ETH);
        vm.stopPrank();
        assertTrue(n1 != n2);
        assertEq(vault.depositCounter(), 2);
    }

    /* -------------------------------------------------------------------- */
    /*                       INBOUND BURN MESSAGES                          */
    /* -------------------------------------------------------------------- */

    function test_handle_revertsForNonMailbox() public {
        bytes memory body = abi.encode(bytes32(uint256(1)), RECIPIENT_ETICA, uint128(1 * ONE));
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeVault.BridgeVault_OnlyMailbox.selector, ATTACKER)
        );
        vault.handle(ETH_DOMAIN, TRUSTED_MINTER_ETH, body);
    }

    function test_handle_revertsForUntrustedSender() public {
        bytes32 attackerSender = bytes32(uint256(uint160(ATTACKER)));
        bytes memory body = abi.encode(bytes32(uint256(1)), RECIPIENT_ETICA, uint128(1 * ONE));
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeVault.BridgeVault_UntrustedSender.selector, ETH_DOMAIN, attackerSender
            )
        );
        mailbox.deliverBurnMessage(ETH_DOMAIN, attackerSender, body);
    }

    function test_handle_revertsForUnknownOrigin() public {
        bytes memory body = abi.encode(bytes32(uint256(1)), RECIPIENT_ETICA, uint128(1 * ONE));
        // No trusted minter for domain 999
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeVault.BridgeVault_UntrustedSender.selector, uint32(999), TRUSTED_MINTER_ETH
            )
        );
        mailbox.deliverBurnMessage(999, TRUSTED_MINTER_ETH, body);
    }

    function test_handle_registersPendingClaim() public {
        // Lock 1000 ETX first so vault has balance to release later.
        vm.prank(USER);
        vault.deposit(uint128(1000 * ONE), ETH_DOMAIN, RECIPIENT_ETH);

        bytes32 nonce = bytes32(uint256(0xDEAD));
        uint128 amount = uint128(50 * ONE);
        bytes memory body = abi.encode(nonce, RECIPIENT_ETICA, amount);

        uint64 expected = uint64(block.timestamp) + 48 hours;
        vm.expectEmit(true, true, false, true, address(vault));
        emit BridgeVault.WithdrawClaimSubmitted(nonce, RECIPIENT_ETICA, amount, expected);
        mailbox.deliverBurnMessage(ETH_DOMAIN, TRUSTED_MINTER_ETH, body);

        (address recipient, uint128 amt, uint64 expiresAt, BridgeVault.ClaimState state) =
            vault.claims(nonce);
        assertEq(recipient, RECIPIENT_ETICA);
        assertEq(amt, amount);
        assertEq(expiresAt, expected);
        assertEq(uint8(state), uint8(BridgeVault.ClaimState.PENDING));
    }

    function test_handle_revertsOnDuplicateNonce() public {
        bytes32 nonce = bytes32(uint256(0xCAFE));
        bytes memory body = abi.encode(nonce, RECIPIENT_ETICA, uint128(1 * ONE));
        mailbox.deliverBurnMessage(ETH_DOMAIN, TRUSTED_MINTER_ETH, body);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeVault.BridgeVault_AlreadyProcessed.selector, nonce)
        );
        mailbox.deliverBurnMessage(ETH_DOMAIN, TRUSTED_MINTER_ETH, body);
    }

    function test_handle_revertsOnZeroAmount() public {
        bytes memory body = abi.encode(bytes32(uint256(1)), RECIPIENT_ETICA, uint128(0));
        vm.expectRevert(BridgeVault.BridgeVault_ZeroAmount.selector);
        mailbox.deliverBurnMessage(ETH_DOMAIN, TRUSTED_MINTER_ETH, body);
    }

    function test_handle_revertsOnZeroRecipient() public {
        bytes memory body = abi.encode(bytes32(uint256(1)), address(0), uint128(1 * ONE));
        vm.expectRevert(BridgeVault.BridgeVault_ZeroAddress.selector);
        mailbox.deliverBurnMessage(ETH_DOMAIN, TRUSTED_MINTER_ETH, body);
    }

    /* -------------------------------------------------------------------- */
    /*                            EXECUTE WITHDRAW                          */
    /* -------------------------------------------------------------------- */

    function _seedAndSubmitClaim(bytes32 nonce, uint128 amount) internal {
        // Pre-lock funds via deposit so vault has balance to pay out.
        vm.prank(USER);
        vault.deposit(uint128(uint256(amount) * 2), ETH_DOMAIN, RECIPIENT_ETH);
        bytes memory body = abi.encode(nonce, RECIPIENT_ETICA, amount);
        mailbox.deliverBurnMessage(ETH_DOMAIN, TRUSTED_MINTER_ETH, body);
    }

    function test_executeWithdraw_happyPath() public {
        bytes32 nonce = bytes32(uint256(0x10));
        uint128 amount = uint128(5 * ONE);
        _seedAndSubmitClaim(nonce, amount);

        vm.warp(block.timestamp + 48 hours);
        uint128 lockedBefore = vault.totalLockedEtx();

        vm.expectEmit(true, true, false, true, address(vault));
        emit BridgeVault.WithdrawExecuted(nonce, RECIPIENT_ETICA, amount);
        vault.executeWithdraw(nonce);

        assertEq(etx.balanceOf(RECIPIENT_ETICA), amount);
        assertEq(vault.totalLockedEtx(), lockedBefore - amount);
        (,,, BridgeVault.ClaimState state) = vault.claims(nonce);
        assertEq(uint8(state), uint8(BridgeVault.ClaimState.EXECUTED));
    }

    function test_executeWithdraw_revertsBeforeMaturity() public {
        bytes32 nonce = bytes32(uint256(0x11));
        _seedAndSubmitClaim(nonce, uint128(5 * ONE));

        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeVault.BridgeVault_NotMatured.selector,
                uint64(block.timestamp + 1),
                uint64(block.timestamp)
            )
        );
        vault.executeWithdraw(nonce);
    }

    function test_executeWithdraw_revertsForUnknownNonce() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeVault.BridgeVault_ClaimNotPending.selector, bytes32(uint256(0xFF))
            )
        );
        vault.executeWithdraw(bytes32(uint256(0xFF)));
    }

    function test_executeWithdraw_revertsOnDoubleExecute() public {
        bytes32 nonce = bytes32(uint256(0x12));
        _seedAndSubmitClaim(nonce, uint128(5 * ONE));
        vm.warp(block.timestamp + 48 hours);
        vault.executeWithdraw(nonce);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeVault.BridgeVault_ClaimNotPending.selector, nonce)
        );
        vault.executeWithdraw(nonce);
    }

    function test_executeWithdraw_revertsOnPerClaimCap() public {
        // Per-claim cap = 1% of 1M ETX = 10K ETX. Submit a 20K-ETX claim.
        // Fund the user enough to lock 60K ETX so we have headroom.
        vm.prank(TREASURY);
        etx.transfer(USER, 100_000 * ONE);

        vm.prank(USER);
        vault.deposit(uint128(60_000 * ONE), ETH_DOMAIN, RECIPIENT_ETH);

        bytes32 nonce = bytes32(uint256(0x20));
        bytes memory body = abi.encode(nonce, RECIPIENT_ETICA, uint128(20_000 * ONE));
        mailbox.deliverBurnMessage(ETH_DOMAIN, TRUSTED_MINTER_ETH, body);

        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeVault.BridgeVault_PerClaimCapExceeded.selector,
                uint128(20_000 * ONE),
                vault.currentPerClaimCap()
            )
        );
        vault.executeWithdraw(nonce);
    }

    function test_executeWithdraw_revertsOnDailyRateLimit() public {
        // Daily cap = 5% of 1M ETX = 50K ETX. Submit 6 claims of 10K each
        // (each at the per-claim cap). Sixth one should bounce.
        vm.prank(TREASURY);
        etx.transfer(USER, 200_000 * ONE);

        vm.prank(USER);
        vault.deposit(uint128(120_000 * ONE), ETH_DOMAIN, RECIPIENT_ETH);

        bytes32[] memory nonces = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) {
            nonces[i] = bytes32(uint256(0x100 + i));
            bytes memory body = abi.encode(nonces[i], RECIPIENT_ETICA, uint128(10_000 * ONE));
            mailbox.deliverBurnMessage(ETH_DOMAIN, TRUSTED_MINTER_ETH, body);
        }

        vm.warp(block.timestamp + 48 hours);

        for (uint256 i = 0; i < 5; i++) {
            vault.executeWithdraw(nonces[i]);
        }
        // 6th should exceed daily cap
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeVault.BridgeVault_RateLimitExceeded.selector,
                uint128(60_000 * ONE),
                vault.currentDailyCap()
            )
        );
        vault.executeWithdraw(nonces[5]);
    }

    function test_executeWithdraw_dailyCounterResets() public {
        // Submit and execute one claim; advance to next UTC day; submit and
        // execute another claim that would exceed the daily cap if not reset.
        vm.prank(TREASURY);
        etx.transfer(USER, 200_000 * ONE);

        vm.prank(USER);
        vault.deposit(uint128(120_000 * ONE), ETH_DOMAIN, RECIPIENT_ETH);

        // First claim
        bytes32 n1 = bytes32(uint256(0x200));
        bytes memory b1 = abi.encode(n1, RECIPIENT_ETICA, uint128(10_000 * ONE));
        mailbox.deliverBurnMessage(ETH_DOMAIN, TRUSTED_MINTER_ETH, b1);

        vm.warp(block.timestamp + 48 hours);
        vault.executeWithdraw(n1);
        assertEq(vault.withdrawnTodayEtx(), 10_000 * ONE);

        // Advance to next UTC day
        vm.warp(block.timestamp + 1 days);

        // Second claim
        bytes32 n2 = bytes32(uint256(0x201));
        bytes memory b2 = abi.encode(n2, RECIPIENT_ETICA, uint128(10_000 * ONE));
        mailbox.deliverBurnMessage(ETH_DOMAIN, TRUSTED_MINTER_ETH, b2);

        vm.warp(block.timestamp + 48 hours);
        vault.executeWithdraw(n2);
        // Counter reset to 10K (just this withdrawal).
        assertEq(vault.withdrawnTodayEtx(), 10_000 * ONE);
    }

    function test_executeWithdraw_revertsWhenPaused() public {
        bytes32 nonce = bytes32(uint256(0x30));
        _seedAndSubmitClaim(nonce, uint128(5 * ONE));
        vm.warp(block.timestamp + 48 hours);

        vm.prank(OWNER);
        vault.emergencyPause();

        vm.expectRevert(BridgeVault.BridgeVault_Paused.selector);
        vault.executeWithdraw(nonce);
    }

    /* -------------------------------------------------------------------- */
    /*                              VETO                                    */
    /* -------------------------------------------------------------------- */

    function test_vetoWithdraw_happyPath() public {
        bytes32 nonce = bytes32(uint256(0x40));
        _seedAndSubmitClaim(nonce, uint128(5 * ONE));

        vm.expectEmit(true, true, false, true, address(vault));
        emit BridgeVault.WithdrawVetoed(nonce, VETO_AUTH);
        vm.prank(VETO_AUTH);
        vault.vetoWithdraw(nonce);

        (,,, BridgeVault.ClaimState state) = vault.claims(nonce);
        assertEq(uint8(state), uint8(BridgeVault.ClaimState.VETOED));

        // Cannot execute later.
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeVault.BridgeVault_ClaimNotPending.selector, nonce)
        );
        vault.executeWithdraw(nonce);
    }

    function test_vetoWithdraw_revertsForNonAuthority() public {
        bytes32 nonce = bytes32(uint256(0x41));
        _seedAndSubmitClaim(nonce, uint128(5 * ONE));
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeVault.BridgeVault_OnlyVetoAuthority.selector, ATTACKER)
        );
        vault.vetoWithdraw(nonce);
    }

    function test_vetoWithdraw_revertsAfterMaturity() public {
        bytes32 nonce = bytes32(uint256(0x42));
        _seedAndSubmitClaim(nonce, uint128(5 * ONE));
        vm.warp(block.timestamp + 48 hours);
        vm.prank(VETO_AUTH);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeVault.BridgeVault_AlreadyMatured.selector, uint64(block.timestamp)
            )
        );
        vault.vetoWithdraw(nonce);
    }

    function test_vetoWithdraw_revertsForExecutedClaim() public {
        bytes32 nonce = bytes32(uint256(0x43));
        _seedAndSubmitClaim(nonce, uint128(5 * ONE));
        vm.warp(block.timestamp + 48 hours);
        vault.executeWithdraw(nonce);
        // Even though now matured, state is EXECUTED, so veto fails on
        // ClaimNotPending before AlreadyMatured (state-check first).
        vm.prank(VETO_AUTH);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeVault.BridgeVault_ClaimNotPending.selector, nonce)
        );
        vault.vetoWithdraw(nonce);
    }

    /* -------------------------------------------------------------------- */
    /*                              EMERGENCY                               */
    /* -------------------------------------------------------------------- */

    function test_emergencyPause_onlyOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        vault.emergencyPause();
    }

    function test_emergencyPause_revertsIfAlreadyPaused() public {
        vm.prank(OWNER);
        vault.emergencyPause();
        vm.prank(OWNER);
        vm.expectRevert(BridgeVault.BridgeVault_Paused.selector);
        vault.emergencyPause();
    }

    function test_unpause_requiresTimelock() public {
        vm.prank(OWNER);
        vault.emergencyPause();
        vm.prank(OWNER);
        uint256 id = vault.requestUnpause();

        // Before timelock: revert
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeVault.BridgeVault_OpTimelockNotElapsed.selector,
                uint64(block.timestamp + OP_TIMELOCK),
                uint64(block.timestamp)
            )
        );
        vault.executeOp(id);

        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vault.executeOp(id);
        assertFalse(vault.paused());
    }

    function test_requestUnpause_revertsWhenNotPaused() public {
        vm.prank(OWNER);
        vm.expectRevert(BridgeVault.BridgeVault_NotPaused.selector);
        vault.requestUnpause();
    }

    /* -------------------------------------------------------------------- */
    /*                       OWNER TIMELOCKED OPS                           */
    /* -------------------------------------------------------------------- */

    function test_requestSetVetoAuthority_revertsOnZero() public {
        vm.prank(OWNER);
        vm.expectRevert(BridgeVault.BridgeVault_ZeroAddress.selector);
        vault.requestSetVetoAuthority(address(0));
    }

    function test_requestSetVetoAuthority_revertsForNonOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        vault.requestSetVetoAuthority(VETO_AUTH);
    }

    function test_requestSetBridgeFeeBps_revertsAboveCap() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeVault.BridgeVault_FeeBpsTooHigh.selector, uint16(101), uint16(100)
            )
        );
        vault.requestSetBridgeFeeBps(101);
    }

    function test_requestSetRateLimits_revertsAboveDailyCap() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeVault.BridgeVault_DailyCapTooHigh.selector, uint128(1001), uint128(1000)
            )
        );
        vault.requestSetRateLimits(1001, 100);
    }

    function test_requestSetRateLimits_revertsAbovePerClaimCap() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeVault.BridgeVault_PerClaimCapTooHigh.selector, uint128(501), uint128(500)
            )
        );
        vault.requestSetRateLimits(500, 501);
    }

    function test_requestSetChallengeWindow_revertsBelowMin() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeVault.BridgeVault_ChallengeWindowOutOfBounds.selector, uint64(0)
            )
        );
        vault.requestSetChallengeWindow(0);
    }

    function test_requestSetChallengeWindow_revertsAboveMax() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeVault.BridgeVault_ChallengeWindowOutOfBounds.selector, uint64(15 days)
            )
        );
        vault.requestSetChallengeWindow(15 days);
    }

    function test_executeOp_appliesNewVetoAuthority() public {
        address NEW_AUTH = address(0xDEAD11);
        vm.prank(OWNER);
        uint256 id = vault.requestSetVetoAuthority(NEW_AUTH);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vault.executeOp(id);
        assertEq(vault.vetoAuthority(), NEW_AUTH);
    }

    function test_executeOp_appliesNewBridgeFee() public {
        vm.prank(OWNER);
        uint256 id = vault.requestSetBridgeFeeBps(50);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vault.executeOp(id);
        assertEq(vault.bridgeFeeBps(), 50);
    }

    function test_executeOp_appliesNewRateLimits() public {
        vm.prank(OWNER);
        uint256 id = vault.requestSetRateLimits(1000, 500);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vault.executeOp(id);
        assertEq(vault.dailyWithdrawCapBps(), 1000);
        assertEq(vault.perClaimCapBps(), 500);
    }

    function test_executeOp_appliesNewChallengeWindow() public {
        vm.prank(OWNER);
        uint256 id = vault.requestSetChallengeWindow(72 hours);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vault.executeOp(id);
        assertEq(vault.challengeWindowSeconds(), 72 hours);
    }

    function test_executeOp_appliesAllowedDestDomain() public {
        uint32 NEW_DOMAIN = 137;
        vm.prank(OWNER);
        uint256 id = vault.requestSetAllowedDestDomain(NEW_DOMAIN, true);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vault.executeOp(id);
        assertTrue(vault.allowedDestDomain(NEW_DOMAIN));
    }

    function test_executeOp_appliesTrustedMinter() public {
        bytes32 NEW_MINTER = bytes32(uint256(0xCAFEFEED));
        vm.prank(OWNER);
        uint256 id = vault.requestSetTrustedMinter(BNB_DOMAIN, NEW_MINTER);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vault.executeOp(id);
        assertEq(vault.trustedMinter(BNB_DOMAIN), NEW_MINTER);
    }

    function test_executeOp_revertsOnInvalidId() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.BridgeVault_InvalidOpId.selector, 9999));
        vault.executeOp(9999);
    }

    function test_executeOp_revertsOnDoubleExecute() public {
        vm.prank(OWNER);
        uint256 id = vault.requestSetBridgeFeeBps(50);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vault.executeOp(id);

        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeVault.BridgeVault_OpAlreadyExecuted.selector, id)
        );
        vault.executeOp(id);
    }

    function test_cancelOp_blocksExecute() public {
        vm.prank(OWNER);
        uint256 id = vault.requestSetBridgeFeeBps(50);
        vm.prank(OWNER);
        vault.cancelOp(id);

        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeVault.BridgeVault_OpAlreadyCancelled.selector, id)
        );
        vault.executeOp(id);
    }

    function test_cancelOp_revertsAfterExecute() public {
        vm.prank(OWNER);
        uint256 id = vault.requestSetBridgeFeeBps(50);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vault.executeOp(id);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeVault.BridgeVault_OpAlreadyExecuted.selector, id)
        );
        vault.cancelOp(id);
    }

    /* -------------------------------------------------------------------- */
    /*                                VIEWS                                 */
    /* -------------------------------------------------------------------- */

    function test_currentCaps_track_tvlCap() public view {
        // Per-claim cap = 1% of 1M ETX = 10K ETX
        // Daily cap = 5% of 1M ETX = 50K ETX
        assertEq(vault.currentPerClaimCap(), 10_000 * ONE);
        assertEq(vault.currentDailyCap(), 50_000 * ONE);
    }
}
