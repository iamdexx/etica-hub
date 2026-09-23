import { describe, expect, it } from 'vitest';

import {
  CAMPAIGNS,
  activeCampaign,
  campaignShareBps,
  drawCampaign,
} from '@/lib/labs/campaign';

describe('labs campaign', () => {
  it('defaults to the pancreatic KRAS campaign at 75%', () => {
    expect(activeCampaign({})?.id).toBe('pancreatic-kras');
    expect(campaignShareBps({})).toBe(7500);
  });

  it('can be disabled or pointed at another campaign', () => {
    expect(activeCampaign({ LABS_CAMPAIGN: 'none' })).toBeNull();
    expect(activeCampaign({ LABS_CAMPAIGN: 'off' })).toBeNull();
    expect(activeCampaign({ LABS_CAMPAIGN: '' })).toBeNull();
    expect(activeCampaign({ LABS_CAMPAIGN: 'nonexistent' })).toBeNull();
    expect(activeCampaign({ LABS_CAMPAIGN: 'PANCREATIC-KRAS' })?.id).toBe('pancreatic-kras');
  });

  it('clamps and sanitises the share', () => {
    expect(campaignShareBps({ LABS_CAMPAIGN_SHARE_BPS: '-10' })).toBe(0);
    expect(campaignShareBps({ LABS_CAMPAIGN_SHARE_BPS: '99999' })).toBe(10_000);
    expect(campaignShareBps({ LABS_CAMPAIGN_SHARE_BPS: 'abc' })).toBe(7500);
    expect(campaignShareBps({ LABS_CAMPAIGN_SHARE_BPS: '5000' })).toBe(5000);
  });

  it('draws the campaign below the share and the general pool above it', () => {
    expect(drawCampaign({}, 0)?.id).toBe('pancreatic-kras');
    expect(drawCampaign({}, 0.74)?.id).toBe('pancreatic-kras');
    expect(drawCampaign({}, 0.75)).toBeNull();
    expect(drawCampaign({}, 0.99)).toBeNull();
  });

  it('never draws a campaign when disabled or at zero share', () => {
    expect(drawCampaign({ LABS_CAMPAIGN: 'none' }, 0)).toBeNull();
    expect(drawCampaign({ LABS_CAMPAIGN_SHARE_BPS: '0' }, 0)).toBeNull();
    expect(drawCampaign({ LABS_CAMPAIGN_SHARE_BPS: '10000' }, 0.999)?.id).toBe('pancreatic-kras');
  });

  it('pancreatic campaign carries usable topics, seeds and driver constraints', () => {
    const c = CAMPAIGNS['pancreatic-kras']!;
    expect(c.disease).toBe('Pancreatic Cancer');
    expect(c.topics.length).toBeGreaterThanOrEqual(10);
    expect(c.seeds.length).toBeGreaterThanOrEqual(10);
    // Seeds feed /api/labs/queue/spawn, which rejects prompts over 400 chars
    // and needs >= 30 chars to pass the seed route's own length gate.
    for (const seed of c.seeds) {
      expect(seed.length).toBeGreaterThan(30);
      expect(seed.length).toBeLessThanOrEqual(280);
    }
    expect(c.seeds.filter((s) => /KRAS|RAS/.test(s)).length).toBeGreaterThanOrEqual(4);
    expect(c.constraints.join(' ')).toMatch(/pancreatic ductal adenocarcinoma/i);
  });
});
