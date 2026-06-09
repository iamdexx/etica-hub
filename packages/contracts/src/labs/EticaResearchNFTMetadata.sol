// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @title EticaResearchNFTMetadata
/// @notice Off-contract metadata renderer for EticaResearchNFT. Pure
///         view-only library that builds the data-URI tokenURI from a
///         memory copy of the {Discovery} record + the deploying
///         contract's BASE_URL. Extracted from EticaResearchNFT.sol
///         to keep that contract under the EIP-170 24,576-byte runtime
///         size limit after the depth-25 ancestor cascade was added.
///
/// @dev    Pure-view; no state, no constants other than the score
///         denominator. Library deployed once and linked via
///         CREATE2 at the per-deploy library address. All callers
///         pass a memory-copy of Discovery; no storage access.
library EticaResearchNFTMetadata {
    using Strings for uint256;
    using Strings for address;

    uint256 private constant SCORE_DENOM = 10_000;

    /// @notice Mirror of {EticaResearchNFT.Discovery}. The NFT contract
    ///         copies the storage record into one of these and passes
    ///         it to {buildTokenURI}.
    struct Discovery {
        string parentGoalTitle;
        string sequence;
        string analysis;
        uint256 score;
        uint256 iterations;
        string branchGoalId;
        address submitter;
        uint64 discoveredAt;
        uint64 blockNumber;
    }

    function buildTokenURI(uint256 tokenId, Discovery memory d, string memory baseUrl)
        external
        pure
        returns (string memory)
    {
        bytes memory head = _jsonHead(tokenId, d);
        bytes memory mid = _jsonMid(tokenId, d, baseUrl);
        bytes memory tail = _jsonTail(tokenId, d, baseUrl);
        bytes memory full = bytes.concat(head, mid, tail);

        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(full)));
    }

    function _jsonHead(uint256 tokenId, Discovery memory d) private pure returns (bytes memory) {
        return abi.encodePacked(
            '{"name":"',
            _jsonEscape(_buildName(tokenId, d.parentGoalTitle)),
            '","description":"',
            _jsonEscape(_buildDescription(tokenId, d)),
            '"'
        );
    }

    function _jsonMid(uint256 tokenId, Discovery memory d, string memory baseUrl)
        private
        pure
        returns (bytes memory)
    {
        // Image = protein fold render served from the platform API.
        // Falls back to the 3D viewer for marketplaces that support animation.
        return abi.encodePacked(
            ',"image":"',
            _foldRenderUrl(tokenId, baseUrl),
            '","external_url":"',
            _externalUrl(tokenId, baseUrl),
            '"'
        );
    }

    function _jsonTail(uint256 tokenId, Discovery memory d, string memory baseUrl)
        private
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            ',"animation_url":"',
            _viewerUrl(tokenId, baseUrl),
            '","attributes":',
            _buildAttributes(d),
            "}"
        );
    }

    function _buildName(uint256 tokenId, string memory parentGoalTitle)
        private
        pure
        returns (string memory)
    {
        return string(abi.encodePacked("RES #", tokenId.toString(), " - ", parentGoalTitle));
    }

    function _buildDescription(uint256 tokenId, Discovery memory d)
        private
        pure
        returns (string memory)
    {
        bytes memory a = abi.encodePacked(
            "## Parent goal\n",
            d.parentGoalTitle,
            "\n\n## Sequence\n`",
            d.sequence,
            "`\n\n## Findings\n",
            d.analysis
        );
        bytes memory b = abi.encodePacked(
            "\n\n## Score\n",
            _scoreDecimal(d.score),
            " (",
            d.score.toString(),
            "/10000)\n\n## Iterations\n",
            d.iterations.toString()
        );
        bytes memory c = abi.encodePacked(
            "\n\n## Discovered\n",
            uint256(d.discoveredAt).toString(),
            " UTC (block #",
            uint256(d.blockNumber).toString(),
            ")\n\n## Original submitter\n`",
            d.submitter.toHexString()
        );
        // External URL is omitted from description in the library
        // version to keep the bytecode small; the JSON output already
        // exposes external_url as a top-level field, which all major
        // marketplaces and wallets surface inline.
        bytes memory e = abi.encodePacked(
            "`\n\n## Branch goal id\n`",
            d.branchGoalId,
            "`\n\n## Reproducibility\nFold the sequence with ESMFold or any equivalent structure-prediction engine to reproduce the predicted 3D structure. Token id: ",
            tokenId.toString(),
            "."
        );
        return string(bytes.concat(a, b, c, e));
    }

    function _buildSvg(uint256 tokenId, Discovery memory d) private pure returns (string memory) {
        string memory seqPreview = _truncate(d.sequence, 40);
        string memory titlePreview = _truncate(d.parentGoalTitle, 60);
        bytes memory svgA = abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" font-family="-apple-system,BlinkMacSystemFont,sans-serif">',
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0b1020"/><stop offset="100%" stop-color="#1a2342"/></linearGradient></defs>',
            '<rect width="800" height="500" fill="url(#g)"/>',
            '<text x="40" y="80" fill="#7fd8ff" font-size="14" letter-spacing="6">ETICARESEARCH</text>',
            '<text x="40" y="130" fill="#fff" font-size="36" font-weight="700">#',
            tokenId.toString(),
            "</text>"
        );
        bytes memory svgB = abi.encodePacked(
            '<text x="40" y="200" fill="#cdd6f4" font-size="22" font-weight="600">',
            _xmlEscape(titlePreview),
            '</text><text x="40" y="280" fill="#7fd8ff" font-size="12" letter-spacing="3">SEQUENCE</text>',
            '<text x="40" y="310" fill="#fff" font-size="18" font-family="monospace">',
            _xmlEscape(seqPreview),
            "</text>"
        );
        bytes memory svgC = abi.encodePacked(
            '<text x="40" y="380" fill="#7fd8ff" font-size="12" letter-spacing="3">SCORE</text>',
            '<text x="40" y="420" fill="#fff" font-size="48" font-weight="700">',
            _scoreDecimal(d.score),
            '</text><text x="600" y="470" fill="#7fd8ff" font-size="12" opacity="0.7">eticahub.com/labs</text>',
            "</svg>"
        );
        return string(bytes.concat(svgA, svgB, svgC));
    }

    function _buildAttributes(Discovery memory d) private pure returns (string memory) {
        bytes memory attrA = abi.encodePacked(
            '[{"trait_type":"Score","value":',
            _scoreDecimal(d.score),
            ',"max_value":1},{"trait_type":"Score (bps)","value":',
            d.score.toString(),
            ',"max_value":10000},{"trait_type":"Iterations","value":',
            d.iterations.toString(),
            "}"
        );
        bytes memory attrB = abi.encodePacked(
            ',{"trait_type":"Sequence length","value":',
            bytes(d.sequence).length.toString(),
            '},{"trait_type":"Parent goal","value":"',
            _jsonEscape(d.parentGoalTitle),
            '"},{"display_type":"date","trait_type":"Discovered","value":',
            uint256(d.discoveredAt).toString(),
            "}]"
        );
        return string(bytes.concat(attrA, attrB));
    }

    function _externalUrl(uint256 tokenId, string memory baseUrl)
        private
        pure
        returns (string memory)
    {
        return string(abi.encodePacked(baseUrl, "/labs/research/", tokenId.toString()));
    }

    function _viewerUrl(uint256 tokenId, string memory baseUrl)
        private
        pure
        returns (string memory)
    {
        return string(abi.encodePacked(baseUrl, "/labs/research/", tokenId.toString(), "/viewer"));
    }

    /// @notice URL for the protein fold render (static PNG image of the 3D structure).
    function _foldRenderUrl(uint256 tokenId, string memory baseUrl)
        private
        pure
        returns (string memory)
    {
        return string(abi.encodePacked(baseUrl, "/api/labs/fold-render/", tokenId.toString()));
    }

    function _scoreDecimal(uint256 scoreBps) private pure returns (string memory) {
        if (scoreBps >= SCORE_DENOM) return "1.00";
        bytes memory frac = bytes(scoreBps.toString());
        bytes memory padded = new bytes(4);
        uint256 pad = 4 - frac.length;
        for (uint256 i = 0; i < 4; i++) {
            if (i < pad) {
                padded[i] = "0";
            } else {
                padded[i] = frac[i - pad];
            }
        }
        return string(abi.encodePacked("0.", padded));
    }

    function _truncate(string memory s, uint256 maxLen) private pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length <= maxLen) return s;
        bytes memory out = new bytes(maxLen + 3);
        for (uint256 i = 0; i < maxLen; i++) {
            out[i] = b[i];
        }
        out[maxLen] = ".";
        out[maxLen + 1] = ".";
        out[maxLen + 2] = ".";
        return string(out);
    }

    function _jsonEscape(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length * 6);
        uint256 j;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == 0x22) {
                out[j++] = "\\";
                out[j++] = '"';
            } else if (c == 0x5c) {
                out[j++] = "\\";
                out[j++] = "\\";
            } else if (c == 0x0a) {
                out[j++] = "\\";
                out[j++] = "n";
            } else if (c == 0x0d) {
                out[j++] = "\\";
                out[j++] = "r";
            } else if (c == 0x09) {
                out[j++] = "\\";
                out[j++] = "t";
            } else if (uint8(c) < 0x20) {
                out[j++] = "\\";
                out[j++] = "u";
                out[j++] = "0";
                out[j++] = "0";
                out[j++] = _hexNibble(uint8(c) >> 4);
                out[j++] = _hexNibble(uint8(c) & 0x0f);
            } else {
                out[j++] = c;
            }
        }
        bytes memory trimmed = new bytes(j);
        for (uint256 i = 0; i < j; i++) {
            trimmed[i] = out[i];
        }
        return string(trimmed);
    }

    function _xmlEscape(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length * 6);
        uint256 j;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == 0x26) {
                out[j++] = "&";
                out[j++] = "a";
                out[j++] = "m";
                out[j++] = "p";
                out[j++] = ";";
            } else if (c == 0x3c) {
                out[j++] = "&";
                out[j++] = "l";
                out[j++] = "t";
                out[j++] = ";";
            } else if (c == 0x3e) {
                out[j++] = "&";
                out[j++] = "g";
                out[j++] = "t";
                out[j++] = ";";
            } else if (c == 0x22) {
                out[j++] = "&";
                out[j++] = "q";
                out[j++] = "u";
                out[j++] = "o";
                out[j++] = "t";
                out[j++] = ";";
            } else if (c == 0x27) {
                out[j++] = "&";
                out[j++] = "a";
                out[j++] = "p";
                out[j++] = "o";
                out[j++] = "s";
                out[j++] = ";";
            } else {
                out[j++] = c;
            }
        }
        bytes memory trimmed = new bytes(j);
        for (uint256 i = 0; i < j; i++) {
            trimmed[i] = out[i];
        }
        return string(trimmed);
    }

    function _hexNibble(uint8 n) private pure returns (bytes1) {
        return bytes1(n < 10 ? n + 0x30 : n - 10 + 0x61);
    }
}
