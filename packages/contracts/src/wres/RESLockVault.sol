// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title RESLockVault — Etica-side escrow for wrapping a RES NFT into a TRON energy-miner twin
///
/// @notice An Etica user locks their {EticaResearchNFT} (RES) here to "wrap" it.
///         The keeper observes the {Locked} event and mints the TRON-side
///         `WrappedRESMiner` twin bound to the user's TRON wallet + ETX payout
///         wallet. The RES NFT itself NEVER leaves Etica and its on-chain
///         scientific record is never copied — only the token is escrowed.
///
/// @dev    LOCK, NEVER BURN. Burning a RES NFT would permanently freeze its
///         royalty splitter (its `release` reverts once `ownerOf` reverts), so
///         the twin is backed by a *locked* RES, recoverable in full. While
///         locked, the vault is the holder and keeps receiving that token's
///         royalty leg.
///
/// @dev    DRAIN-PROOF BY CONSTRUCTION. A locked RES can only ever be returned
///         to the address that locked it (`l.owner`) — there is NO path to send
///         an escrowed NFT to an arbitrary address, not even for the owner or
///         keeper. So a compromised keeper cannot steal NFTs; the worst it can
///         do is return them to their rightful lockers. Two exit paths, both
///         terminating at `l.owner`:
///
///           1. keeperUnlock — the keeper confirms the TRON twin was burned and
///              releases immediately (the happy path).
///           2. requestUnlock → (challengeWindow) → executeUnlock — a
///              permissionless liveness escape so a user is never trapped if the
///              keeper disappears. The `vetoAuthority` can cancel a pending
///              request if the twin is still mining on TRON (prevents an exit
///              while the twin still exists, i.e. a double-claim).
///
///         No admin can pause or seize. Owner only wires keeper/veto/window.
contract RESLockVault is Ownable2Step, ReentrancyGuard, IERC721Receiver {
    /* --------------------------------------------------------------------- */
    /*                              CONSTANTS                                 */
    /* --------------------------------------------------------------------- */

    uint64 public constant MIN_CHALLENGE_WINDOW = 1 hours;
    uint64 public constant MAX_CHALLENGE_WINDOW = 14 days;

    /* --------------------------------------------------------------------- */
    /*                               STORAGE                                 */
    /* --------------------------------------------------------------------- */

    /// @notice The RES NFT collection being escrowed.
    IERC721 public immutable resNft;

    /// @notice Confirms TRON-side twin burns and triggers releases.
    address public keeper;

    /// @notice May cancel a pending owner-initiated unlock while the twin is
    ///         still live on TRON (anti double-claim). Distinct from `owner`.
    address public vetoAuthority;

    /// @notice Delay before an owner-initiated unlock can be executed.
    uint64 public challengeWindow = 48 hours;

    struct Lock {
        address owner; // who locked it — the ONLY valid release target
        address payoutWallet; // Etica (0x) wallet ETX is delivered to
        address tronRecipient; // TRON wallet that receives the minted twin
        uint64 lockedAt;
        uint64 unlockReadyAt; // 0 = no pending unlock request
        bool active;
    }

    /// @notice resTokenId => lock record.
    mapping(uint256 => Lock) public locks;

    /// @notice Number of RES NFTs currently escrowed (== outstanding twins the
    ///         keeper must maintain).
    uint256 public totalLocked;

    /* --------------------------------------------------------------------- */
    /*                                EVENTS                                  */
    /* --------------------------------------------------------------------- */

    event Locked(
        uint256 indexed resTokenId,
        address indexed owner,
        address indexed tronRecipient,
        address payoutWallet
    );
    event PayoutWalletUpdated(uint256 indexed resTokenId, address newWallet);
    event UnlockRequested(uint256 indexed resTokenId, uint64 readyAt);
    event UnlockVetoed(uint256 indexed resTokenId);
    event Unlocked(uint256 indexed resTokenId, address indexed to, bool viaKeeper);
    event KeeperUpdated(address keeper);
    event VetoAuthorityUpdated(address vetoAuthority);
    event ChallengeWindowUpdated(uint64 window);

    /* --------------------------------------------------------------------- */
    /*                                ERRORS                                 */
    /* --------------------------------------------------------------------- */

    error ZeroAddress();
    error NotKeeper();
    error NotVetoAuthority();
    error NotLockOwner();
    error NotActive();
    error AlreadyActive();
    error NoUnlockRequest();
    error UnlockNotReady();
    error WindowOutOfRange();
    error DirectTransferNotAllowed();

    /* --------------------------------------------------------------------- */
    /*                              MODIFIERS                                 */
    /* --------------------------------------------------------------------- */

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    constructor(address _resNft, address _owner, address _keeper) Ownable(_owner) {
        if (_resNft == address(0) || _keeper == address(0)) revert ZeroAddress();
        resNft = IERC721(_resNft);
        keeper = _keeper;
        vetoAuthority = _owner;
    }

    /* --------------------------------------------------------------------- */
    /*                                 LOCK                                   */
    /* --------------------------------------------------------------------- */

    /// @notice Lock a RES NFT to wrap it. The caller must own `resTokenId` and
    ///         have approved this vault. Emits {Locked} for the keeper to mint
    ///         the TRON twin against.
    /// @param resTokenId    The RES tokenId to escrow.
    /// @param payoutWallet  Etica (0x) wallet that will receive ETX yield.
    /// @param tronRecipient TRON wallet that should own the minted twin.
    function lock(uint256 resTokenId, address payoutWallet, address tronRecipient)
        external
        nonReentrant
    {
        if (payoutWallet == address(0) || tronRecipient == address(0)) {
            revert ZeroAddress();
        }
        if (locks[resTokenId].active) revert AlreadyActive();

        locks[resTokenId] = Lock({
            owner: msg.sender,
            payoutWallet: payoutWallet,
            tronRecipient: tronRecipient,
            lockedAt: uint64(block.timestamp),
            unlockReadyAt: 0,
            active: true
        });
        totalLocked += 1;

        // Pull the NFT in. Reverts unless caller owns + approved. `_locking`
        // gates {onERC721Received} so only this path can deposit.
        _locking = true;
        resNft.safeTransferFrom(msg.sender, address(this), resTokenId);
        _locking = false;

        emit Locked(resTokenId, msg.sender, tronRecipient, payoutWallet);
    }

    /// @notice Update the ETX payout wallet for a lock. Only the locker. The
    ///         keeper mirrors this to the twin's `payoutWallet` on TRON.
    function setPayoutWallet(uint256 resTokenId, address newWallet) external {
        Lock storage l = locks[resTokenId];
        if (!l.active) revert NotActive();
        if (msg.sender != l.owner) revert NotLockOwner();
        if (newWallet == address(0)) revert ZeroAddress();
        l.payoutWallet = newWallet;
        emit PayoutWalletUpdated(resTokenId, newWallet);
    }

    /* --------------------------------------------------------------------- */
    /*                                UNLOCK                                  */
    /* --------------------------------------------------------------------- */

    /// @notice Keeper-confirmed unlock: the TRON twin has been burned, so the
    ///         RES is released back to its locker. Always returns to `l.owner`.
    function keeperUnlock(uint256 resTokenId) external nonReentrant onlyKeeper {
        Lock storage l = locks[resTokenId];
        if (!l.active) revert NotActive();
        _release(resTokenId, l.owner, true);
    }

    /// @notice Liveness escape: the locker requests an unlock that becomes
    ///         executable after `challengeWindow`. Protects users if the keeper
    ///         disappears. The `vetoAuthority` may cancel it if the twin is
    ///         still live on TRON.
    function requestUnlock(uint256 resTokenId) external {
        Lock storage l = locks[resTokenId];
        if (!l.active) revert NotActive();
        if (msg.sender != l.owner) revert NotLockOwner();
        l.unlockReadyAt = uint64(block.timestamp) + challengeWindow;
        emit UnlockRequested(resTokenId, l.unlockReadyAt);
    }

    /// @notice Cancel a pending unlock request (e.g. the twin is still mining).
    function vetoUnlock(uint256 resTokenId) external {
        if (msg.sender != vetoAuthority) revert NotVetoAuthority();
        Lock storage l = locks[resTokenId];
        if (l.unlockReadyAt == 0) revert NoUnlockRequest();
        l.unlockReadyAt = 0;
        emit UnlockVetoed(resTokenId);
    }

    /// @notice Execute a matured unlock request. Permissionless once ready;
    ///         always returns the RES to its locker.
    function executeUnlock(uint256 resTokenId) external nonReentrant {
        Lock storage l = locks[resTokenId];
        if (!l.active) revert NotActive();
        if (l.unlockReadyAt == 0) revert NoUnlockRequest();
        if (block.timestamp < l.unlockReadyAt) revert UnlockNotReady();
        _release(resTokenId, l.owner, false);
    }

    function _release(uint256 resTokenId, address to, bool viaKeeper) internal {
        delete locks[resTokenId];
        totalLocked -= 1;
        resNft.safeTransferFrom(address(this), to, resTokenId);
        emit Unlocked(resTokenId, to, viaKeeper);
    }

    /* --------------------------------------------------------------------- */
    /*                                ADMIN                                  */
    /* --------------------------------------------------------------------- */

    function setKeeper(address _keeper) external onlyOwner {
        if (_keeper == address(0)) revert ZeroAddress();
        keeper = _keeper;
        emit KeeperUpdated(_keeper);
    }

    function setVetoAuthority(address _veto) external onlyOwner {
        if (_veto == address(0)) revert ZeroAddress();
        vetoAuthority = _veto;
        emit VetoAuthorityUpdated(_veto);
    }

    function setChallengeWindow(uint64 _window) external onlyOwner {
        if (_window < MIN_CHALLENGE_WINDOW || _window > MAX_CHALLENGE_WINDOW) {
            revert WindowOutOfRange();
        }
        challengeWindow = _window;
        emit ChallengeWindowUpdated(_window);
    }

    /* --------------------------------------------------------------------- */
    /*                          ERC721 RECEIVER                              */
    /* --------------------------------------------------------------------- */

    /// @dev Set only for the duration of {lock}'s pull, so stray/direct
    ///      `safeTransferFrom`s into the vault are rejected (no orphan NFTs).
    bool private _locking;

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (!_locking) revert DirectTransferNotAllowed();
        return IERC721Receiver.onERC721Received.selector;
    }
}
