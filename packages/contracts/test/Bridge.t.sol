// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Pausable} from "openzeppelin-contracts/contracts/utils/Pausable.sol";

import {MultisigVerifier} from "../src/bridge/MultisigVerifier.sol";
import {IAttestationVerifier} from "../src/bridge/interfaces/IAttestationVerifier.sol";
import {WrappedETI} from "../src/bridge/WrappedETI.sol";
import {EthereumBridgeMinter} from "../src/bridge/EthereumBridgeMinter.sol";
import {EticaBridgeVault} from "../src/bridge/EticaBridgeVault.sol";

contract MockETI is ERC20 {
    constructor() ERC20("Etica", "ETI") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract BridgeTest is Test {
    uint256 constant ETICA_CHAIN = 61803;
    uint256 constant ETH_CHAIN = 1;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address user = makeAddr("user");
    address ethRecipient = makeAddr("ethRecipient");
    address eticaRecipient = makeAddr("eticaRecipient");

    uint256 v1Pk = 0xA11CE;
    uint256 v2Pk = 0xB0B;
    uint256 v3Pk = 0xC411;
    uint256 outsiderPk = 0xDEADBEEF;
    address v1 = vm.addr(v1Pk);
    address v2 = vm.addr(v2Pk);
    address v3 = vm.addr(v3Pk);
    address outsider = vm.addr(outsiderPk);

    MultisigVerifier eticaVerifier;
    MultisigVerifier ethVerifier;
    MockETI eti;
    EticaBridgeVault vault;
    WrappedETI weti;
    EthereumBridgeMinter minter;

    function setUp() public {
        address[] memory vs = new address[](3);
        vs[0] = v1;
        vs[1] = v2;
        vs[2] = v3;

        eticaVerifier = new MultisigVerifier(owner, vs, 2);
        ethVerifier = new MultisigVerifier(owner, vs, 2);

        eti = new MockETI();
        eti.mint(user, 1_000_000e18);

        vault = new EticaBridgeVault(
            owner,
            eti,
            eticaVerifier,
            treasury,
            10, // 0.10%
            500_000e18,
            ETH_CHAIN
        );

        weti = new WrappedETI(owner);
        minter = new EthereumBridgeMinter(
            owner, weti, ethVerifier, treasury, 10, 500_000e18, ETICA_CHAIN
        );
        vm.prank(owner);
        weti.setMinter(address(minter));
    }

    // --- helpers --------------------------------------------------------

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethHash);
        return abi.encodePacked(r, s, v);
    }

    // --- MultisigVerifier ----------------------------------------------

    function testVerifierHappyPath() public view {
        bytes32 digest = keccak256("hello");
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(v1Pk, digest);
        sigs[1] = _sign(v2Pk, digest);
        eticaVerifier.verify(digest, sigs);
    }

    function testVerifierRejectsOutsiderSig() public {
        bytes32 digest = keccak256("hello");
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(v1Pk, digest);
        sigs[1] = _sign(outsiderPk, digest);
        vm.expectRevert(abi.encodeWithSelector(MultisigVerifier.NotAValidator.selector, outsider));
        eticaVerifier.verify(digest, sigs);
    }

    function testVerifierRejectsDuplicateSigner() public {
        bytes32 digest = keccak256("hello");
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(v1Pk, digest);
        sigs[1] = _sign(v1Pk, digest);
        vm.expectRevert(abi.encodeWithSelector(MultisigVerifier.DuplicateSigner.selector, v1));
        eticaVerifier.verify(digest, sigs);
    }

    function testVerifierRejectsInsufficientSigs() public {
        bytes32 digest = keccak256("hello");
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(v1Pk, digest);
        vm.expectRevert(
            abi.encodeWithSelector(MultisigVerifier.InsufficientSignatures.selector, 1, 2)
        );
        eticaVerifier.verify(digest, sigs);
    }

    function testVerifierAddRemoveValidator() public {
        address v4 = vm.addr(0xD00D);
        vm.prank(owner);
        eticaVerifier.addValidator(v4);
        assertTrue(eticaVerifier.isValidator(v4));
        assertEq(eticaVerifier.validatorCount(), 4);

        vm.prank(owner);
        eticaVerifier.removeValidator(v4);
        assertFalse(eticaVerifier.isValidator(v4));
        assertEq(eticaVerifier.validatorCount(), 3);
    }

    function testVerifierCannotShrinkBelowThreshold() public {
        vm.prank(owner);
        eticaVerifier.removeValidator(v3); // 3→2, still ≥ threshold=2
        vm.prank(owner);
        vm.expectRevert(MultisigVerifier.ThresholdOutOfRange.selector);
        eticaVerifier.removeValidator(v2); // would drop to 1 < threshold
    }

    function testVerifierSetThreshold() public {
        vm.prank(owner);
        eticaVerifier.setThreshold(3);
        assertEq(eticaVerifier.threshold(), 3);

        vm.prank(owner);
        vm.expectRevert(MultisigVerifier.ThresholdOutOfRange.selector);
        eticaVerifier.setThreshold(4);
    }

    function testVerifierOnlyOwnerCanManage() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        eticaVerifier.addValidator(makeAddr("x"));
    }

    // --- Etica→Ethereum round trip -------------------------------------

    function testDepositThenMint() public {
        uint256 amount = 1_000e18;

        vm.startPrank(user);
        eti.approve(address(vault), amount);
        vm.recordLogs();
        bytes32 nonce = vault.deposit(amount, ethRecipient);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        vm.stopPrank();

        // Deposit took exactly `amount` and accrued fee
        assertEq(eti.balanceOf(address(vault)), amount);
        assertEq(vault.accruedFees(), (amount * 10) / 10_000);

        // Mint on the Ethereum side with an attestation of that nonce
        bytes32 srcTxHash = logs[logs.length - 1].topics.length > 0
            ? keccak256(abi.encode(block.number, nonce))
            : bytes32(uint256(1));

        bytes32 digest = minter.buildDigest(
            ETICA_CHAIN, block.chainid, srcTxHash, nonce, address(weti), amount, ethRecipient
        );
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(v1Pk, digest);
        sigs[1] = _sign(v2Pk, digest);

        minter.mint(ETICA_CHAIN, srcTxHash, nonce, amount, ethRecipient, sigs);

        uint256 fee = (amount * 10) / 10_000;
        assertEq(weti.balanceOf(ethRecipient), amount - fee);
        assertEq(weti.balanceOf(treasury), fee);
        assertTrue(minter.processed(nonce));
    }

    function testMintReplayRejected() public {
        uint256 amount = 1_000e18;
        bytes32 srcTx = keccak256("srcTx");
        bytes32 nonce = keccak256("nonce");
        bytes32 digest = minter.buildDigest(
            ETICA_CHAIN, block.chainid, srcTx, nonce, address(weti), amount, ethRecipient
        );
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(v1Pk, digest);
        sigs[1] = _sign(v2Pk, digest);

        minter.mint(ETICA_CHAIN, srcTx, nonce, amount, ethRecipient, sigs);

        vm.expectRevert(
            abi.encodeWithSelector(EthereumBridgeMinter.AlreadyProcessed.selector, nonce)
        );
        minter.mint(ETICA_CHAIN, srcTx, nonce, amount, ethRecipient, sigs);
    }

    function testMintWrongChainRejected() public {
        uint256 amount = 1_000e18;
        bytes32 srcTx = keccak256("srcTx");
        bytes32 nonce = keccak256("nonce");
        bytes32 digest = minter.buildDigest(
            999, block.chainid, srcTx, nonce, address(weti), amount, ethRecipient
        );
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(v1Pk, digest);
        sigs[1] = _sign(v2Pk, digest);

        vm.expectRevert(
            abi.encodeWithSelector(EthereumBridgeMinter.ChainMismatch.selector, ETICA_CHAIN, 999)
        );
        minter.mint(999, srcTx, nonce, amount, ethRecipient, sigs);
    }

    function testMintDailyLimit() public {
        uint256 cap = 500_000e18;
        vm.prank(owner);
        minter.setDailyLimit(cap);

        bytes32 srcTx = keccak256("srcTx-1");
        bytes32 nonce1 = keccak256("nonce-1");
        bytes32 digest1 = minter.buildDigest(
            ETICA_CHAIN, block.chainid, srcTx, nonce1, address(weti), cap, ethRecipient
        );
        bytes[] memory sigs1 = new bytes[](2);
        sigs1[0] = _sign(v1Pk, digest1);
        sigs1[1] = _sign(v2Pk, digest1);
        minter.mint(ETICA_CHAIN, srcTx, nonce1, cap, ethRecipient, sigs1);

        bytes32 nonce2 = keccak256("nonce-2");
        bytes32 digest2 = minter.buildDigest(
            ETICA_CHAIN, block.chainid, srcTx, nonce2, address(weti), 1, ethRecipient
        );
        bytes[] memory sigs2 = new bytes[](2);
        sigs2[0] = _sign(v1Pk, digest2);
        sigs2[1] = _sign(v2Pk, digest2);
        vm.expectRevert(
            abi.encodeWithSelector(EthereumBridgeMinter.DailyLimitExceeded.selector, 1, 0)
        );
        minter.mint(ETICA_CHAIN, srcTx, nonce2, 1, ethRecipient, sigs2);

        // After a day elapses, the bucket resets.
        vm.warp(block.timestamp + 1 days + 1);
        minter.mint(ETICA_CHAIN, srcTx, nonce2, 1, ethRecipient, sigs2);
    }

    // --- Ethereum→Etica round trip -------------------------------------

    function testBurnThenWithdraw() public {
        // Pre-fund vault with ETI (as if a prior deposit happened)
        uint256 amount = 1_000e18;
        eti.mint(address(vault), amount);

        // Mint some wETI to user first so they can burn
        vm.prank(address(minter));
        weti.mint(user, amount);

        // Burn on Ethereum side
        vm.recordLogs();
        vm.prank(user);
        bytes32 nonce = minter.burn(amount, eticaRecipient);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(weti.balanceOf(user), 0);
        assertEq(weti.totalSupply(), 0);
        bytes32 srcTxHash = keccak256(abi.encode(logs.length));

        // Withdraw on Etica side against attestation
        bytes32 digest = vault.buildDigest(
            ETH_CHAIN, block.chainid, srcTxHash, nonce, address(eti), amount, eticaRecipient
        );
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(v1Pk, digest);
        sigs[1] = _sign(v2Pk, digest);

        vault.withdraw(ETH_CHAIN, srcTxHash, nonce, amount, eticaRecipient, sigs);
        assertEq(eti.balanceOf(eticaRecipient), amount);
        assertTrue(vault.processed(nonce));
    }

    function testWithdrawReplayRejected() public {
        uint256 amount = 1_000e18;
        eti.mint(address(vault), amount);

        bytes32 srcTx = keccak256("eth-tx");
        bytes32 nonce = keccak256("eth-nonce");
        bytes32 digest = vault.buildDigest(
            ETH_CHAIN, block.chainid, srcTx, nonce, address(eti), amount, eticaRecipient
        );
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(v1Pk, digest);
        sigs[1] = _sign(v2Pk, digest);

        vault.withdraw(ETH_CHAIN, srcTx, nonce, amount, eticaRecipient, sigs);

        vm.expectRevert(abi.encodeWithSelector(EticaBridgeVault.AlreadyProcessed.selector, nonce));
        vault.withdraw(ETH_CHAIN, srcTx, nonce, amount, eticaRecipient, sigs);
    }

    // --- fees + skim ----------------------------------------------------

    function testFeeAccrualAndSkim() public {
        uint256 amount = 10_000e18;
        uint256 expectedFee = (amount * 10) / 10_000;

        vm.startPrank(user);
        eti.approve(address(vault), amount);
        vault.deposit(amount, ethRecipient);
        vm.stopPrank();

        assertEq(vault.accruedFees(), expectedFee);

        uint256 beforeBal = eti.balanceOf(treasury);
        vault.skim();
        assertEq(eti.balanceOf(treasury), beforeBal + expectedFee);
        assertEq(vault.accruedFees(), 0);
    }

    function testFeeCapEnforced() public {
        vm.prank(owner);
        vm.expectRevert(EticaBridgeVault.FeeTooHigh.selector);
        vault.setFeeBps(101);
    }

    // --- pause ----------------------------------------------------------

    function testPauseBlocksDepositAndMint() public {
        vm.prank(owner);
        vault.pause();
        vm.startPrank(user);
        eti.approve(address(vault), 1e18);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(1e18, ethRecipient);
        vm.stopPrank();

        vm.prank(owner);
        minter.pause();
        bytes32 digest = minter.buildDigest(
            ETICA_CHAIN, block.chainid, bytes32(0), bytes32(0), address(weti), 1e18, ethRecipient
        );
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(v1Pk, digest);
        sigs[1] = _sign(v2Pk, digest);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        minter.mint(ETICA_CHAIN, bytes32(0), bytes32(0), 1e18, ethRecipient, sigs);
    }

    // --- verifier swap --------------------------------------------------

    function testVerifierSwap() public {
        address[] memory vs = new address[](1);
        vs[0] = v1;
        MultisigVerifier newVerifier = new MultisigVerifier(owner, vs, 1);
        vm.prank(owner);
        vault.setVerifier(newVerifier);
        assertEq(address(vault.verifier()), address(newVerifier));

        // A single v1 sig is now sufficient
        uint256 amount = 1_000e18;
        eti.mint(address(vault), amount);
        bytes32 srcTx = keccak256("swap-tx");
        bytes32 nonce = keccak256("swap-nonce");
        bytes32 digest = vault.buildDigest(
            ETH_CHAIN, block.chainid, srcTx, nonce, address(eti), amount, eticaRecipient
        );
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(v1Pk, digest);
        vault.withdraw(ETH_CHAIN, srcTx, nonce, amount, eticaRecipient, sigs);
        assertEq(eti.balanceOf(eticaRecipient), amount);
    }

    // --- WrappedETI -----------------------------------------------------

    function testOnlyMinterCanMintAndBurn() public {
        vm.expectRevert(WrappedETI.NotMinter.selector);
        weti.mint(user, 1);

        vm.expectRevert(WrappedETI.NotMinter.selector);
        weti.burnFrom(user, 1);
    }
}
