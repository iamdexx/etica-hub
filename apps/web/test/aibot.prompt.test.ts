import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT, buildChatMessages } from '../src/lib/aibot/prompt';

describe('aibot system prompt', () => {
  it('mentions the core protocol surface', () => {
    expect(SYSTEM_PROMPT).toContain('EticaBot');
    expect(SYSTEM_PROMPT).toContain('chain id 61803');
    expect(SYSTEM_PROMPT).toContain('EticaSwap V2');
    expect(SYSTEM_PROMPT).toContain('stETX');
    expect(SYSTEM_PROMPT).toContain('ETXFarms');
    expect(SYSTEM_PROMPT).toContain('TreasuryHarvester');
  });

  it('encodes the no-financial-advice + price-redirect rule', () => {
    expect(SYSTEM_PROMPT).toMatch(/Never give financial advice/i);
    expect(SYSTEM_PROMPT).toMatch(/eticahub\.com\/trade/);
  });

  it('blocks operator/provider/key questions', () => {
    expect(SYSTEM_PROMPT).toMatch(/operator|API key|provider/i);
    expect(SYSTEM_PROMPT).toMatch(/Do not name providers/);
  });

  it('includes prompt-injection guard', () => {
    expect(SYSTEM_PROMPT).toMatch(/ignore previous instructions/i);
  });
});

describe('aibot chat-message builder', () => {
  it('appends Live Context to the system message and adds the user question', () => {
    const messages = buildChatMessages({
      question: 'what is TVL right now?',
      contextText: 'TVL: $11.70K (1.5M ETX) across 3 pools',
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('[Live Context');
    expect(messages[0].content).toContain('TVL: $11.70K');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toBe('what is TVL right now?');
  });

  it('passes through history between system and user messages', () => {
    const messages = buildChatMessages({
      question: 'and the volume?',
      contextText: 'TVL: $1',
      history: [
        { role: 'user', content: 'what is TVL?' },
        { role: 'assistant', content: 'TVL is $1' },
      ],
    });
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[1].content).toBe('what is TVL?');
    expect(messages[3].content).toBe('and the volume?');
  });
});
