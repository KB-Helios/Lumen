import type {
  AppContentMatch, WindowsAgentActivation, WindowsAiEvent, WindowsAiFeatureId,
  WindowsAiImageRequest, WindowsAiOperationResult, WindowsAiPreferences,
  WindowsAiSnapshot, WindowsAiTextRequest, WindowsAiTextResult,
} from './windows-ai.types';

export type WindowsAiEventListener = (event: WindowsAiEvent) => void;
export interface DictationSession {stop(): void;}
export interface DictationListener {onText(text: string, final: boolean): void; onEnd(): void; onError(message: string): void;}

export interface WindowsAiService {
  status(): Promise<WindowsAiSnapshot>;
  updatePreferences(patch: Partial<WindowsAiPreferences>): Promise<WindowsAiSnapshot>;
  prepare(featureId: WindowsAiFeatureId, requestId: string, onEvent?: WindowsAiEventListener, signal?: AbortSignal): Promise<WindowsAiSnapshot>;
  text(request: WindowsAiTextRequest, onEvent?: WindowsAiEventListener, signal?: AbortSignal): Promise<WindowsAiTextResult>;
  image(request: WindowsAiImageRequest, onEvent?: WindowsAiEventListener, signal?: AbortSignal): Promise<WindowsAiTextResult>;
  searchContent(query: string, signal?: AbortSignal): Promise<AppContentMatch[]>;
  rebuildContent(): Promise<WindowsAiOperationResult>;
  deleteContent(): Promise<WindowsAiOperationResult>;
  invokeAgent(agentId: string, prompt: string): Promise<WindowsAiOperationResult>;
  setRegistration(enabled: boolean): Promise<WindowsAiSnapshot>;
  setAccessToken(token: string): Promise<WindowsAiSnapshot>;
  cancel(requestId: string): Promise<void>;
  consumeActivation(): Promise<WindowsAgentActivation | null>;
  subscribe(listener: (snapshot: WindowsAiSnapshot) => void): () => void;
  startDictation(listener: DictationListener): Promise<DictationSession>;
}
