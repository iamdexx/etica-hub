/**
 * Research campaigns: weighted bias of the autopilot's auto-seeding toward
 * one disease area, so the lab can be pointed at a priority problem instead
 * of sampling the whole biomedical topic pool uniformly.
 *
 * A campaign supplies its own PubMed topics, curated fallback prompts and
 * extra planner constraints. `LABS_CAMPAIGN_SHARE_BPS` decides how often a
 * seed is drawn from the campaign rather than the general pool — the rest
 * keeps the archive broad so the lab does not become single-issue.
 *
 *   LABS_CAMPAIGN=pancreatic-kras   (default; `none`/`off` disables)
 *   LABS_CAMPAIGN_SHARE_BPS=7500    (75% of auto-seeds)
 */

export interface Campaign {
  id: string;
  label: string;
  disease: string;
  /** PubMed search terms used to pull recent literature for the seed LLM. */
  topics: string[];
  /** Curated prompts used when the seed LLM is unavailable. */
  seeds: string[];
  /** Extra system-prompt lines constraining the generated direction. */
  constraints: string[];
}

const PANCREATIC: Campaign = {
  id: 'pancreatic-kras',
  label: 'Pancreatic ductal adenocarcinoma — driver-directed design',
  disease: 'Pancreatic Cancer',
  topics: [
    'KRAS G12D inhibitor pancreatic',
    'KRAS switch II pocket binder',
    'pan-KRAS degrader PROTAC',
    'SMAD4 loss pancreatic adenocarcinoma therapy',
    'CDKN2A p16 restoration peptide',
    'mesothelin CAR-T pancreatic',
    'claudin 18.2 antibody gastric pancreatic',
    'CEACAM5 targeting therapeutic',
    'glypican-1 pancreatic exosome marker',
    'fibroblast activation protein stroma targeting',
    'BRCA2 PALB2 synthetic lethality PARP pancreatic',
    'ATM deficient tumour DNA damage response inhibitor',
    'MUC1 tumour associated antigen peptide',
    'pancreatic cancer desmoplastic stroma penetrating peptide',
    'SOS1 SHP2 RAS pathway inhibitor',
    'cachexia GDF15 pancreatic cancer',
  ],
  seeds: [
    'Design a KRAS-G12D selective helical peptide occupying the switch II pocket with improved intracellular delivery',
    'Engineer a stapled peptide discriminating KRAS-G12V from wild-type KRAS at the switch I/II interface',
    'Design a cyclic peptide binder of the KRAS-G12R switch II pocket stable in human serum',
    'Develop a pan-RAS degrader recruiting peptide that bridges KRAS to a cereblon-binding module',
    'Engineer a SOS1-KRAS interaction blocking peptide to suppress nucleotide exchange in pancreatic tumour cells',
    'Design a SMAD4-mimetic peptide restoring TGF-beta transcriptional output in SMAD4-null pancreatic cells',
    'Engineer a p16INK4a-derived peptide that re-establishes CDK4/6 inhibition in CDKN2A-deleted tumours',
    'Design a mesothelin-binding miniprotein with picomolar affinity for pancreatic tumour targeting',
    'Engineer a claudin-18.2 selective nanobody discriminating tumour from gastric epithelium',
    'Design a CEACAM5-targeting peptide-drug conjugate linker stable in circulation',
    'Develop a glypican-1 binding miniprotein for early pancreatic lesion imaging',
    'Engineer a fibroblast activation protein cleavable prodrug peptide for desmoplastic stroma',
    'Design a stroma-penetrating cyclic peptide improving payload delivery through pancreatic desmoplasia',
    'Engineer a RAD51-BRCA2 interaction peptide sensitising BRCA2-wildtype pancreatic tumours to platinum',
    'Design a MUC1-C dimerisation blocking peptide for pancreatic adenocarcinoma',
    'Engineer a GDF15 neutralising miniprotein to counter cancer cachexia in pancreatic cancer',
  ],
  constraints: [
    'The direction MUST target pancreatic ductal adenocarcinoma biology.',
    'Prefer its validated drivers: KRAS (G12D/G12V/G12R), TP53, CDKN2A, SMAD4,',
    'DNA-damage-response deficiency (BRCA1/2, PALB2, ATM), or a surface antigen',
    'of pancreatic tumour or stroma (mesothelin, CLDN18.2, CEACAM5, GPC1, FAP, MUC1).',
  ],
};

export const CAMPAIGNS: Record<string, Campaign> = { [PANCREATIC.id]: PANCREATIC };

const DEFAULT_CAMPAIGN_ID = PANCREATIC.id;
const DEFAULT_SHARE_BPS = 7500;

type Env = Record<string, string | undefined>;

export function activeCampaign(env: Env = process.env): Campaign | null {
  const raw = (env.LABS_CAMPAIGN ?? DEFAULT_CAMPAIGN_ID).trim().toLowerCase();
  if (raw === '' || raw === 'none' || raw === 'off') return null;
  return CAMPAIGNS[raw] ?? null;
}

export function campaignShareBps(env: Env = process.env): number {
  const raw = Number(env.LABS_CAMPAIGN_SHARE_BPS ?? DEFAULT_SHARE_BPS);
  if (!Number.isFinite(raw)) return DEFAULT_SHARE_BPS;
  return Math.max(0, Math.min(10_000, Math.floor(raw)));
}

/** Draw the campaign for one seed, or null to use the general topic pool. */
export function drawCampaign(env: Env = process.env, roll: number = Math.random()): Campaign | null {
  const campaign = activeCampaign(env);
  if (!campaign) return null;
  return roll * 10_000 < campaignShareBps(env) ? campaign : null;
}
