// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title UnanimousMultisig
/// @notice Minimal N-of-N multisig: every owner must confirm a proposal before
///         it executes. Meant to hold admin roles (EticaSwap Direct
///         `feeToSetter`, harvester owner) so that no single key can change
///         fees, whitelist, deployer or retire/replace windows. Owners are
///         fixed at construction; to rotate signers, deploy a new multisig and
///         hand the roles over through this one.
contract UnanimousMultisig {
    struct Proposal {
        address target;
        uint256 value;
        bytes data;
        uint256 confirmations;
        bool executed;
        bool cancelled;
    }

    address[] public owners;
    mapping(address => bool) public isOwner;
    Proposal[] private _proposals;
    mapping(uint256 => mapping(address => bool)) public confirmed;

    event Proposed(
        uint256 indexed id, address indexed proposer, address target, uint256 value, bytes data
    );
    event Confirmed(uint256 indexed id, address indexed owner);
    event Revoked(uint256 indexed id, address indexed owner);
    event Executed(uint256 indexed id, bytes result);
    event Cancelled(uint256 indexed id, address indexed owner);

    modifier onlyOwner() {
        require(isOwner[msg.sender], "Multisig: NOT_OWNER");
        _;
    }

    constructor(address[] memory _owners) {
        require(_owners.length >= 2, "Multisig: NEED_TWO");
        for (uint256 i = 0; i < _owners.length; i++) {
            address o = _owners[i];
            require(o != address(0), "Multisig: ZERO_OWNER");
            require(!isOwner[o], "Multisig: DUP_OWNER");
            isOwner[o] = true;
            owners.push(o);
        }
    }

    receive() external payable {}

    function ownerCount() external view returns (uint256) {
        return owners.length;
    }

    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }

    function proposal(uint256 id) external view returns (Proposal memory) {
        return _proposals[id];
    }

    /// @notice Create a proposal; counts as the proposer's confirmation.
    function propose(address target, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (uint256 id)
    {
        require(target != address(0), "Multisig: ZERO_TARGET");
        id = _proposals.length;
        _proposals.push(
            Proposal({
                target: target,
                value: value,
                data: data,
                confirmations: 0,
                executed: false,
                cancelled: false
            })
        );
        emit Proposed(id, msg.sender, target, value, data);
        _confirm(id);
    }

    /// @notice Confirm; executes automatically once every owner has confirmed.
    function confirm(uint256 id) external onlyOwner {
        _confirm(id);
    }

    function revoke(uint256 id) external onlyOwner {
        Proposal storage p = _live(id);
        require(confirmed[id][msg.sender], "Multisig: NOT_CONFIRMED");
        confirmed[id][msg.sender] = false;
        p.confirmations -= 1;
        emit Revoked(id, msg.sender);
    }

    /// @notice Any single owner can kill a pending proposal: one "no" means no change.
    function cancel(uint256 id) external onlyOwner {
        Proposal storage p = _live(id);
        p.cancelled = true;
        emit Cancelled(id, msg.sender);
    }

    function _live(uint256 id) private view returns (Proposal storage p) {
        require(id < _proposals.length, "Multisig: NO_PROPOSAL");
        p = _proposals[id];
        require(!p.executed && !p.cancelled, "Multisig: CLOSED");
    }

    function _confirm(uint256 id) private {
        Proposal storage p = _live(id);
        require(!confirmed[id][msg.sender], "Multisig: ALREADY_CONFIRMED");
        confirmed[id][msg.sender] = true;
        p.confirmations += 1;
        emit Confirmed(id, msg.sender);
        if (p.confirmations == owners.length) {
            p.executed = true;
            (bool ok, bytes memory result) = p.target.call{value: p.value}(p.data);
            require(ok, "Multisig: CALL_FAILED");
            emit Executed(id, result);
        }
    }
}
