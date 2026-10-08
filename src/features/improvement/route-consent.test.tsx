import {render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {AppProviders} from '../../app/AppProviders';
import {ProviderRegistryList} from '../gateway/ProviderRegistryList';
import type {ProviderRegistrySnapshot} from '../../services/ai/provider-registry-service';
const registry: ProviderRegistrySnapshot = {providers: [{id: 'openai', label: 'OpenAI', cloud: true, credentialConfigured: true}], models: [{id: 'cloud', label: 'Cloud model', providerId: 'openai', capabilities: ['answer']}], routes: ['lumen.answer.cloud', 'lumen.improvement.cloud'].map((alias) => ({alias, capability: 'answer', providerId: 'openai', modelId: 'cloud', status: 'needsConsent', baseUrl: null, upstreamModel: null}))};
describe('independent improvement route consent', () => {
  it('answer consent cannot grant improvement routes', () => {
    render(<AppProviders><ProviderRegistryList registry={registry} cloudConsent improvementCloudConsent={false} onSet={async () => undefined} onTest={async () => undefined} /></AppProviders>);
    expect(screen.getByLabelText('Model for lumen.answer.cloud')).toBeEnabled();
    expect(screen.getByLabelText('Model for lumen.improvement.cloud')).toBeDisabled();
  });
  it('improvement consent does not require or grant answer consent', () => {
    render(<AppProviders><ProviderRegistryList registry={registry} cloudConsent={false} improvementCloudConsent onSet={async () => undefined} onTest={async () => undefined} /></AppProviders>);
    expect(screen.getByLabelText('Model for lumen.answer.cloud')).toBeDisabled();
    expect(screen.getByLabelText('Model for lumen.improvement.cloud')).toBeEnabled();
  });
});
