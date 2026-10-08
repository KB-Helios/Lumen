import {render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {UsagePanel} from './UsagePanel';

describe('UsagePanel', () => {
  it('renders native provider counters without folding credential maps in React', async () => {
    render(<UsagePanel api={{apiKeyUsage: async () => [{provider: 'codex', success: 3, failed: 2, total: 5}]}} />);
    const log = await screen.findByRole('table', {name: 'Request log'});
    expect(log).toHaveTextContent('codex');
    expect(log).toHaveTextContent('3');
    expect(log).toHaveTextContent('2');
    expect(log).toHaveTextContent('5');
  });

  it('rejects raw credential maps before placing usage in UI state', async () => {
    render(<UsagePanel api={{apiKeyUsage: async () => ({codex: {'sk-audit-secret': {success: 3, failed: 2}}})}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid response');
    expect(document.body).not.toHaveTextContent('sk-audit-secret');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
