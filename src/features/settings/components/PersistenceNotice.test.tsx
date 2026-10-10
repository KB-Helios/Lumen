import {render, screen} from '@testing-library/react';
import {afterEach, expect, it} from 'vitest';
import {appearanceStore} from '../../../state/appearance.store';
import {useSettingsStore} from '../settings.store';
import {PersistenceNotice} from './PersistenceNotice';

afterEach(() => {useSettingsStore.getState().reset(); appearanceStore.setState({persistenceStatus: 'idle', persistenceError: null});});

it('reports settings and appearance failures together in the shared notice', () => {
  useSettingsStore.setState({persistenceStatus: 'error', persistenceError: 'Settings disk error'});
  appearanceStore.setState({persistenceStatus: 'error', persistenceError: {code: 'settings-write-failed', message: 'Appearance disk error', operation: 'write', recoverable: true}});
  render(<PersistenceNotice />);
  expect(screen.getByRole('alert')).toHaveTextContent('Settings disk error Appearance disk error');
});
