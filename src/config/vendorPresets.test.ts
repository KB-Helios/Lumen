import {describe, expect, it} from 'vitest';

import {vendorPresets, type Vendor} from './vendorPresets';

const requiredVendors: Vendor[] = [
  'claude',
  'codex',
  'gemini',
  'xai',
  'kimi',
  'meta',
  'devin',
  'vertex',
  'antigravity',
];

const fullUnion: Vendor[] = [
  'claude',
  'codex',
  'gemini',
  'grok',
  'opencode',
  'openclaw',
  'hermes',
  'pi',
  'minimax',
  'kimi',
  'meta',
  'devin',
  'vertex',
  'antigravity',
  'xai',
];

describe('vendor presets', () => {
  it('covers union set', () => {
    const vendors = new Set(vendorPresets.map((preset) => preset.vendor));
    for (const vendor of requiredVendors) expect(vendors.has(vendor)).toBe(true);
  });

  it('covers the full vendor union exactly once', () => {
    const vendors = vendorPresets.map((preset) => preset.vendor);
    expect([...vendors].sort()).toEqual([...fullUnion].sort());
    expect(new Set(vendors).size).toBe(vendors.length);
  });

  it('carries complete connection fields', () => {
    for (const preset of vendorPresets) {
      expect(preset.app.length).toBeGreaterThan(0);
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
      expect(preset.apiKeyField.length).toBeGreaterThan(0);
      expect(preset.defaultModel.length).toBeGreaterThan(0);
    }
  });
});
