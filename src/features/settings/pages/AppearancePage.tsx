import {LumenMark} from '../../../design-system/icons/LumenMark';
import {LumenText} from '../../../design-system/primitives/LumenText';
import {useAppearanceStore} from '../../../state/appearance.store';
import {SettingRow} from '../components/SettingRow';
import {SettingSection} from '../components/SettingSection';
import {LumenSelect, LumenSlider, LumenSwitch} from '../components/SettingsControls';
import {SettingsPage} from '../components/SettingsPage';
import {useSettingsStore} from '../settings.store';

export function AppearancePage() {
  const mode = useAppearanceStore((state) => state.mode);
  const transparency = useAppearanceStore((state) => state.transparency);
  const density = useAppearanceStore((state) => state.density);
  const preview = useAppearanceStore((state) => state.preview);
  const motion = useAppearanceStore((state) => state.motion);
  const effects = useAppearanceStore((state) => state.effects);
  const setMode = useAppearanceStore((state) => state.setMode);
  const setTransparency = useAppearanceStore((state) => state.setTransparency);
  const setDensity = useAppearanceStore((state) => state.setDensity);
  const setPreview = useAppearanceStore((state) => state.setPreview);
  const setMotion = useAppearanceStore((state) => state.setMotion);
  const setEffects = useAppearanceStore((state) => state.setEffects);
  const presentation = useSettingsStore((state) => state.presentation);
  const updatePresentation = useSettingsStore((state) => state.updatePresentation);

  return (
    <SettingsPage>
      <div aria-label="Appearance preview" className="grid min-h-[118px] min-w-0 place-items-center overflow-hidden rounded-surface border border-border-subtle bg-canvas">
        <div className="flex min-h-[52px] min-w-0 w-[78%] items-center gap-[12px] rounded-surface border border-border-strong bg-surface-glass px-[16px] shadow-surface backdrop-blur-xl" style={{opacity: Math.max(0.55, presentation.glassIntensity / 100)}}>
          <LumenMark size="medium" />
          <span aria-hidden="true" className="h-1.5 flex-1 rounded-pill bg-border-strong" />
          <LumenText tone="tertiary" variant="caption">Preview</LumenText>
        </div>
      </div>
      <SettingSection title="Theme and material">
        <SettingRow label="Appearance" description="Follow Windows or choose a fixed light or dark surface.">
          <LumenSelect
            aria-label="Appearance mode"
            options={[{id: 'system', label: 'System'}, {id: 'light', label: 'Light'}, {id: 'dark', label: 'Dark'}]}
            value={mode}
            onChange={(value) => void setMode(value)}
          />
        </SettingRow>
        <SettingRow label="Use transparency" description="Disable for an opaque, wallpaper-independent surface.">
          <LumenSwitch
            aria-label="Use transparency"
            isSelected={transparency !== 'disabled'}
            onChange={(selected) => void setTransparency(selected ? 'native' : 'disabled')}
          />
        </SettingRow>
        <SettingRow label="Glass intensity" description="Adjust the luminosity of the internal material layers.">
          <LumenSlider
            label="Glass intensity"
            value={presentation.glassIntensity}
            onChange={(glassIntensity) => void updatePresentation({glassIntensity})}
          />
        </SettingRow>
        <SettingRow label="Visual effects" description="Reduce glow, noise, and decorative depth while retaining structure.">
          <LumenSelect
            aria-label="Visual effects"
            options={[{id: 'full', label: 'Full'}, {id: 'reduced', label: 'Reduced'}]}
            value={effects}
            onChange={(value) => void setEffects(value)}
          />
        </SettingRow>
      </SettingSection>
      <SettingSection title="Results and motion">
        <SettingRow label="Result density">
          <LumenSelect
            aria-label="Result density"
            options={[{id: 'comfortable', label: 'Comfortable'}, {id: 'compact', label: 'Compact'}]}
            value={density}
            onChange={(value) => void setDensity(value)}
          />
        </SettingRow>
        <SettingRow label="Preview visibility">
          <LumenSelect
            aria-label="Preview visibility"
            options={[{id: 'automatic', label: 'Automatic'}, {id: 'always', label: 'Always'}, {id: 'never', label: 'Never'}]}
            value={preview}
            onChange={(value) => void setPreview(value)}
          />
        </SettingRow>
        <SettingRow label="Motion level" description="System follows the Windows reduced-motion preference.">
          <LumenSelect
            aria-label="Motion level"
            options={[{id: 'system', label: 'System'}, {id: 'full', label: 'Full'}, {id: 'reduced', label: 'Reduced'}]}
            value={motion}
            onChange={(value) => void setMotion(value)}
          />
        </SettingRow>
        <SettingRow label="Synchronize reduced motion" description="Keep Lumen aligned with the Windows accessibility setting.">
          <LumenSwitch
            aria-label="Synchronize reduced motion"
            isSelected={presentation.synchronizeReducedMotion}
            onChange={(synchronizeReducedMotion) => void updatePresentation({synchronizeReducedMotion})}
          />
        </SettingRow>
      </SettingSection>
    </SettingsPage>
  );
}
