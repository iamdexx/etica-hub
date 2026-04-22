import { describe, expect, it } from 'vitest';
import {
  compareDeployedBytecode,
  maskImmutables,
  stripMetadataHash,
} from '../src/lib/verified';

// ------------------------------------------------------------------ //
// stripMetadataHash
// ------------------------------------------------------------------ //
// Solc appends a CBOR map whose trailing two bytes encode the CBOR map
// length as a big-endian uint16. The function strips `2 + cborLen` bytes
// off the tail, but only if the stripped region starts with a CBOR map
// marker (0xa*). These tests exercise the happy path + the defensive
// guards that keep us from eating bytes off a contract whose tail
// happens to look length-shaped.
describe('stripMetadataHash', () => {
  it('returns input unchanged when shorter than the length word', () => {
    expect(stripMetadataHash('')).toBe('');
    expect(stripMetadataHash('ab')).toBe('ab');
  });

  it('leaves bytecode alone when the declared CBOR length would overrun', () => {
    // 4 hex chars total; declared CBOR length `ffff` = 65535 bytes would
    // require a 65537-byte tail. Must keep input unchanged.
    expect(stripMetadataHash('ffff')).toBe('ffff');
  });

  it('leaves bytecode alone when the tail byte is not a CBOR map marker', () => {
    // 0xb2 is not a map (major type 5 starts with 0xa*). Should bail.
    // Tail would claim 2 + 0x0001 = 3 bytes (6 hex). The byte at that
    // offset is `b2`. Prefix padded with zeros so arithmetic works.
    const prefix = '00'.repeat(10); // 20 hex chars
    const tail = 'b2' + '00' + '0001'; // 8 hex chars: map-marker + body + len
    const hex = prefix + tail;
    expect(stripMetadataHash(hex)).toBe(hex);
  });

  it('strips a valid CBOR map tail', () => {
    // Construct a realistic-shaped runtime: 32 bytes of body, then a CBOR
    // map of length N, then the 2-byte length marker.
    const body = '60'.repeat(32); // 32 bytes runtime-ish body
    // Fake CBOR map: starts with 0xa1 (map, 1 pair), 5 arbitrary bytes.
    const cbor = 'a1' + 'aa'.repeat(5); // 6 bytes total
    const lengthWord = cbor.length / 2; // = 6
    const lenHex = lengthWord.toString(16).padStart(4, '0');
    const hex = body + cbor + lenHex;
    const stripped = stripMetadataHash(hex);
    expect(stripped).toBe(body);
  });

  it('is idempotent (stripping twice equals stripping once)', () => {
    const body = '60'.repeat(32);
    const cbor = 'a2' + '01'.repeat(10);
    const lenHex = (cbor.length / 2).toString(16).padStart(4, '0');
    const hex = body + cbor + lenHex;
    const once = stripMetadataHash(hex);
    const twice = stripMetadataHash(once);
    expect(once).toBe(body);
    expect(twice).toBe(body);
  });
});

// ------------------------------------------------------------------ //
// maskImmutables
// ------------------------------------------------------------------ //
// solc reports `deployedBytecode.immutableReferences` as a map from the
// AST node id of each immutable variable to the byte offsets where its
// value has been spliced into the runtime code. Our comparator masks
// those slots back to zeros before comparison. These tests verify the
// mask is applied correctly to single and multiple offsets.
describe('maskImmutables', () => {
  it('zeros out a single slot', () => {
    // 20 bytes: 4-byte prefix (`deadbeef`), 4-byte immutable (`11111111`),
    // 12 more bytes of body.
    const hex = 'deadbeef' + '11111111' + 'cc'.repeat(12);
    const refs = { '42': [{ start: 4, length: 4 }] };
    const masked = maskImmutables(hex, refs);
    expect(masked).toBe('deadbeef' + '00000000' + 'cc'.repeat(12));
  });

  it('zeros out multiple slots across multiple node ids', () => {
    const hex = 'aa'.repeat(32);
    const refs = {
      '1': [{ start: 0, length: 4 }],
      '2': [
        { start: 8, length: 2 },
        { start: 20, length: 4 },
      ],
    };
    const masked = maskImmutables(hex, refs);
    // Expect: 4 bytes zero, 4 bytes aa, 2 bytes zero, 10 bytes aa,
    // 4 bytes zero, 8 bytes aa.
    const expected =
      '00'.repeat(4) +
      'aa'.repeat(4) +
      '00'.repeat(2) +
      'aa'.repeat(10) +
      '00'.repeat(4) +
      'aa'.repeat(8);
    expect(masked).toBe(expected);
  });

  it('is a no-op when immutableReferences is empty', () => {
    const hex = '12345678';
    expect(maskImmutables(hex, {})).toBe(hex);
  });

  it('tolerates a leading 0x prefix on the input', () => {
    const hex = '0x' + 'aa'.repeat(8);
    const refs = { '1': [{ start: 0, length: 2 }] };
    const masked = maskImmutables(hex, refs);
    // Output is without 0x; first 2 bytes zeroed.
    expect(masked).toBe('0000' + 'aa'.repeat(6));
  });
});

// ------------------------------------------------------------------ //
// compareDeployedBytecode
// ------------------------------------------------------------------ //
// Three-level escalation: exact → with-immutables → with-metadata-hash.
// These tests construct synthetic bytecodes that exercise each level so
// we're sure the pipeline doesn't silently conflate match strengths or
// return the wrong label for a contract that matches at multiple
// levels.
describe('compareDeployedBytecode', () => {
  it('returns "exact" for byte-for-byte matches', () => {
    const a = '0x' + '60'.repeat(32);
    const b = '60'.repeat(32);
    expect(compareDeployedBytecode(a, b, null)).toBe('exact');
  });

  it('returns "exact" case-insensitively', () => {
    const a = '0x' + 'AB'.repeat(16);
    const b = 'ab'.repeat(16);
    expect(compareDeployedBytecode(a, b, null)).toBe('exact');
  });

  it('returns "with-immutables" after masking', () => {
    // On-chain has `deadbeef` at bytes [4..8); compiled artifact has
    // `00000000` there (the pre-splice immutable slot).
    const onchain = 'aa'.repeat(4) + 'deadbeef' + 'bb'.repeat(8);
    const compiled = 'aa'.repeat(4) + '00000000' + 'bb'.repeat(8);
    const refs = { '1': [{ start: 4, length: 4 }] };
    expect(compareDeployedBytecode(onchain, compiled, refs)).toBe('with-immutables');
  });

  it('returns "with-metadata-hash" when only the CBOR tail differs', () => {
    const body = '60'.repeat(64);
    // Two distinct CBOR tails — same body, different metadata length/content.
    const tailA = 'a1' + '11'.repeat(10) + (11).toString(16).padStart(4, '0');
    const tailB = 'a1' + '22'.repeat(15) + (16).toString(16).padStart(4, '0');
    expect(compareDeployedBytecode(body + tailA, body + tailB, null)).toBe(
      'with-metadata-hash',
    );
  });

  it('returns "with-metadata-hash" when both immutables and metadata differ', () => {
    // Pre-body + immutable slot + post-body + CBOR tail differ.
    const pre = 'aa'.repeat(4);
    const post = 'bb'.repeat(8);
    const tailA = 'a1' + '11'.repeat(10) + (11).toString(16).padStart(4, '0');
    const tailB = 'a1' + '22'.repeat(15) + (16).toString(16).padStart(4, '0');
    const onchain = pre + 'deadbeef' + post + tailA;
    const compiled = pre + '00000000' + post + tailB;
    const refs = { '1': [{ start: 4, length: 4 }] };
    expect(compareDeployedBytecode(onchain, compiled, refs)).toBe('with-metadata-hash');
  });

  it('returns null when the comparison fails at every level', () => {
    const onchain = '60'.repeat(32);
    const compiled = '61'.repeat(32);
    expect(compareDeployedBytecode(onchain, compiled, null)).toBeNull();
  });

  it('does not promote "with-immutables" up to "with-metadata-hash"', () => {
    // When the match is actually at the immutable-mask level, we want to
    // surface that — NOT downgrade/upgrade to the weaker label.
    const onchain = 'aa'.repeat(4) + 'deadbeef' + 'bb'.repeat(8);
    const compiled = 'aa'.repeat(4) + '00000000' + 'bb'.repeat(8);
    const refs = { '1': [{ start: 4, length: 4 }] };
    const result = compareDeployedBytecode(onchain, compiled, refs);
    expect(result).toBe('with-immutables');
  });
});
