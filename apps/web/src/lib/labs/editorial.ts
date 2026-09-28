/**
 * Editorial layer for everything the Labs pipeline publishes.
 *
 * The archive is a public reference work, so nothing in it may read like
 * pipeline plumbing or model scratchpad. Three classes of defect this
 * module removes:
 *
 *   1. Internal labels leaking into titles — a seed that fell back to the
 *      curated pool was titled "Curated Fallback", and topic-pool strings
 *      ("novel peptide inhibitor design") became goal names.
 *   2. Narration leaking into prompts — 550B writes `Better: "Engineer …"`,
 *      `I'll go with the cryo…`, `Count chars: "Perform deep …`, and the
 *      line-level sanitiser kept it because it is the last line.
 *   3. Records with no disease facet, so they never appear under any
 *      condition in the archive index.
 *
 * Everything here is deterministic — no model call — so it can run on the
 * write path and as a backfill over existing records.
 */

/* ------------------------------------------------------------------ */
/*  Prompt cleaning                                                     */
/* ------------------------------------------------------------------ */

/**
 * Narration the planner emits before (or instead of) the prompt itself.
 * Matched only at the start of the text, optionally followed by a short
 * run-in clause and a colon (`I'll produce: "Engineer …"`).
 */
const NARRATION_PREFIX =
  /^\s*(?:(?:ok(?:ay)?|sure|well|hmm+|right|so|actually|finally|alternatively|maybe|perhaps|better|best|revised|final(?:ly)?|draft|option\s*\d+|note)\b[^:.]{0,40}[:.]\s*|(?:i(?:'|’)?(?:ll|m|d)|i\s+(?:will|think|need|should|want|choose|go|produce|propose|pick)|let(?:'|’)?s|let\s+me|we\s+(?:need|should|will|can)|here(?:'|’)?s|here\s+is|this\s+prompt|the\s+prompt|count\s+chars?|char\s+count|character\s+count)\b[^:"]{0,80}[:"]\s*)/i;

/** Text that is unmistakably chain-of-thought rather than a research prompt. */
const META_BODY =
  /\b(?:max 280 char|imperative sentence|one sentence|the user (?:wants|asks)|as an ai|chain of thought|i (?:will|should) (?:output|write))\b/i;

/** An adverb before the verb ("Experimentally validate …") is still a prompt. */
const LEADING_ADVERB = /^(?:[a-z]+ly)\s+(?=[a-z])/i;

/** First word of a usable research prompt. */
const IMPERATIVE =
  /^(?:design|express|purify|leverage|execute|integrate|use|check|deploy|assemble|crystalli[sz]e|engineer|develop|optimi[sz]e|refine|validate|verify|characteri[sz]e|profile|measure|quantify|assess|evaluate|screen|map|model|simulate|predict|determine|solve|resolve|test|compare|benchmark|construct|build|generate|graft|stabili[sz]e|conjugate|fuse|mutate|scan|dock|rank|identify|explore|investigate|improve|extend|adapt|apply|combine|derive|couple|target|inhibit|block|disrupt|enhance|increase|reduce|minimi[sz]e|maximi[sz]e|perform|conduct|carry out|run|synthesi[sz]e|redesign|reengineer|repurpose|expand|search|sample|select|tune|calibrate|estimate|analy[sz]e|study|examine|trace|track|compute|calculate)\b/i;

const MAX_PROMPT_CHARS = 400;

/**
 * Pull the research instruction out of a raw prompt string, discarding
 * narration. Returns `null` when nothing publishable survives — callers
 * should reject the item rather than publish scratchpad.
 */
export function cleanPrompt(raw: string): string | null {
  if (!raw) return null;
  let s = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();

  // `Better: "Engineer a pH-sensitive hinge …` — the payload is the quoted
  // span, and the closing quote is often missing because the line was cut.
  const quoted = s.match(/["“]([^"”]{40,})["”]?\s*$/);
  if (quoted?.[1] && NARRATION_PREFIX.test(s)) s = quoted[1];

  for (let i = 0; i < 3; i++) {
    const stripped = s.replace(NARRATION_PREFIX, '').trim();
    if (stripped === s) break;
    s = stripped;
  }

  s = s
    .replace(/^["'`“”]+|["'`“”]+$/g, '')
    .replace(/^\s*[-*•]\s*/, '')
    .replace(
      /^(?:\*\*)?(?:next research prompt|research prompt|prompt|answer)(?:\*\*)?\s*:\s*/i,
      '',
    )
    .trim();

  if (s.length > MAX_PROMPT_CHARS) s = s.slice(0, MAX_PROMPT_CHARS).trim();
  if (s.length < 40) return null;
  if (META_BODY.test(s)) return null;
  if (!IMPERATIVE.test(s.replace(LEADING_ADVERB, ''))) return null;
  // Cut mid-word by an upstream character cap: drop the dangling fragment
  // rather than publish "…tumor-protease-cle".
  const lastWord = s.split(/[\s-]+/).pop() ?? '';
  if (!/[.!?]$/.test(s) && lastWord.length < 3) {
    s = s.slice(0, s.length - lastWord.length).replace(/[\s-]+$/, '');
  }
  return s.length >= 40 ? s : null;
}

/** Strip narration from a descriptive field, keeping the text as-is otherwise. */
export function cleanProse(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  let s = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
  for (let i = 0; i < 3; i++) {
    const stripped = s.replace(NARRATION_PREFIX, '').trim();
    if (stripped === s) break;
    s = stripped;
  }
  return s.replace(/^["'`“”]+|["'`“”]+$/g, '').trim() || undefined;
}

/* ------------------------------------------------------------------ */
/*  Disease inference + canonical naming                                */
/* ------------------------------------------------------------------ */

/**
 * Target/keyword → condition. First match wins, so the specific patterns
 * (KRAS-G12D, TDP-43) precede the generic ones (tumour, infection).
 */
const DISEASE_RULES: Array<[RegExp, string]> = [
  [
    /\b(?:sars-?cov-?2|covid|spike\s+rbd|\brbd\b|omicron|sarbecovirus|nanobody.*(?:rbd|variant))\b/i,
    'COVID-19',
  ],
  [/\bkras|pdac|pancreatic\s+ductal/i, 'Pancreatic Cancer'],
  [/\bcachexia\b/i, 'Cancer Cachexia'],
  [/\bamyloid|\btau\b|alzheimer/i, "Alzheimer's Disease"],
  [/\btdp-?43|\bsod1\b|amyotrophic|motor\s+neuron/i, 'Amyotrophic Lateral Sclerosis'],
  [/\balpha-?synuclein|parkinson/i, "Parkinson's Disease"],
  [/\bhuntingtin|huntington/i, "Huntington's Disease"],
  [/\bil-?17|psoriasis/i, 'Psoriasis'],
  [/pulmonary\s+fibrosis|\bipf\b/i, 'Idiopathic Pulmonary Fibrosis'],
  [/\bfibrosis\b/i, 'Fibrotic Disease'],
  [
    /\bpd-?1\b|\bpd-?l1\b|\bctla-?4\b|checkpoint|car-?t\b|t-?cell\s+engager|immunotherapy/i,
    'Cancer Immunotherapy',
  ],
  [/\bmdm2\b|\bp53\b|glioblastoma/i, 'Glioblastoma'],
  [/\bher2\b|breast\s+cancer/i, 'Breast Cancer'],
  [/\begfr\b|lung\s+cancer|\bnsclc\b/i, 'Lung Cancer'],
  [/ovarian\s+cancer/i, 'Ovarian Cancer'],
  [/melanoma/i, 'Melanoma'],
  [/leukemia|lymphoma|myeloma/i, 'Haematologic Malignancy'],
  [
    /\bmrsa\b|staphylococc|pseudomonas|biofilm|antimicrobial|antibiotic\s+resistan/i,
    'Antimicrobial Resistance',
  ],
  [/influenza|\bhiv\b|hepatitis|dengue|zika|ebola|malaria|tuberculosis/i, 'Infectious Disease'],
  [/\bglp-?1\b|insulin|diabet/i, 'Type 2 Diabetes'],
  [/obesity|\bleptin\b/i, 'Obesity'],
  [/\bcomplex\s+i\b|mitochondri|leigh\s+syndrome/i, 'Mitochondrial Disease'],
  [/rheumatoid|lupus|autoimmun|multiple\s+sclerosis/i, 'Autoimmune Disease'],
  [/atheroscleros|cardiac|cardiovascular|hypertension/i, 'Cardiovascular Disease'],
  [/\bcftr\b|cystic\s+fibrosis/i, 'Cystic Fibrosis'],
  [/sickle\s+cell|thalassemia/i, 'Haemoglobinopathy'],
  [/\bpain\b|nociceptiv|\bnav1\.\d/i, 'Chronic Pain'],
  [/\bsenescen|senolytic|ageing|aging/i, 'Ageing Biology'],
  [/\bcancer\b|\btumou?r|oncolog|metasta/i, 'Cancer'],
];

/** Internal plumbing labels that must never be shown as a research topic. */
const INTERNAL_LABEL =
  /^(?:curated\s+fallback|fallback|auto[-\s]?seed|autopilot(?:[-\s]seed)?|untitled|unknown|topic[-\s]only|seed)$/i;

/** Older facet names that should collapse onto the canonical condition. */
const DISEASE_ALIASES: Record<string, string> = {
  covid: 'COVID-19',
  'covid-19': 'COVID-19',
  covid19: 'COVID-19',
  'sars-cov-2': 'COVID-19',
  'sarbecovirus infections': 'COVID-19',
  'cancer immunotherapy checkpoint': 'Cancer Immunotherapy',
  "alzheimer's disease": "Alzheimer's Disease",
  'alzheimer s disease': "Alzheimer's Disease",
  'amyotrophic lateral sclerosis': 'Amyotrophic Lateral Sclerosis',
};

/** Guess the condition a piece of research is about from its own text. */
export function inferDisease(text: string): string | undefined {
  if (!text) return undefined;
  for (const [re, disease] of DISEASE_RULES) if (re.test(text)) return disease;
  return undefined;
}

/** Normalise a disease facet so the archive indexes one name per condition. */
export function canonicalDisease(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (!trimmed || INTERNAL_LABEL.test(trimmed)) return undefined;
  const alias = DISEASE_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  return titleCase(trimmed);
}

/* ------------------------------------------------------------------ */
/*  Titles                                                              */
/* ------------------------------------------------------------------ */

const MAX_TITLE = 120;
const SMALL_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'via',
  'with',
]);

/**
 * Title case that never destroys scientific casing: any word carrying an
 * uppercase letter past its first character or a digit (`Cryo-EM`,
 * `KRAS-G12D`, `SARS-CoV-2`, `50A/44S`, `pan-RAS`) is left exactly as the
 * author wrote it.
 */
function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .map((word, i) => {
      const kept = /[A-Z0-9]/.test(word.slice(1));
      const lower = word.toLowerCase();
      if (i > 0 && !kept && SMALL_WORDS.has(lower)) return lower;
      if (!/[a-z]/.test(word.charAt(0))) return word;
      // Capitalising a word with internal caps only ever safe across a
      // hyphen (`cryo-EM`); inside a token it is the symbol (`ncAA`, `pH`).
      if (kept && !/-[A-Z0-9]/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/** Raw residue strings and internal ordinals never belong in a title. */
function stripArtefacts(text: string): string {
  return text
    .replace(/\b[ACDEFGHIKLMNPQRSTVWY]{12,}\b/g, '')
    .replace(/\b(?:candidate|peptide|design|sequence)\s*#\s*\d+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Words that make a bare phrase readable as a condition rather than a topic. */
const CONDITION_SUFFIX =
  /(?:cancers?|tumou?rs?|diseases?|disorders?|syndromes?|infections?|cachexia|fibrosis|sclerosis|deficienc(?:y|ies)|resistance|injur(?:y|ies)|failure|diabetes|obesity|pain|malignanc(?:y|ies)|immunotherapy|biology)$/i;

/**
 * A condition name if the phrase actually reads as one — used so a campaign
 * label ("Pancreatic Cancer") is honoured while a topic-pool string
 * ("novel peptide inhibitor design") is not mistaken for a disease.
 */
function diseaseHint(phrase: string | undefined): string | undefined {
  const p = phrase?.trim();
  if (!p || p.length < 3 || p.length > 60 || INTERNAL_LABEL.test(p)) return undefined;
  const alias = DISEASE_ALIASES[p.toLowerCase()];
  if (alias) return alias;
  // A multi-word phrase that already names a condition is more specific
  // than anything inference can add — "Pancreatic Cancer" must not
  // collapse onto the generic "Cancer" rule.
  if (CONDITION_SUFFIX.test(p) && p.split(/\s+/).length >= 2) return titleCase(p);
  return inferDisease(p);
}

/** A title that reads as plumbing, a bare topic string, or a raw prompt. */
export function isPlumbingTitle(title: string | undefined): boolean {
  if (!title) return true;
  const t = stripArtefacts(title).trim();
  if (!t || INTERNAL_LABEL.test(t)) return true;
  if (t.length < 12) return true;
  // A public topic chip is "Condition — Specifics"; anything without the
  // condition half is an internal label, a bare topic or a raw prompt.
  const [head, ...rest] = t.split(/\s+[—–]\s+|\s+-\s+/);
  if (rest.length === 0 || !rest.join(' ').trim()) return true;
  return !diseaseHint(head);
}

/** Tails that say nothing about the research and must be rebuilt. */
const VAGUE_TAIL =
  /^(?:driver[-\s]directed design|research|study|design|optimi[sz]ation|refinement|analysis|auto[-\s]?seed|protein design study)$/i;

/**
 * Turn a research prompt into the "Specifics" half of an encyclopedic
 * title: the object of the work, not the instruction. Empty when the text
 * is narration rather than research.
 */
function specificsFromPrompt(prompt: string): string {
  let s = stripArtefacts(prompt);
  s = s.replace(LEADING_ADVERB, '');
  // "Express and purify the 48-aa miniprotein" — drop the whole verb chain,
  // not just the first verb, so the title never opens on "And Purify".
  for (let i = 0; i < 3; i++) {
    const cut = s
      .replace(IMPERATIVE, '')
      .replace(/^\s*(?:and|then|also)\s+/i, '')
      .trim();
    if (cut === s) break;
    s = cut;
  }
  s = s.replace(/^\s*(?:a|an|the)\s+/i, '').trim();
  // First clause only — titles are topics, not sentences.
  s = s.split(/(?:[,;.]|\s+(?:to|for|so that|in order to|using|by|with)\s+)/i)[0]?.trim() ?? s;
  if (s.length > 72) s = s.slice(0, 72).replace(/\s+\S*$/, '');
  // Never end a topic chip on a dangling preposition or article.
  for (let i = 0; i < 3; i++) {
    const cut = s
      .replace(/\s+(?:will|can|may|would|should|could|must)\s+\S+$/i, '')
      .replace(
        /\s+(?:of|in|on|at|for|to|from|with|by|and|or|the|a|an|into|between|against|via|will|can|may|would|should|could|is|are|be|does|do|has|have|that|which|guided|bound|driven|based|derived|mediated|informed|enabled|selected)$/i,
        '',
      );
    if (cut === s) break;
    s = cut;
  }
  if (NARRATION_PREFIX.test(s) || META_BODY.test(s) || s.length < 8) return '';
  return titleCase(s);
}

/**
 * Build the public topic title for a run: `Condition — Research Specifics`.
 * A usable model-written title is kept (cleaned); a plumbing label or a
 * bare topic string is rebuilt from the prompt.
 */
export function editorialTitle(
  rawTitle: string | undefined,
  prompt: string,
  /** Extra run text (hypothesis, summary) used when the prompt is narration. */
  context = '',
): string {
  const cleanedTitle = rawTitle ? stripArtefacts(cleanProse(rawTitle) ?? '') : '';
  const [head, ...rest] = cleanedTitle.split(/\s+[—–]\s+|\s+-\s+/);
  const tail = rest.join(' — ').trim();

  if (!isPlumbingTitle(cleanedTitle) && !VAGUE_TAIL.test(tail)) {
    const disease = diseaseHint(head) ?? inferDisease(prompt) ?? 'Biomedical Research';
    return `${disease} — ${titleCase(tail)}`.slice(0, MAX_TITLE).trim();
  }

  const disease =
    diseaseHint(head) ??
    diseaseHint(cleanedTitle) ??
    inferDisease(`${cleanedTitle} ${prompt} ${context}`) ??
    'Biomedical Research';
  const specifics =
    specificsFromPrompt(prompt) || specificsFromPrompt(context) || 'Protein Design Study';
  return `${disease} — ${specifics}`.slice(0, MAX_TITLE).trim();
}

/** The condition a record should be filed under, from its title then its text. */
export function resolveDisease(title: string | undefined, prompt: string): string | undefined {
  const head = title?.split(/\s+[—–]\s+|\s+-\s+/)[0];
  const fromTitle = diseaseHint(head);
  if (fromTitle) return fromTitle;
  return inferDisease(`${title ?? ''} ${prompt}`);
}
