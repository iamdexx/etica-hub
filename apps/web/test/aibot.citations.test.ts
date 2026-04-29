import { describe, expect, it } from 'vitest';
import { renderCitationFooter } from '../src/lib/aibot/citations';

describe('aibot citation footer', () => {
  it('returns empty string when there are no citations', () => {
    expect(renderCitationFooter([])).toBe('');
  });

  it('renders a Sources block with bullets', () => {
    const out = renderCitationFooter([
      { title: 'NHL.com', url: 'https://www.nhl.com/scores' },
      { title: 'ESPN', url: 'https://espn.com/nhl' },
    ]);
    expect(out).toContain('Sources:');
    expect(out).toContain('• NHL.com — https://www.nhl.com/scores');
    expect(out).toContain('• ESPN — https://espn.com/nhl');
    // Header should be preceded by a blank line so it visually separates
    // from the model's prose body.
    expect(out.startsWith('\n')).toBe(true);
  });

  it('caps the number of rendered sources', () => {
    const cs = Array.from({ length: 9 }, (_, i) => ({
      title: `Site ${i}`,
      url: `https://example.com/${i}`,
    }));
    const out = renderCitationFooter(cs, { maxSources: 3 });
    expect((out.match(/•/g) ?? []).length).toBe(3);
    expect(out).toContain('Site 0');
    expect(out).toContain('Site 2');
    expect(out).not.toContain('Site 3');
  });

  it('truncates long titles with an ellipsis', () => {
    const longTitle = 'a'.repeat(120);
    const out = renderCitationFooter([{ title: longTitle, url: 'https://x' }], {
      maxTitleChars: 20,
    });
    expect(out).toContain('…');
    expect(out).not.toContain(longTitle);
  });

  it('preserves order from the input', () => {
    const out = renderCitationFooter([
      { title: 'B', url: 'https://b' },
      { title: 'A', url: 'https://a' },
    ]);
    const idxB = out.indexOf('• B —');
    const idxA = out.indexOf('• A —');
    expect(idxB).toBeGreaterThan(0);
    expect(idxA).toBeGreaterThan(idxB);
  });
});
