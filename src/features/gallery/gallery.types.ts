import type {AppearancePreferences} from '../../design-system/theme';
import type {ActivityMode} from '../activity/activity.types';
import type {GatewayState, HardwareState, ModelState} from '../gateway/gateway.types';
import type {SettingsPageId} from '../settings/settings.schema';

export const requiredScenarioIds = [
  'collapsed-idle',
  'collapsed-focused',
  'collapsed-typing',
  'expanded-results',
  'grouped-results',
  'selected-result',
  'preview-loading',
  'preview-complete',
  'preview-failed',
  'ai-waiting',
  'ai-streaming',
  'ai-complete',
  'ai-failure-local-results',
  'empty-local-with-answer',
  'empty-results',
  'no-indexed-root',
  'activity-indexing',
  'activity-slow',
  'activity-gaming',
  'activity-fullscreen',
  'activity-cinema',
  'activity-idle',
  'activity-battery',
  'activity-user',
  'provider-npu',
  'provider-gpu',
  'provider-cpu',
  'provider-unavailable',
  'model-missing',
  'model-downloading',
  'model-loading',
  'model-ready',
  'model-failed',
  'model-fallback-active',
  'gateway-starting',
  'gateway-ready',
  'gateway-unavailable',
  'gateway-restarting',
  'reranking-unavailable',
  'permission-required',
  'long-filename',
  'unicode-filename',
  'large-results',
  'theme-light',
  'theme-dark',
  'theme-opaque',
  'theme-high-contrast',
  'theme-reduced-motion',
  'computer-use-approval',
  'constrained-work-area',
  'settings-general',
  'settings-agent-gateway',
  'onboarding-welcome',
  'windows-ai-ready',
  'windows-ai-unavailable',
  'windows-ai-preparing',
  'windows-ai-failed',
] as const;

export type GalleryScenarioId = (typeof requiredScenarioIds)[number];
export type GalleryPreviewState = 'none' | 'loading' | 'complete' | 'failed';
export type GalleryResultSet = 'standard' | 'grouped' | 'empty' | 'permission' | 'long' | 'unicode' | 'large';
export type GalleryAnswerState = 'waiting' | 'streaming' | 'complete' | 'failed';

export interface GalleryLauncherState {
  mode: 'collapsed' | 'expanded';
  query: string;
  composing?: boolean;
  resultSet?: GalleryResultSet;
  selectedIndex?: number;
  preview?: GalleryPreviewState;
  answer?: GalleryAnswerState;
  constrained?: boolean;
  focusOnMount?: boolean;
  noRoot?: boolean;
}

export type GallerySurface =
  | {kind: 'launcher'; state: GalleryLauncherState}
  | {kind: 'activity'; mode: ActivityMode}
  | {kind: 'local-ai'; hardware: HardwareState; model: ModelState; progress?: number}
  | {kind: 'gateway'; state: GatewayState}
  | {kind: 'settings-page'; page: SettingsPageId}
  | {kind: 'settings-shell'; page: SettingsPageId}
  | {kind: 'onboarding'; step: number}
  | {kind: 'computer-use'; state: 'approval'}
  | {kind: 'windows-ai'; state: 'ready' | 'unavailable' | 'preparing' | 'failed'};

export interface GalleryScenario {
  id: GalleryScenarioId;
  label: string;
  description: string;
  category: 'Launcher' | 'Preview' | 'Activity' | 'Local AI' | 'Gateway' | 'Resilience' | 'Theme' | 'Management' | 'Computer Use';
  appearance?: AppearancePreferences;
  forceHighContrast?: boolean;
  surface: GallerySurface;
}
