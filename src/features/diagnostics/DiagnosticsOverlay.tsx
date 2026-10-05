import {useEffect} from 'react';

import {LumenUiIcon} from '../../design-system/icons/LumenUiIcon';
import {LumenIconButton} from '../../design-system/primitives/LumenIconButton';
import {LumenText} from '../../design-system/primitives/LumenText';
import {DiagnosticItem} from './DiagnosticItem';
import {useDiagnosticsStore} from './diagnostics.store';

export function DiagnosticsOverlay() {
  const open = useDiagnosticsStore((state) => state.overlayOpen);
  const snapshot = useDiagnosticsStore((state) => state.snapshot);
  const refresh = useDiagnosticsStore((state) => state.refresh);
  const setOverlay = useDiagnosticsStore((state) => state.setOverlay);
  const toggleOverlay = useDiagnosticsStore((state) => state.toggleOverlay);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        toggleOverlay();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [toggleOverlay]);

  if (!open) return null;

  const latestInput = [...snapshot.timings].reverse().find((sample) => sample.name === 'input-response');
  const latestSelection = [...snapshot.timings].reverse().find((sample) => sample.name === 'selection-paint');

  return (
    <aside aria-label="Performance diagnostics" className="fixed top-4 right-4 z-50 max-h-[calc(100vh-32px)] w-[min(340px,calc(100vw-32px))] overflow-y-auto rounded-surface border border-border-strong bg-surface-raised text-text-primary shadow-surface">
      <div className="sticky top-0 z-10 flex min-h-[46px] items-center justify-between gap-4 border-b border-border-subtle bg-surface-raised px-5">
        <LumenText weight="semibold">Performance</LumenText>
        <div className="flex items-center gap-1">
          <LumenIconButton aria-label="Refresh diagnostics" size="small" variant="quiet" onPress={refresh}>
            <LumenUiIcon name="refresh" size="small" />
          </LumenIconButton>
          <LumenIconButton aria-label="Close diagnostics" size="small" variant="quiet" onPress={() => setOverlay(false)}>
            <LumenUiIcon name="close" size="small" />
          </LumenIconButton>
        </div>
      </div>
      <DiagnosticItem label="Refresh estimate">{snapshot.refreshRateHz === null ? 'Not measured' : `${snapshot.refreshRateHz} Hz`}</DiagnosticItem>
      <DiagnosticItem label="DPI scale">{Math.round(snapshot.dpiScale * 100)}%</DiagnosticItem>
      <DiagnosticItem label="React commit">{snapshot.reactCommitMs.toFixed(2)} ms</DiagnosticItem>
      <DiagnosticItem label="Input handler">{latestInput ? `${latestInput.durationMs.toFixed(2)} ms` : 'Awaiting sample'}</DiagnosticItem>
      <DiagnosticItem label="Selection to next frame">{latestSelection ? `${latestSelection.durationMs.toFixed(2)} ms` : 'Awaiting sample'}</DiagnosticItem>
      <DiagnosticItem label="Browser long tasks (50 ms+)">{snapshot.browserLongTasks.length}</DiagnosticItem>
      <DiagnosticItem label="Active animations">{snapshot.activeAnimations}</DiagnosticItem>
    </aside>
  );
}
