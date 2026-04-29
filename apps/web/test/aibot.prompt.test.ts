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

  it('describes ETI, EGAZ, and ETX in their distinct roles (PR H rebalance)', () => {
    // PR H: prompt must position ETI and EGAZ as Etica Protocol assets and
    // ETX as EticaHub's separate token, so the bot doesn't conflate them
    // or default to ETX-first answers about "Etica."
    expect(SYSTEM_PROMPT).toMatch(/EGAZ.*native gas/i);
    expect(SYSTEM_PROMPT).toMatch(/ETI.*research|research.*ETI/i);
    expect(SYSTEM_PROMPT).toMatch(/ETX.*separate|separate.*ETX/i);
    // Two-layer framing must be explicit so future edits don't silently
    // collapse Etica Protocol and EticaHub back into one thing.
    expect(SYSTEM_PROMPT).toMatch(/Etica Protocol/);
    expect(SYSTEM_PROMPT).toMatch(/EticaHub/);
    expect(SYSTEM_PROMPT).toMatch(/independent|third[- ]party/i);
    // The "lead with ETI, not ETX, when asked about Etica's economy" rule
    // is the entire point of this PR — pin it in a test.
    expect(SYSTEM_PROMPT).toMatch(/lead with ETI/i);
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

  it('pins all three canonical Etica sites + the EticaHub page index (PR I)', () => {
    // PR I: bot must know about etica.io (canonical explorer / dapp) and
    // eticanomics.net (ETI scarcity charts) in addition to eticaprotocol.org,
    // and must enumerate every routable EticaHub page so it can direct
    // users to the right surface instead of guessing or making up URLs.
    expect(SYSTEM_PROMPT).toContain('https://etica.io');
    expect(SYSTEM_PROMPT).toContain('https://eticanomics.net');
    expect(SYSTEM_PROMPT).toContain('https://eticaprotocol.org');
    // Full EticaHub page index — every public page the site exposes.
    expect(SYSTEM_PROMPT).toContain('https://eticahub.com');
    expect(SYSTEM_PROMPT).toContain('https://eticahub.com/whitepaper');
    expect(SYSTEM_PROMPT).toContain('https://eticahub.com/swap');
    expect(SYSTEM_PROMPT).toContain('https://eticahub.com/pool');
    expect(SYSTEM_PROMPT).toContain('https://eticahub.com/stake');
    expect(SYSTEM_PROMPT).toContain('https://eticahub.com/farms');
    expect(SYSTEM_PROMPT).toContain('https://eticahub.com/trade');
    expect(SYSTEM_PROMPT).toContain('https://eticahub.com/research');
    expect(SYSTEM_PROMPT).toContain('https://eticahub.com/bridge');
    expect(SYSTEM_PROMPT).toContain('https://eticahub.com/status');
    expect(SYSTEM_PROMPT).toContain('https://eticahub.com/api');
    expect(SYSTEM_PROMPT).toContain('https://eticahub.com/explorer');
  });

  it('encodes Etica Protocol on-chain coordinates as fixed facts (PR I)', () => {
    // PR I: stable on-chain identifiers users routinely ask about should
    // be answerable directly from the prompt rather than redirected.
    expect(SYSTEM_PROMPT).toContain('0x34c61EA91bAcdA647269d4e310A86b875c09946f');
    expect(SYSTEM_PROMPT).toMatch(/eticamainnet\.eticascan\.org/);
    expect(SYSTEM_PROMPT).toMatch(/eticamainnet\.eticaprotocol\.org/);
    expect(SYSTEM_PROMPT).toMatch(/17 April 2022|17th april 2022/i);
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
