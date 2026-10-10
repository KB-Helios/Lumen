import {LumenUiIcon} from '../../design-system/icons/LumenUiIcon';
import {LumenIconButton} from '../../design-system/primitives/LumenIconButton';
import {LumenText} from '../../design-system/primitives/LumenText';
import {LumenSelect} from '../settings/components/SettingsControls';
import type {ApplicationOverride} from '../settings/settings.schema';

export function ApplicationOverrideRow({isDisabled, override, onChange, onRemove}: {
  isDisabled?: boolean;
  override: ApplicationOverride;
  onChange(override: ApplicationOverride): void;
  onRemove(): void;
}) {
  return (
    <div className="grid min-h-[58px] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border-subtle p-5 last:border-b-0">
      <LumenText weight="medium">{override.application}</LumenText>
      <LumenSelect
        isDisabled={isDisabled}
        aria-label={`Policy for ${override.application}`}
        options={[
          {id: 'automatic', label: 'Automatic'},
          {id: 'pause', label: 'Always pause'},
          {id: 'cinema', label: 'Cinema mode'},
          {id: 'allow', label: 'Allow indexing'},
        ]}
        value={override.policy}
        onChange={(policy) => onChange({...override, policy})}
      />
      <LumenIconButton isDisabled={isDisabled} aria-label={`Remove ${override.application}`} size="small" variant="quiet" onPress={onRemove}>
        <LumenUiIcon name="delete" size="small" />
      </LumenIconButton>
    </div>
  );
}
