import { describe, expect, it } from 'vitest';

import { TELEGRAM_CHUNK_LIMIT, chunkForTelegram } from '../src/lib/aibot/chunk';

describe('chunkForTelegram', () => {
  it('returns an empty array for empty / whitespace input', () => {
    expect(chunkForTelegram('')).toEqual([]);
    expect(chunkForTelegram('   \n\n  ')).toEqual([]);
  });

  it('returns one chunk verbatim for short input', () => {
    expect(chunkForTelegram('hello world')).toEqual(['hello world']);
  });

  it('right-trims trailing whitespace from short input', () => {
    expect(chunkForTelegram('hello world   \n')).toEqual(['hello world']);
  });

  it('passes input at exactly the limit through as a single chunk', () => {
    const text = 'a'.repeat(TELEGRAM_CHUNK_LIMIT);
    expect(chunkForTelegram(text)).toEqual([text]);
  });

  it('keeps every chunk under the limit', () => {
    const text = ('paragraph that is not super short.\n\n').repeat(200);
    const chunks = chunkForTelegram(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_CHUNK_LIMIT);
    }
  });

  it('preserves content order and the full text (modulo whitespace at boundaries)', () => {
    const text = ('paragraph that is not super short.\n\n').repeat(200);
    const chunks = chunkForTelegram(text);
    // Reassembling chunks back to a single string should match the input
    // up to whitespace at chunk boundaries (which we deliberately strip).
    const rejoined = chunks.join(' ').replace(/\s+/gu, ' ').trim();
    const expected = text.replace(/\s+/gu, ' ').trim();
    expect(rejoined).toBe(expected);
  });

  it('prefers paragraph (\\n\\n) boundaries when available', () => {
    // Three 100-char paragraphs separated by \n\n. With a 150-char
    // limit only one paragraph fits per chunk, so each chunk must end
    // exactly at a paragraph (i.e. last char is the letter, not split
    // mid-token, and the next paragraph's letters are absent).
    const text = `${'p'.repeat(100)}\n\n${'q'.repeat(100)}\n\n${'r'.repeat(100)}`;
    const chunks = chunkForTelegram(text, { limit: 150 });
    expect(chunks).toEqual(['p'.repeat(100), 'q'.repeat(100), 'r'.repeat(100)]);
  });

  it('packs multiple paragraphs into one chunk when they fit', () => {
    // Two 100-char paragraphs with limit 250 must coexist in one chunk.
    const text = `${'p'.repeat(100)}\n\n${'q'.repeat(100)}\n\n${'r'.repeat(100)}`;
    const chunks = chunkForTelegram(text, { limit: 250 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('p');
    expect(chunks[0]).toContain('q');
    expect(chunks[0]).not.toContain('r');
    expect(chunks[1]).toBe('r'.repeat(100));
  });

  it('falls back to single-newline boundaries when no \\n\\n fits', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i.toString().padStart(2, '0')}`);
    const text = lines.join('\n');
    const chunks = chunkForTelegram(text, { limit: 30 });
    // Each chunk should end at a line boundary (i.e. the last line in
    // each chunk is a complete `line NN` token, not split mid-word).
    for (const chunk of chunks) {
      expect(chunk).toMatch(/line \d{2}$/);
    }
  });

  it('falls back to whitespace when no newline fits', () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const chunks = chunkForTelegram(text, { limit: 30 });
    // Every chunk must end with a complete "wordN" — never split mid-word.
    for (const chunk of chunks) {
      expect(chunk).toMatch(/word\d+$/);
    }
  });

  it('hard-cuts when no whitespace fits within the limit', () => {
    // 200-char unbroken token, limit 50 → 4 chunks of 50 chars each.
    const text = 'a'.repeat(200);
    const chunks = chunkForTelegram(text, { limit: 50 });
    expect(chunks).toHaveLength(4);
    for (const chunk of chunks) {
      expect(chunk).toBe('a'.repeat(50));
    }
  });

  it('does not lose characters across consecutive chunks', () => {
    // Stream of distinguishable tokens so we can spot-check no-loss.
    const tokens = Array.from({ length: 500 }, (_, i) => `T${i}`);
    const text = tokens.join(' ');
    const chunks = chunkForTelegram(text, { limit: 80 });
    const rejoined = chunks.join(' ');
    for (const t of tokens) {
      expect(rejoined).toContain(t);
    }
  });

  it('throws on a non-positive limit', () => {
    expect(() => chunkForTelegram('hi', { limit: 0 })).toThrow();
    expect(() => chunkForTelegram('hi', { limit: -1 })).toThrow();
  });

  it('handles input that is exactly the LLM cap (~8KB) without explosion', () => {
    // Roughly the longest output we'd expect from a 2048-token reply.
    const text = ('Sentence ending with period. ').repeat(300);
    const chunks = chunkForTelegram(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_CHUNK_LIMIT);
    }
  });
});
