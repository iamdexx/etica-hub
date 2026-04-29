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
    expect(SYSTEM_PROMPT).toMatch(/Never name providers/);
  });

  it('includes prompt-injection guard', () => {
    expect(SYSTEM_PROMPT).toMatch(/ignore previous instructions/i);
  });

  it('explicitly invites brainstorming about Etica improvements', () => {
    // PR D loosens scope: open-ended ideas about Etica must be on-topic,
    // not refused as "off-topic chatter".
    expect(SYSTEM_PROMPT).toMatch(/brainstorm/i);
    expect(SYSTEM_PROMPT).toMatch(/dapp|ecosystem|DeSci/i);
  });

  it('allows fixed facts from the model knowledge while keeping live numbers grounded', () => {
    // Live numbers MUST come from Live Context...
    expect(SYSTEM_PROMPT).toMatch(/Live Context/);
    expect(SYSTEM_PROMPT).toMatch(/Live numbers/);
    // ...but fixed facts (chain id, hub-and-spoke design, harvester
    // split, ERC-4626 staking) can be answered from the model's own
    // knowledge — the prompt must say so explicitly.
    expect(SYSTEM_PROMPT).toMatch(/Fixed facts/);
    expect(SYSTEM_PROMPT).toMatch(/answer directly from your knowledge/i);
  });

  it('refuses unrelated coin shilling but does not refuse Etica brainstorming', () => {
    expect(SYSTEM_PROMPT).toMatch(/shill/i);
    expect(SYSTEM_PROMPT).toMatch(/other chains|other coins/i);
    // The old prompt blocked anything described as "off-topic chatter";
    // PR D drops that phrase so brainstorming is no longer caught by it.
    expect(SYSTEM_PROMPT).not.toMatch(/Off-topic chatter/i);
  });

  it('explicitly authorises general non-Etica questions (PR E scope expansion)', () => {
    // PR E: bot is Etica-first, but answers general coding / how-to /
    // technical questions directly without redirecting. The prompt must
    // say so explicitly so future edits can't silently re-narrow scope.
    expect(SYSTEM_PROMPT).toMatch(/general coding|how-to|technical explanations/i);
    expect(SYSTEM_PROMPT).toMatch(/Don't refuse, don't redirect/i);
    expect(SYSTEM_PROMPT).toMatch(/You are a real assistant/i);
  });

  it('keeps narrow refusal list (financial advice, operator, unsafe content)', () => {
    // Refusals are intentionally narrow in PR E. Verify the four real
    // refusal categories are still present and named.
    expect(SYSTEM_PROMPT).toMatch(/financial advice/i);
    expect(SYSTEM_PROMPT).toMatch(/operator|API key|provider/i);
    expect(SYSTEM_PROMPT).toMatch(/illegal|malicious|malware/i);
    expect(SYSTEM_PROMPT).toMatch(/prompt[- ]injection/i);
  });

  it('mentions Telegram-friendly fenced code blocks for code answers', () => {
    // PR E expects code answers; the prompt must tell the model how to
    // format them so Telegram renders the block correctly.
    expect(SYSTEM_PROMPT).toMatch(/fenced block|triple backticks/i);
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
