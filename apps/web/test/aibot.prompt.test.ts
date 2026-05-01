import { describe, expect, it } from 'vitest';
import {
  MAX_QUOTED_REPLY_CHARS,
  SYSTEM_PROMPT,
  buildChatMessages,
  formatQuestionWithQuotedReply,
} from '../src/lib/aibot/prompt';

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

  it('hard-bans corporate-LLM safety boilerplate phrases (PR L)', () => {
    // PR L regression: bot replied to "how ugly am I?" with "I'm a large
    // language model, I don't have personal opinions or physical
    // descriptions of individuals. My purpose is to provide information..."
    // — exactly the corporate-LLM voice we wanted to avoid. The PR J
    // personality clauses said "joke back when joking" but didn't
    // explicitly ban the LLM-disclaimer phrasings, so the model fell back
    // to its training. Pin them as banned.
    expect(SYSTEM_PROMPT).toMatch(/NEVER respond with corporate-LLM safety boilerplate|banned outright/i);
    // The exact phrases the model leaned on must be enumerated as banned.
    expect(SYSTEM_PROMPT).toMatch(/large language model/);
    expect(SYSTEM_PROMPT).toMatch(/I don't have personal opinions/);
    expect(SYSTEM_PROMPT).toMatch(/My purpose is to provide information/);
    expect(SYSTEM_PROMPT).toMatch(/I'm here to help/);
    // The "if you have any questions related to Etica, I'm here to help"
    // redirect-lecture must be explicitly banned.
    expect(SYSTEM_PROMPT).toMatch(/lectures? the user back into.*topics|Banned redirects/i);
    // At least one concrete example showing the right shape (one-line
    // dry quip, no LLM disclaimer) must be present so the model has a
    // pattern to follow.
    expect(SYSTEM_PROMPT).toMatch(/how ugly am I/);
    expect(SYSTEM_PROMPT).toMatch(/are you sentient/);
    // Persona affirmation: the bot DOES have a personality, isn't a
    // generic ChatGPT clone.
    expect(SYSTEM_PROMPT).toMatch(/You DO have a personality|NOT a generic ChatGPT clone/);
    // Refusal list must still take precedence over banter — confirm the
    // explicit clause that the banter rules don't override refusals.
    expect(SYSTEM_PROMPT).toMatch(/banter rules.*do NOT override the refusal list|never joke through/i);
  });

  it('encodes the read-the-room personality rules (PR J)', () => {
    // PR J: bot mirrors a joking user with one short quip, then answers.
    // Default register stays dry/factual. Refusals must NEVER be joked
    // through — pin all three rules so future edits can't soften the
    // refusal posture or strip the personality directive.
    expect(SYSTEM_PROMPT).toMatch(/Tone/);
    expect(SYSTEM_PROMPT).toMatch(/read the room/i);
    expect(SYSTEM_PROMPT).toMatch(/mirror|match their energy/i);
    expect(SYSTEM_PROMPT).toMatch(/one quip|One quip/);
    expect(SYSTEM_PROMPT).toMatch(/never joke through|stay literal/i);
  });

  it('pins ETI + EGAZ as both mineable, dual-algo: ETI=RandomX/CPU, EGAZ=GPU (PR K regression)', () => {
    // PR K regression: in EticaHub TG the bot told a user "ETI isn't
    // mineable, only EGAZ is" — flatly wrong. Etica is a dual-algorithm
    // PoW chain: ETI is mined via RandomX (CPU, same algo as Monero) and
    // EGAZ is mined on GPUs. Pin all three facts (both mineable, the
    // distinct algorithms, and the no-conflation rule) so future prompt
    // edits can't silently drop them or re-introduce the hallucination.
    expect(SYSTEM_PROMPT).toMatch(/Proof[- ]of[- ]Work|PoW/i);
    // Dual-algorithm framing must be explicit.
    expect(SYSTEM_PROMPT).toMatch(/dual[- ]algorithm|two algorithms?|different hardware/i);
    // ETI = RandomX, CPU. The "like Monero" framing is how the community
    // explains it to newcomers, so it's worth pinning too.
    expect(SYSTEM_PROMPT).toMatch(/RandomX/);
    expect(SYSTEM_PROMPT).toMatch(/ETI.*CPU|CPU.*ETI|RandomX.*CPU/i);
    // EGAZ = Etchash (specifically — same algo as Ethereum Classic),
    // not just generic "GPU". The Etchash framing matters because users
    // ask about hardware compatibility (Jasminer X44-P etc., which are
    // Etchash-specific), and saying "GPU" alone is misleading.
    expect(SYSTEM_PROMPT).toMatch(/Etchash/);
    expect(SYSTEM_PROMPT).toMatch(/EGAZ.*GPU|GPU.*EGAZ/i);
    // Both must be explicitly named as mineable.
    expect(SYSTEM_PROMPT).toMatch(/BOTH ETI and EGAZ are mineable|both are mineable/i);
    // The OPR3-minting path for ETI must also be present.
    expect(SYSTEM_PROMPT).toMatch(/OPR3.*proposals?.*approved|approved.*OPR3|research proposals?.*approved/i);
    // Direct anti-hallucination clause: don't say either is non-mineable
    // and don't conflate the two algorithms.
    expect(SYSTEM_PROMPT).toMatch(/Don't say either is non-mineable/);
    expect(SYSTEM_PROMPT).toMatch(/don't conflate.*algorithms?|conflate the two algorithms/i);
  });

  it('pins emission / block-reward facts for ETI and EGAZ (PR M regression)', () => {
    // PR M regression: bot returned "every model provider failed" on
    // "what is the current emission rate for eti and egaz" because it
    // had no facts to ground the answer and likely timed out searching.
    // These are chain constants — pin them as fixed facts so the bot
    // answers from the prompt directly without needing search.
    // ETI block reward (RandomX).
    expect(SYSTEM_PROMPT).toMatch(/31\.96.*ETI.*block|ETI.*block.*31\.96/i);
    // ETI annual issuance and 21M cap.
    expect(SYSTEM_PROMPT).toMatch(/2[,.]?100[,.]?000 ETI|2\.1[Mm]/);
    expect(SYSTEM_PROMPT).toMatch(/21[,.]?000[,.]?000 ETI|21M ETI|21 [Mm]illion ETI/);
    // ETI tail emission post-cap.
    expect(SYSTEM_PROMPT).toMatch(/2\.61803%/);
    expect(SYSTEM_PROMPT).toMatch(/tail emission|after the cap|mining halts/i);
    // EGAZ block reward + block time.
    expect(SYSTEM_PROMPT).toMatch(/2\.0 EGAZ|EGAZ.*per block.*2\.0/i);
    expect(SYSTEM_PROMPT).toMatch(/13 second|~13s|13\.[0-9]+s/i);
    // Anti-hallucination: don't say "I don't know" — these are pinned.
    expect(SYSTEM_PROMPT).toMatch(/Don't say you don't know|these are pinned facts|answer from these numbers/i);
  });

  it('mentions Google Search grounding so the model knows it can search (PR J)', () => {
    // PR J: Gemini path enables the google_search tool. The prompt must
    // tell the model when to use it (time-sensitive Qs only) and when
    // NOT to (anything Live Context already covers).
    expect(SYSTEM_PROMPT).toMatch(/Google Search/);
    expect(SYSTEM_PROMPT).toMatch(/time[- ]sensitive|today|latest|current/i);
    expect(SYSTEM_PROMPT).toMatch(/Live Context/);
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

describe('aibot Thinktica canonical-source pin (PR O)', () => {
  it('includes thinktica.com as a canonical source alongside the other Etica sites', () => {
    expect(SYSTEM_PROMPT).toContain('https://www.thinktica.com');
    // Must describe what Thinktica IS, not just list the URL, so the bot
    // can answer "what is Thinktica?" from the prompt without making
    // up integration claims.
    expect(SYSTEM_PROMPT).toMatch(/AI[- ]research|AI Scientific|research labs/i);
    expect(SYSTEM_PROMPT).toMatch(/private beta/i);
    // Anti-fabrication clause: the prompt must explicitly tell the
    // model to route specifics it can't verify back to the site.
    expect(SYSTEM_PROMPT).toMatch(/route the user to the site|Don't fabricate/i);
  });

  it('teaches the model how to handle quoted Telegram replies (PR O)', () => {
    // Quoted-message handling rules must be present so the model knows
    // a [Quoted message] block is the subject of the user's ask, not
    // a prompt-injection attempt.
    expect(SYSTEM_PROMPT).toMatch(/\[Quoted message\]/);
    expect(SYSTEM_PROMPT).toMatch(/primary subject of the question/i);
    // Empty-prompt-after-quote rule (the canonical "@bot" tag with no
    // extra text) must be explicit.
    expect(SYSTEM_PROMPT).toMatch(/empty after the quote|no extra question/i);
    // Refusal rules must apply to quoted content too — otherwise users
    // could route around refusals via "interpret this for me."
    expect(SYSTEM_PROMPT).toMatch(/refusal-category question|apply the refusal rules to that quoted/i);
  });
});

describe('aibot quoted-reply formatter (PR O)', () => {
  it('returns the question unchanged when there is no quoted reply', () => {
    expect(formatQuestionWithQuotedReply('what is TVL?', null)).toBe('what is TVL?');
    expect(formatQuestionWithQuotedReply('what is TVL?', undefined)).toBe('what is TVL?');
  });

  it('returns the question unchanged when the quoted reply is empty', () => {
    expect(
      formatQuestionWithQuotedReply('hi', { text: '   ', username: 'alice' }),
    ).toBe('hi');
  });

  it('prepends a sentinel-fenced quote with the @username when present', () => {
    const out = formatQuestionWithQuotedReply('what does this mean?', {
      text: 'BIO is up 4x this week',
      username: 'EticaWhale',
    });
    expect(out).toContain('[Quoted message from @EticaWhale]');
    expect(out).toContain('BIO is up 4x this week');
    expect(out).toContain('[/Quoted message]');
    // The user's actual ask must come AFTER the fenced quote so the
    // model treats the quote as context rather than as instructions.
    expect(out.indexOf('what does this mean?')).toBeGreaterThan(
      out.indexOf('[/Quoted message]'),
    );
  });

  it('falls back to first_name when there is no username', () => {
    const out = formatQuestionWithQuotedReply('thoughts?', {
      text: 'I think ETI is undervalued',
      firstName: 'Bob',
    });
    expect(out).toContain('[Quoted message from Bob]');
  });

  it('falls back to "unknown user" when neither username nor first_name exist', () => {
    const out = formatQuestionWithQuotedReply('thoughts?', {
      text: 'channel post body',
    });
    expect(out).toContain('[Quoted message from unknown user]');
  });

  it('annotates bot authors so the model knows who wrote the quote', () => {
    const out = formatQuestionWithQuotedReply('what did the buybot say?', {
      text: 'EticaBuyBot: 100 ETX bought for $0.50',
      username: 'EticaBuyBot',
      isBot: true,
    });
    expect(out).toContain('[Quoted message from @EticaBuyBot (a bot)]');
  });

  it('emits a synthetic prompt when the user @-mentioned us with no extra text', () => {
    const out = formatQuestionWithQuotedReply('', {
      text: 'BIO is up 4x',
      username: 'EticaWhale',
    });
    // "@bot" with empty trailing question must still produce a usable
    // user turn that tells the model to interpret the quote, not the
    // existing EMPTY_QUESTION_REPLY canned message.
    expect(out).toContain('[Quoted message from @EticaWhale]');
    expect(out).toMatch(/no extra prompt|interpret the quoted message/i);
  });

  it('truncates absurdly long quotes to keep the prompt budget bounded', () => {
    // Telegram caps a single message at 4096 chars; if a user replies
    // to such a message and tags us, we must NOT forward the entire
    // body verbatim — we cap at MAX_QUOTED_REPLY_CHARS.
    const long = 'x'.repeat(4096);
    const out = formatQuestionWithQuotedReply('thoughts?', {
      text: long,
      username: 'alice',
    });
    // Body of the quote (between the open/close sentinels) must be
    // capped, with an ellipsis to signal truncation.
    const start = out.indexOf('[Quoted message from @alice]') + '[Quoted message from @alice]'.length;
    const end = out.indexOf('[/Quoted message]');
    const body = out.slice(start, end);
    expect(body.length).toBeLessThanOrEqual(MAX_QUOTED_REPLY_CHARS + 4); // +newlines + ellipsis
    expect(body).toMatch(/…/);
  });
});
