// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test use only. A real EntryPoint v0.7 paymaster: validates a signature from its service and pays from its deposit.

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

contract TestVerifyingPaymaster {
    // paymaster (20) + paymasterVerificationGasLimit (16) + paymasterPostOpGasLimit (16)
    uint256 private constant SIGNATURE_OFFSET = 52;
    uint256 private constant SIG_VALIDATION_FAILED = 1;

    address public immutable entryPoint;
    address public immutable signer;

    constructor(address entryPoint_, address signer_) {
        entryPoint = entryPoint_;
        signer = signer_;
    }

    function getHash(PackedUserOperation calldata op) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                keccak256(op.paymasterAndData[20:SIGNATURE_OFFSET]),
                op.preVerificationGas,
                op.gasFees,
                block.chainid,
                address(this)
            )
        );
    }

    function validatePaymasterUserOp(PackedUserOperation calldata op, bytes32, uint256)
        external
        view
        returns (bytes memory context, uint256 validationData)
    {
        require(msg.sender == entryPoint, "not entrypoint");
        bytes calldata signature = op.paymasterAndData[SIGNATURE_OFFSET:];
        if (signature.length != 65) return ("", SIG_VALIDATION_FAILED);
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", getHash(op)));
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        return ("", ecrecover(digest, v, r, s) == signer ? 0 : SIG_VALIDATION_FAILED);
    }

    function postOp(uint8, bytes calldata, uint256, uint256) external {}
}
