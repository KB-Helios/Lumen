import {describe, expect, it} from 'vitest';

import {windowsAiFeatureSchema, windowsAiPreferencesSchema, windowsAiTextRequestSchema} from './windows-ai.types';

describe('Windows AI trust boundary', () => {
  it('fails closed for an unknown native capability or readiness state', () => {
    const feature = {id: 'languageModel', host: 'windows', label: 'Windows language model', availability: 'ready', reasonCode: 'none', detail: null, enabled: false, model: null};
    expect(windowsAiFeatureSchema.parse(feature).enabled).toBe(false);
    expect(windowsAiFeatureSchema.safeParse({...feature, availability: 'probablyReady'}).success).toBe(false);
    expect(windowsAiFeatureSchema.safeParse({...feature, id: 'runExecutable'}).success).toBe(false);
  });

  it('defaults privileged features to opt-out and rejects arbitrary engines', () => {
    const preferences = windowsAiPreferencesSchema.parse({});
    expect(preferences).toMatchObject({windowsEnabled: false, modelDownloadsAllowed: false, agentsEnabled: false, appContentEnabled: false, dictationEnabled: false});
    expect(windowsAiPreferencesSchema.safeParse({localEngine: 'https://other-provider.example'}).success).toBe(false);
  });

  it('rejects oversize text and arbitrary native operations', () => {
    const request = {requestId: 'safe-request', engine: 'windows', task: 'summarize', text: 'Some bounded text.'};
    expect(windowsAiTextRequestSchema.safeParse(request).success).toBe(true);
    expect(windowsAiTextRequestSchema.safeParse({...request, text: 'x'.repeat(65_537)}).success).toBe(false);
    expect(windowsAiTextRequestSchema.safeParse({...request, task: 'execute'}).success).toBe(false);
    expect(windowsAiTextRequestSchema.safeParse({...request, requestId: '../untrusted'}).success).toBe(false);
  });
});
