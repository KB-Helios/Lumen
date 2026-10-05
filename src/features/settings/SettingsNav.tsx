import type {ReactNode} from 'react';

import {Tab, TabList} from 'react-aria-components';

import {LumenUiIcon} from '../../design-system/icons/LumenUiIcon';
import type {SettingsPageId} from './settings.schema';

export interface SettingsPageDefinition {
  id: SettingsPageId;
  label: string;
  description: string;
  icon: ReactNode;
}

export const settingsPages: readonly SettingsPageDefinition[] = [
  {id: 'general', label: 'General', description: 'Startup, shortcut, and window behavior', icon: <LumenUiIcon className="size-[18px]" name="settings" />},
  {id: 'appearance', label: 'Appearance', description: 'Material, theme, density, and motion', icon: <LumenUiIcon className="size-[18px]" name="colorTheme" />},
  {id: 'indexed-roots', label: 'Indexed roots', description: 'Folders and exclusion policies', icon: <LumenUiIcon className="size-[18px]" name="folder" />},
  {id: 'search', label: 'Search', description: 'Scopes and ranking priorities', icon: <LumenUiIcon className="size-[18px]" name="search" />},
  {id: 'local-ai', label: 'Local AI', description: 'Hardware and model readiness', icon: <LumenUiIcon className="size-[18px]" name="hardware" />},
  {id: 'agent-gateway', label: 'AgentGateway', description: 'Providers, routes, MCP, and consent', icon: <LumenUiIcon className="size-[18px]" name="connect" />},
  {id: 'providers', label: 'Providers', description: 'Switch model providers across local tools', icon: <LumenUiIcon className="size-[18px]" name="key" />},
  {id: 'computer-use', label: 'Computer Use', description: 'Gemini browser agent, consent, and approvals', icon: <LumenUiIcon className="size-[18px]" name="computer" />},
  {id: 'activity', label: 'Activity', description: 'Quiet modes and background work', icon: <LumenUiIcon className="size-[18px]" name="pulse" />},
  {id: 'privacy', label: 'Privacy', description: 'Local data and destructive actions', icon: <LumenUiIcon className="size-[18px]" name="privacy" />},
  {id: 'diagnostics', label: 'Diagnostics', description: 'Runtime status and performance evidence', icon: <LumenUiIcon className="size-[18px]" name="pulse" />},
];

export function SettingsNav() {
  return (
    <nav aria-label="Settings" className="min-w-0">
      <TabList aria-label="Settings pages" items={settingsPages} className="grid min-w-0 content-start gap-[4px] p-[8px]">
        {(page) => (
          <Tab
            id={page.id}
            className={({isFocusVisible, isHovered, isSelected}) => [
              'flex min-h-[40px] min-w-0 cursor-default items-center gap-[10px] rounded-control px-[10px] py-[8px] font-sans text-sm font-medium text-text-secondary outline-none transition-[background-color,color,box-shadow] duration-[var(--lumen-duration-selection)] ease-standard',
              isHovered ? 'bg-surface-raised text-text-primary' : '',
              isSelected ? 'bg-surface-raised text-text-primary shadow-[inset_3px_0_0_var(--lumen-accent)]' : '',
              isFocusVisible ? 'ring-2 ring-focus/70' : '',
            ].filter(Boolean).join(' ')}
          >
            <span aria-hidden="true" className="grid shrink-0 text-current">{page.icon}</span>
            <span className="min-w-0 [overflow-wrap:anywhere]">{page.label}</span>
          </Tab>
        )}
      </TabList>
    </nav>
  );
}
