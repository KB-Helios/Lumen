import {useEffect, useRef, type RefObject} from 'react';
import {Dialog, Modal, ModalOverlay} from 'react-aria-components';
import {AnimatePresence, motion} from 'motion/react';

import {LumenUiIcon} from '../../design-system/icons/LumenUiIcon';
import {motionTokens} from '../../design-system/motion';
import type {SearchService} from '../../services/search/search-service';
import type {SearchError} from '../../services/search/search.types';
import {PreviewContent} from './PreviewContent';
import {PreviewSkeleton} from './PreviewSkeleton';
import {PreviewAiTools} from '../windows-ai/PreviewAiTools';
import {usePreviewController, type PreviewController} from './usePreviewController';

export type PreviewPresentation = 'pane' | 'dialog';

export interface PreviewPaneProps {
  fileId: string | null;
  isOpen?: boolean;
  mode?: PreviewPresentation;
  reducedMotion?: boolean;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  service: SearchService;
  onOpenChange?: (isOpen: boolean) => void;
}

function stateTitle(controller: PreviewController) {
  if (controller.preview) return controller.preview.title;
  if (controller.lifecycle === 'loading') return 'Loading preview';
  if (controller.lifecycle === 'error') return controller.error?.code === 'permission-denied' ? 'Permission required' : 'Preview unavailable';
  return 'Preview';
}

function PreviewError({error}: {error: SearchError | null}) {
  const title = error?.code === 'permission-denied' ? 'Permission required' : 'Preview unavailable';
  return (
    <div role="alert" className="grid min-h-70 place-items-center content-center gap-3 bg-canvas high-contrast:bg-[Canvas] p-6 text-center" data-preview-surface="opaque">
      <span aria-hidden="true" className="grid size-10 place-items-center rounded-full bg-[color-mix(in_srgb,var(--lumen-danger)_18%,transparent)] font-display text-xl text-danger">!</span>
      <span className="font-sans text-[0.9375rem] font-semibold text-[color:var(--einui-command-text)]">{title}</span>
      <span className="font-sans text-sm text-text-secondary">{error?.message ?? 'This file cannot be previewed.'}</span>
    </div>
  );
}

function PreviewState({controller, reducedMotion}: {controller: PreviewController; reducedMotion: boolean}) {
  if (controller.lifecycle === 'loading') return <PreviewSkeleton reducedMotion={reducedMotion} />;
  if (controller.lifecycle === 'error') return <PreviewError error={controller.error} />;
  if (controller.preview) return <PreviewContent preview={controller.preview} />;
  return <div className="grid min-h-70 place-items-center content-center gap-3 bg-canvas high-contrast:bg-[Canvas] p-6 text-center" data-preview-surface="opaque"><span className="font-sans text-[0.9375rem] text-text-secondary">Select a result to preview</span><span className="font-sans text-[0.6875rem] text-[color:var(--einui-command-muted-text)]">Alt + Enter opens file details</span></div>;
}

function PreviewFrame({
  controller,
  mode,
  reducedMotion,
  onClose,
}: {
  controller: PreviewController;
  mode: PreviewPresentation;
  reducedMotion: boolean;
  onClose?: () => void;
}) {
  const title = stateTitle(controller);
  const subtitle = controller.preview?.subtitle;
  return (
    <div className={mode === 'pane' ? 'grid h-full min-h-80 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-l border-[color:var(--einui-command-divider)]' : 'grid max-h-inherit grid-rows-[auto_minmax(0,1fr)] overflow-hidden'}>
      <header className="grid min-h-[66px] min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[color:var(--einui-command-divider)] px-4 py-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="truncate font-sans text-[0.9375rem] font-semibold text-[color:var(--einui-command-text)]">{title}</span>
          {subtitle ? <span className="truncate font-sans text-[0.6875rem] text-[color:var(--einui-command-muted-text)]" title={subtitle}>{subtitle}</span> : null}
        </div>
        {onClose ? <button aria-label="Close details" className="grid size-8 place-items-center rounded-control text-[color:var(--einui-command-muted-text)] outline-none transition-colors duration-[90ms] hover:bg-[var(--einui-command-row-hover)] hover:text-[color:var(--einui-command-text)] focus-visible:ring-2 focus-visible:ring-focus" type="button" onClick={onClose}><LumenUiIcon name="close" size="small" /></button> : null}
      </header>
      <div className="min-h-0 overflow-auto [scrollbar-color:var(--einui-command-divider)_transparent] [scrollbar-width:thin]">
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={`${controller.lifecycle}-${controller.preview?.fileId ?? 'none'}`}
            animate={{opacity: 1, x: 0}}
            exit={reducedMotion ? undefined : {opacity: 0, x: -6}}
            initial={reducedMotion ? false : {opacity: 0, x: 8}}
            transition={{duration: reducedMotion ? 0 : motionTokens.duration.preview}}
          >
            <PreviewState controller={controller} reducedMotion={reducedMotion} />
            {controller.preview ? <PreviewAiTools preview={controller.preview} /> : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

export function PreviewPane({
  fileId,
  isOpen = true,
  mode = 'pane',
  reducedMotion = false,
  restoreFocusRef,
  service,
  onOpenChange,
}: PreviewPaneProps) {
  const controller = usePreviewController(mode === 'dialog' && !isOpen ? null : fileId, service);
  const wasOpen = useRef(isOpen);

  useEffect(() => {
    if (wasOpen.current && !isOpen) restoreFocusRef?.current?.focus();
    wasOpen.current = isOpen;
  }, [isOpen, restoreFocusRef]);

  if (mode === 'pane') {
    return <section aria-label="File preview" className="h-full min-h-0 w-full" tabIndex={0}><PreviewFrame controller={controller} mode={mode} reducedMotion={reducedMotion} /></section>;
  }

  return (
    <ModalOverlay
      isDismissable
      isOpen={isOpen}
      className="lumen-preview-overlay fixed inset-0 z-50 grid place-items-center bg-scrim p-4 backdrop-blur-sm"
      onOpenChange={onOpenChange}
    >
      <Modal className="lumen-preview-modal max-h-[min(620px,calc(100vh-32px))] w-[min(620px,calc(100vw-32px))] overflow-hidden rounded-surface border border-[color:var(--einui-command-divider)] bg-canvas high-contrast:bg-[Canvas] shadow-surface outline-none" data-preview-surface="opaque">
        <Dialog aria-label="File details" className="max-h-inherit outline-none">
          <PreviewFrame controller={controller} mode={mode} reducedMotion={reducedMotion} onClose={() => onOpenChange?.(false)} />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
