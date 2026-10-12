import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {AppProviders} from '../../../app/AppProviders';
import {useSettingsStore} from '../settings.store';
import {PrivacyPage} from './PrivacyPage';
import {createLocalDataService} from '../../../services/settings/local-data-service';

vi.mock('../../../design-system/icons/LumenUiIcon', () => ({
  LumenUiIcon: ({name, ...props}: {name: string}) => <svg {...props} data-lumen-ui-icon={name} />,
}));

function renderPage() {
  return render(
    <AppProviders appearance={{mode: 'dark', transparency: 'disabled', effects: 'reduced', motion: 'reduced'}}>
      <PrivacyPage />
    </AppProviders>,
  );
}

afterEach(() => {
  useSettingsStore.getState().reset();
});

describe('PrivacyPage', () => {
  it('dismisses confirmation when the native diagnostic save dialog is cancelled', async () => {
    const user = userEvent.setup();
    const service = createLocalDataService();
    vi.spyOn(service, 'exportDiagnostics').mockResolvedValue({saved: false});
    render(<AppProviders><PrivacyPage localDataService={service} /></AppProviders>);
    await user.click(screen.getByRole('button', {name: 'Export'}));
    await user.click(screen.getByRole('button', {name: 'Prepare sanitized export'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Diagnostic export cancelled.')).toBeVisible();
    expect(screen.queryByText('The operation could not be completed. Try again.')).not.toBeInTheDocument();
  });
  it('supplies the storage glyph to Delete index', () => {
    renderPage();

    expect(screen.getByRole('button', {name: 'Delete index'}).querySelector('svg')).toHaveAttribute('data-lumen-ui-icon', 'storage');
  });
});
