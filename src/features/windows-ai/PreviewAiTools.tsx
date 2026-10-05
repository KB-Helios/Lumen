import {useEffect, useRef, useState} from 'react';
import {LumenButton} from '../../design-system/primitives/LumenButton';
import {LumenText} from '../../design-system/primitives/LumenText';
import type {FilePreview} from '../../services/search/search.types';
import {windowsAiService} from '../../services/windows-ai';
import {canUseWindowsAiFeature, defaultWindowsAiPreferences, type WindowsAiFeatureId, type WindowsAiTextTask} from '../../services/windows-ai/windows-ai.types';
import {useLauncherStore} from '../launcher/launcher.store';
import {useWindowsAiStore} from './windows-ai.store';

export function PreviewAiTools({preview}: {preview: FilePreview}) {
  const snapshot = useWindowsAiStore((state) => state.snapshot);
  const visible = useLauncherStore((state) => state.visible);
  const preferences = snapshot?.preferences ?? defaultWindowsAiPreferences;
  const [output, setOutput] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    setOutput(''); setMessage(''); setBusy(false);
    return () => abort.current?.abort();
  }, [preview.fileId]);
  useEffect(() => { if (!visible) abort.current?.abort(); }, [visible]);
  const ready = (id: WindowsAiFeatureId) => canUseWindowsAiFeature(snapshot?.features.find((feature) => feature.id === id));
  const engine = preferences.localEngine === 'edge' ? 'edge' : preferences.localEngine === 'aion' ? 'aion' : 'windows';
  const featureFor = (task: WindowsAiTextTask): WindowsAiFeatureId => task === 'translate' ? 'edgeTranslation' : task === 'detectLanguage' ? 'edgeLanguageDetection' : engine === 'edge' ? task === 'summarize' ? 'edgeSummarize' : task === 'rewrite' ? 'edgeRewrite' : 'edgeWrite' : engine === 'aion' ? 'aion' : task === 'summarize' ? 'summarize' : task === 'rewrite' ? 'rewrite' : 'languageModel';
  const run = async (task: WindowsAiTextTask | 'ocr' | 'describe') => {
    if (busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setOutput(''); setMessage('Working on this preview…');
    try {
      const requestId = `preview-${crypto.randomUUID()}`;
      const result = task === 'ocr' || task === 'describe'
        ? await windowsAiService.image({requestId, operation: task, fileId: preview.fileId}, undefined, controller.signal)
        : await windowsAiService.text({requestId, engine: task === 'translate' || task === 'detectLanguage' ? 'edge' : engine, task, text: preview.text ?? '', sourceLanguage: preferences.sourceLanguage, targetLanguage: preferences.targetLanguage}, undefined, controller.signal);
      if (!controller.signal.aborted) { setOutput(result.text); setMessage(`Generated locally${result.model ? ` with ${result.model}` : ''}.`); }
    } catch { if (!controller.signal.aborted) setMessage('This tool could not run. Check its availability and permissions in settings.'); }
    finally { if (abort.current === controller) { abort.current = null; setBusy(false); if (controller.signal.aborted) setMessage('Cancelled.'); } }
  };
  const text = Boolean(preview.text?.trim()) && preferences.textToolsEnabled;
  const image = preview.kind === 'image' && (preferences.ocrEnabled || preferences.imageDescriptionsEnabled);
  if (!text && !image) return null;
  return <section aria-label="On-device preview tools" className="grid gap-3 border-t border-border-subtle bg-surface-inset p-4">
    <LumenText variant="meta" weight="medium">On-device tools</LumenText>
    <div className="flex flex-wrap gap-2">
      {text ? (['summarize', 'rewrite', 'write', 'translate', 'detectLanguage'] as const).map((task) => <LumenButton key={task} aria-label={`${task === 'detectLanguage' ? 'Detect language' : task[0].toUpperCase() + task.slice(1)} preview text`} size="small" variant="quiet" isDisabled={busy || !ready(featureFor(task))} onPress={() => void run(task)}>{task === 'detectLanguage' ? 'Detect language' : task[0].toUpperCase() + task.slice(1)}</LumenButton>) : null}
      {image && preferences.ocrEnabled ? <LumenButton size="small" variant="quiet" isDisabled={busy || !ready('ocr')} onPress={() => void run('ocr')}>Extract image text</LumenButton> : null}
      {image && preferences.imageDescriptionsEnabled ? <LumenButton size="small" variant="quiet" isDisabled={busy || !ready('imageDescription')} onPress={() => void run('describe')}>Describe image</LumenButton> : null}
      {busy ? <LumenButton size="small" variant="quiet" onPress={() => abort.current?.abort()}>Stop tool</LumenButton> : null}
    </div>
    <LumenText role="status" tone="secondary" variant="caption">{message || 'Tools require a ready model. Manage permissions and languages in Privacy settings.'}</LumenText>
    {output ? <div aria-label="Generated preview text" className="max-h-48 overflow-auto whitespace-pre-wrap rounded-control border border-border-subtle bg-canvas p-3 text-sm text-text-primary">{output}</div> : null}
  </section>;
}
