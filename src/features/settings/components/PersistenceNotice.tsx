import {LumenText} from '../../../design-system/primitives/LumenText';
import {useSettingsStore} from '../settings.store';
import {useAppearanceStore} from '../../../state/appearance.store';
import {StatusBadge} from './StatusBadge';

export function PersistenceNotice() {
  const status = useSettingsStore((state) => state.persistenceStatus);
  const error = useSettingsStore((state) => state.persistenceError);
  const appearanceStatus = useAppearanceStore((state) => state.persistenceStatus);
  const appearanceError = useAppearanceStore((state) => state.persistenceError);
  if (status === 'error' || appearanceStatus === 'error') {
    return <LumenText role="alert" tone="secondary">{[status === 'error' ? error ?? 'Settings could not be saved.' : '', appearanceStatus === 'error' ? appearanceError?.message ?? 'Appearance could not be saved.' : ''].filter(Boolean).join(' ')}</LumenText>;
  }
  if (status === 'saving' || appearanceStatus === 'saving') {
    return <StatusBadge tone="info">Saving</StatusBadge>;
  }
  return null;
}
