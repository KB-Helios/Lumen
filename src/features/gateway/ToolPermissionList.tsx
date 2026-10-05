import {LumenText} from '../../design-system/primitives/LumenText';
import {LumenSelect} from '../settings/components/SettingsControls';
import type {ToolAccess, ToolPermission} from './gateway.types';

export function ToolPermissionList({permissions, onChange}: {
  permissions: ToolPermission[];
  onChange(id: string, access: ToolAccess): void;
}) {
  return (
    <div className="min-w-0">
      {permissions.map((permission) => (
        <div key={permission.id} className="grid min-h-[66px] min-w-0 grid-cols-[minmax(0,1fr)] items-center gap-[12px] border-b border-border-subtle p-[16px] last:border-b-0 @min-[32rem]/settings:grid-cols-[minmax(0,1fr)_minmax(0,.85fr)]">
          <div className="grid min-w-0 gap-1">
            <LumenText weight="medium">{permission.label}</LumenText>
            <LumenText tone="tertiary" variant="meta">{permission.description}</LumenText>
          </div>
          <LumenSelect
            aria-label={`Permission for ${permission.label}`}
            options={[{id: 'ask', label: 'Ask every time'}, {id: 'allow', label: 'Allow'}, {id: 'deny', label: 'Deny'}]}
            value={permission.access}
            onChange={(access) => onChange(permission.id, access)}
          />
        </div>
      ))}
    </div>
  );
}
