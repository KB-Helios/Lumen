import {Channel, invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {z} from 'zod';
import type {WindowsAiEventListener, WindowsAiService} from './windows-ai-service';
import {resolvePublicMatches} from './catalogue';
import {appContentMatchSchema, windowsAgentActivationSchema, windowsAgentSchema, windowsAiEventSchema, windowsAiFeatureIdSchema, windowsAiImageRequestSchema, windowsAiOperationResultSchema, windowsAiPreferencePatchSchema, windowsAiRequestIdSchema, windowsAiSnapshotSchema, windowsAiTextRequestSchema, windowsAiTextResultSchema, type WindowsAiFeatureId, type WindowsAiImageRequest, type WindowsAiPreferences, type WindowsAiSnapshot, type WindowsAiTextRequest} from './windows-ai.types';

export class TauriWindowsAiService implements WindowsAiService {
  async status() { return windowsAiSnapshotSchema.parse(await invoke('windows_ai_status')); }
  async updatePreferences(patch: Partial<WindowsAiPreferences>) { return windowsAiSnapshotSchema.parse(await invoke('windows_ai_update_preferences', {patch: windowsAiPreferencePatchSchema.parse(patch)})); }
  private async operation(command: string, args: Record<string, unknown>, requestId: string, listener?: WindowsAiEventListener, signal?: AbortSignal): Promise<unknown> {
    windowsAiRequestIdSchema.parse(requestId);
    signal?.throwIfAborted();
    let protocolError: Error | undefined;
    let finished = false;
    const channel = new Channel<unknown>();
    channel.onmessage = (payload) => {
      if (finished || signal?.aborted) return;
      const parsed = windowsAiEventSchema.safeParse(payload);
      if (!parsed.success) { protocolError = new Error('The Windows AI worker sent an invalid event.'); void this.cancel(requestId).catch(() => undefined); return; }
      if (parsed.data.requestId === requestId) listener?.(parsed.data);
    };
    const cancel = () => { void this.cancel(requestId).catch(() => undefined); };
    signal?.addEventListener('abort', cancel, {once: true});
    try {
      const result = await invoke(command, {...args, onEvent: channel});
      signal?.throwIfAborted();
      if (protocolError) throw protocolError;
      return result;
    } finally { finished = true; signal?.removeEventListener('abort', cancel); }
  }
  async prepare(featureId: WindowsAiFeatureId, requestId: string, listener?: WindowsAiEventListener, signal?: AbortSignal) { return windowsAiSnapshotSchema.parse(await this.operation('windows_ai_prepare', {featureId: windowsAiFeatureIdSchema.parse(featureId), requestId}, requestId, listener, signal)); }
  async text(request: WindowsAiTextRequest, listener?: WindowsAiEventListener, signal?: AbortSignal) { return windowsAiTextResultSchema.parse(await this.operation('windows_ai_text', {request: windowsAiTextRequestSchema.parse(request)}, request.requestId, listener, signal)); }
  async image(request: WindowsAiImageRequest, listener?: WindowsAiEventListener, signal?: AbortSignal) { return windowsAiTextResultSchema.parse(await this.operation('windows_ai_image', {request: windowsAiImageRequestSchema.parse(request)}, request.requestId, listener, signal)); }
  async searchContent(query: string, signal?: AbortSignal) { signal?.throwIfAborted(); const result = z.array(appContentMatchSchema).max(20).parse(await invoke('windows_ai_search_content', {query: z.string().trim().min(1).max(4000).parse(query)})); signal?.throwIfAborted(); return resolvePublicMatches(result); }
  async rebuildContent() { return windowsAiOperationResultSchema.parse(await invoke('windows_ai_rebuild_content')); }
  async deleteContent() { return windowsAiOperationResultSchema.parse(await invoke('windows_ai_delete_content')); }
  async discoverAgents() { return z.array(windowsAgentSchema).max(128).parse(await invoke('windows_ai_discover_agents')); }
  async invokeAgent(agentId: string, prompt: string) { return windowsAiOperationResultSchema.parse(await invoke('windows_ai_invoke_agent', {agentId: z.string().min(1).max(512).parse(agentId), prompt: z.string().trim().min(1).max(4000).parse(prompt)})); }
  async setRegistration(enabled: boolean) { return windowsAiSnapshotSchema.parse(await invoke('windows_ai_set_registration', {enabled})); }
  async setAccessToken(token: string) { return windowsAiSnapshotSchema.parse(await invoke('windows_ai_set_access_token', {token: z.string().max(4096).parse(token)})); }
  async cancel(requestId: string) { await invoke('windows_ai_cancel', {requestId: windowsAiRequestIdSchema.parse(requestId)}); }
  async consumeActivation() { return windowsAgentActivationSchema.nullable().parse(await invoke('windows_ai_consume_activation')); }
  private event(name: string, callback: (payload: unknown) => void) {
    let disposed = false;
    const registration = listen<unknown>(name, (event) => { if (!disposed) callback(event.payload); });
    return () => { disposed = true; void registration.then((unlisten) => unlisten()).catch(() => undefined); };
  }
  subscribe(listener: (snapshot: WindowsAiSnapshot) => void) { return this.event('lumen://windows-ai-status', (payload) => { const result = windowsAiSnapshotSchema.safeParse(payload); if (result.success) listener(result.data); }); }
  subscribeActivation(listener: () => void) { return this.event('lumen://windows-agent-activation', listener); }
  async startDictation(): Promise<never> { throw new Error('Dictation requires a local speech API in the current web host.'); }
}
