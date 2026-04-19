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
    uint16 constant FEE_BPS = 10; // 0.10%
    uint256 constant CAP = 500_000e18;

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

        vault = new EticaBridgeVault(owner, eti, eticaVerifier, treasury, FEE_BPS, CAP, ETH_CHAIN);

        weti = new WrappedETI(owner);
        minter =
            new EthereumBridgeMinter(owner, weti, ethVerifier, treasury, FEE_BPS, CAP, ETICA_CHAIN);
        vm.prank(owner);
        weti.setMinter(address(minter));
    }

    // --- helpers --------------------------------------------------------

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function _fee(uint256 amount) internal pure returns (uint256) {
        return (amount * FEE_BPS) / 10_000;
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
        eticaVerifier.removeValidator(v3);
        vm.prank(owner);
        vm.expectRevert(MultisigVerifier.ThresholdOutOfRange.selector);
        eticaVerifier.removeValidator(v2);
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
        bytes32 nonce = vault.deposit(amount, ethRecipient);
        vm.stopPrank();

        // Vault holds the full gross amount; no fee accrued on source side
        assertEq(eti.balanceOf(address(vault)), amount);

        bytes32 srcTxHash = keccak256(abi.encode(block.number, nonce));
        bytes32 digest = minter.buildDigest(
            ETICA_CHAIN, block.chainid, srcTxHash, nonce, address(weti), amount, ethRecipient
        );
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(v1Pk, digest);
        sigs[1] = _sign(v2Pk, digest);

        minter.mint(ETICA_CHAIN, srcTxHash, nonce, amount, ethRecipient, sigs);

        uint256 fee = _fee(amount);
        assertEq(weti.balanceOf(ethRecipient), amount - fee);
        assertEq(weti.balanceOf(treasury), fee);
        // Invariant: vault collateral == wETI supply
        assertEq(eti.balanceOf(address(vault)), weti.totalSupply());
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
        vm.prank(owner);
        minter.setDailyLimit(CAP);

        bytes32 srcTx = keccak256("srcTx-1");
        bytes32 nonce1 = keccak256("nonce-1");
        bytes32 digest1 = minter.buildDigest(
            ETICA_CHAIN, block.chainid, srcTx, nonce1, address(weti), CAP, ethRecipient
        );
        bytes[] memory sigs1 = new bytes[](2);
        sigs1[0] = _sign(v1Pk, digest1);
        sigs1[1] = _sign(v2Pk, digest1);
        minter.mint(ETICA_CHAIN, srcTx, nonce1, CAP, ethRecipient, sigs1);

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

        vm.warp(block.timestamp + 1 days + 1);
        minter.mint(ETICA_CHAIN, srcTx, nonce2, 1, ethRecipient, sigs2);
    }

    // --- Ethereum→Etica round trip -------------------------------------

    /// @dev Full round trip: deposit → mint → burn → withdraw.
    /// Checks the invariant `vault.ETI == wETI.supply` at every step and
    /// that the cumulative fees (one on mint, one on withdraw) equal the
    /// delta between gross user deposit and gross user receipt.
    function testRoundTripPreservesInvariant() public {
        uint256 amount = 1_000e18;

        // --- 1. deposit on Etica ---
        vm.startPrank(user);
        eti.approve(address(vault), amount);
        bytes32 depositNonce = vault.deposit(amount, ethRecipient);
        vm.stopPrank();

        assertEq(eti.balanceOf(address(vault)), amount);
        assertEq(weti.totalSupply(), 0);

        // --- 2. mint on Ethereum ---
        bytes32 mintTxHash = keccak256("mintTx");
        bytes32 mintDigest = minter.buildDigest(
            ETICA_CHAIN,
            block.chainid,
            mintTxHash,
            depositNonce,
            address(weti),
            amount,
            ethRecipient
        );
        bytes[] memory mintSigs = new bytes[](2);
        mintSigs[0] = _sign(v1Pk, mintDigest);
        mintSigs[1] = _sign(v2Pk, mintDigest);
        minter.mint(ETICA_CHAIN, mintTxHash, depositNonce, amount, ethRecipient, mintSigs);

        uint256 mintFee = _fee(amount);
        assertEq(weti.balanceOf(ethRecipient), amount - mintFee);
        assertEq(weti.balanceOf(treasury), mintFee);
        assertEq(weti.totalSupply(), amount);
        assertEq(eti.balanceOf(address(vault)), amount);
        // Invariant after mint
        assertEq(eti.balanceOf(address(vault)), weti.totalSupply());

        // --- 3. burn on Ethereum (user burns their net balance) ---
        uint256 burnAmount = weti.balanceOf(ethRecipient);
        vm.prank(ethRecipient);
        weti.approve(address(minter), burnAmount);
        vm.prank(ethRecipient);
        bytes32 burnNonce = minter.burn(burnAmount, eticaRecipient);

        assertEq(weti.balanceOf(ethRecipient), 0);
        // Treasury still holds its mint-fee share; supply == treasury's share now
        assertEq(weti.totalSupply(), mintFee);
        // Invariant after burn (vault over-collateralized by mintFee — that
        // exactly backs the treasury's mint-fee wETI, which is also bridgeable)
        assertGe(eti.balanceOf(address(vault)), weti.totalSupply());

        // --- 4. withdraw on Etica ---
        bytes32 burnTxHash = keccak256("burnTx");
        bytes32 wDigest = vault.buildDigest(
            ETH_CHAIN,
            block.chainid,
            burnTxHash,
            burnNonce,
            address(eti),
            burnAmount,
            eticaRecipient
        );
        bytes[] memory wSigs = new bytes[](2);
        wSigs[0] = _sign(v1Pk, wDigest);
        wSigs[1] = _sign(v2Pk, wDigest);
        vault.withdraw(ETH_CHAIN, burnTxHash, burnNonce, burnAmount, eticaRecipient, wSigs);

        uint256 wFee = _fee(burnAmount);
        assertEq(eti.balanceOf(eticaRecipient), burnAmount - wFee);
        assertEq(eti.balanceOf(treasury), wFee);
        // Vault released exactly `burnAmount`
        assertEq(eti.balanceOf(address(vault)), amount - burnAmount);
        // Core invariant still holds: vault collateral backs all outstanding
        // wETI (the treasury's mint-fee share that can still be bridged back)
        assertGe(eti.balanceOf(address(vault)), weti.totalSupply());
    }

    function testBurnRequiresApproval() public {
        uint256 amount = 1_000e18;
        eti.mint(address(vault), amount);

        vm.prank(address(minter));
        weti.mint(user, amount);

        // No approval → burn reverts on ERC20 allowance check
        vm.prank(user);
        vm.expectRevert();
        minter.burn(amount, eticaRecipient);
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

    // --- fee semantics --------------------------------------------------

    function testWithdrawFeeSplit() public {
        uint256 amount = 10_000e18;
        eti.mint(address(vault), amount);

        bytes32 srcTx = keccak256("fee-tx");
        bytes32 nonce = keccak256("fee-nonce");
        bytes32 digest = vault.buildDigest(
            ETH_CHAIN, block.chainid, srcTx, nonce, address(eti), amount, eticaRecipient
        );
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(v1Pk, digest);
        sigs[1] = _sign(v2Pk, digest);
        vault.withdraw(ETH_CHAIN, srcTx, nonce, amount, eticaRecipient, sigs);

        uint256 fee = _fee(amount);
        assertEq(eti.balanceOf(eticaRecipient), amount - fee);
        assertEq(eti.balanceOf(treasury), fee);
        assertEq(eti.balanceOf(address(vault)), 0);
    }

    function testFeeCapEnforced() public {
        vm.prank(owner);
        vm.expectRevert(EticaBridgeVault.FeeTooHigh.selector);
        vault.setFeeBps(101);

        vm.prank(owner);
        vm.expectRevert(EthereumBridgeMinter.FeeTooHigh.selector);
        minter.setFeeBps(101);
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
        uint256 fee = _fee(amount);
        assertEq(eti.balanceOf(eticaRecipient), amount - fee);
    }

    // --- WrappedETI -----------------------------------------------------

    function testOnlyMinterCanMintAndBurn() public {
        vm.expectRevert(WrappedETI.NotMinter.selector);
        weti.mint(user, 1);

        vm.expectRevert(WrappedETI.NotMinter.selector);
        weti.burnFrom(user, 1);
    }

    function testBurnFromSpendsAllowance() public {
        // Give user wETI
        uint256 amt = 100e18;
        vm.prank(address(minter));
        weti.mint(user, amt);

        // Minter attempts to burn without approval → should revert
        vm.prank(address(minter));
        vm.expectRevert();
        weti.burnFrom(user, amt);

        // User approves minter → burn succeeds and allowance is consumed
        vm.prank(user);
        weti.approve(address(minter), amt);

        vm.prank(address(minter));
        weti.burnFrom(user, amt);
        assertEq(weti.balanceOf(user), 0);
        assertEq(weti.allowance(user, address(minter)), 0);
    }
}
