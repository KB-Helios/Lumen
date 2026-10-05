import {useEffect, useRef, useState, type KeyboardEvent} from 'react';

import {AnimatePresence, motion} from 'motion/react';

import {useLumenMotion} from '../../design-system/MotionProvider';
import {LumenUiIcon} from '../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../design-system/primitives/LumenButton';
import {LumenSurface} from '../../design-system/primitives/LumenSurface';
import {LumenText} from '../../design-system/primitives/LumenText';
import {createWindowService} from '../../platform/window/tauri-window-service';
import type {WindowService} from '../../platform/window/window-service';
import {useLauncherStore} from '../launcher/launcher.store';
import {requestWindowShow} from '../launcher/useLauncherPresentation';
import {LumenSelect, LumenSwitch} from '../settings/components/SettingsControls';
import {useSettingsStore} from '../settings/settings.store';
import {OnboardingScene} from './OnboardingScene';
import {
  isValidRoot,
  onboardingSteps,
  useOnboardingStore,
  type OnboardingStep,
} from './onboarding.store';
import {RootSelectionScene} from './RootSelectionScene';
import {
  createRootSelectionService,
  type RootSelectionService,
} from './root-selection-service';
import {ShortcutScene} from './ShortcutScene';

const defaultRootService = createRootSelectionService();

function StandardScene({step}: {step: Exclude<OnboardingStep, 'root' | 'shortcut'>}) {
  if (step === 'welcome') {
    return (
      <OnboardingScene
        description="Find the file you mean before the thought is gone."
        icon={<LumenUiIcon className="size-12" name="search" />}
        support="Fast local search comes first. AI and cloud providers remain optional."
        title="Everything, within reach"
      />
    );
  }
  return <ChoicesScene />;
}

function ChoicesScene() {
  const ai = useSettingsStore((state) => state.ai);
  const updateAi = useSettingsStore((state) => state.updateAi);
  const setCloudAnswerConsent = useSettingsStore((state) => state.setCloudAnswerConsent);
  return (
    <OnboardingScene
      description="Exact local search is always available. AI answers are optional."
      icon={<LumenUiIcon className="size-12" name="hardware" />}
      support="Cloud answers can send the query and relevant local excerpts to your configured provider. Leave this off to keep answers local."
      title="Choose how answers run"
    >
      <div className="@container/choices grid min-w-0 w-full max-w-[560px] gap-[16px] rounded-surface border border-border-subtle bg-surface-inset p-[16px] text-left">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-center gap-[12px] @min-[26rem]/choices:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <LumenText>Answer mode</LumenText>
          <LumenSelect
            aria-label="Answer mode"
            options={[{id: 'auto', label: 'Automatic'}, {id: 'local', label: 'Local only'}]}
            value={ai.runtimeMode === 'cloud' ? 'auto' : ai.runtimeMode}
            onChange={(runtimeMode) => void updateAi({runtimeMode})}
          />
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-[12px]">
          <LumenText>Allow cloud answers</LumenText>
          <LumenSwitch aria-label="Allow cloud answers" isSelected={ai.cloudAnswerConsent} onChange={(granted) => void setCloudAnswerConsent(granted)} />
        </div>
      </div>
    </OnboardingScene>
  );
}

export interface OnboardingFlowProps {
  rootService?: RootSelectionService;
  windowService?: WindowService;
  onComplete?: () => boolean | void | Promise<boolean | void>;
}

export function OnboardingFlow({
  rootService = defaultRootService,
  windowService: providedWindowService,
  onComplete,
}: OnboardingFlowProps) {
  const windowServiceRef = useRef<WindowService | null>(null);
  if (!windowServiceRef.current) {
    windowServiceRef.current = providedWindowService ?? createWindowService();
  }
  const windowService = providedWindowService ?? windowServiceRef.current;
  const {pageDuration, reducedMotion} = useLumenMotion();
  const currentIndex = useOnboardingStore((state) => state.currentIndex);
  const root = useOnboardingStore((state) => state.root);
  const shortcut = useOnboardingStore((state) => state.shortcut);
  const back = useOnboardingStore((state) => state.back);
  const begin = useOnboardingStore((state) => state.begin);
  const complete = useOnboardingStore((state) => state.complete);
  const next = useOnboardingStore((state) => state.next);
  const setRoot = useOnboardingStore((state) => state.setRoot);
  const shellRef = useRef<HTMLDivElement>(null);
  const sceneViewportRef = useRef<HTMLDivElement>(null);
  const directionRef = useRef<'forward' | 'backward'>('forward');
  const [completionError, setCompletionError] = useState('');
  const [completing, setCompleting] = useState(false);
  const step = onboardingSteps[currentIndex] ?? 'welcome';

  useEffect(() => {
    useLauncherStore.getState().show('onboarding');
    void windowService.show('onboarding').catch(() => undefined);
  }, [windowService]);

  useEffect(() => {
    if (sceneViewportRef.current) sceneViewportRef.current.scrollTop = 0;
    shellRef.current
      ?.querySelector<HTMLElement>('[data-onboarding-primary="true"]')
      ?.focus();
  }, [currentIndex]);

  const finish = async () => {
    setCompleting(true);
    setCompletionError('');
    try {
      await windowService.setShortcut(shortcut);
      if (await onComplete?.() === false) {
        throw new Error('Lumen could not start the initial index. Check the selected folder and try again.');
      }
      if (complete()) {
        void requestWindowShow(windowService, 'collapsed');
      }
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message : 'Lumen could not finish setup.');
    } finally {
      setCompleting(false);
    }
  };

  const advance = () => {
    directionRef.current = 'forward';
    if (currentIndex === 0) {
      begin();
      return;
    }
    if (currentIndex === onboardingSteps.length - 1) {
      void finish();
      return;
    }
    next();
  };

  const goBack = () => {
    directionRef.current = 'backward';
    back();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && currentIndex > 0) {
      event.preventDefault();
      goBack();
    }
  };

  const primaryLabel = currentIndex === 0
    ? 'Begin'
    : currentIndex === onboardingSteps.length - 1
      ? 'Start using Lumen'
      : 'Continue';

  return (
    <LumenSurface
      ref={shellRef}
      aria-label="Welcome to Lumen"
      className="grid h-full min-h-0 min-w-0 w-full grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-surface"
      material="mica"
      onKeyDown={handleKeyDown}
    >
      <header data-tauri-drag-region className="flex min-h-[54px] min-w-0 items-center justify-between gap-[12px] border-b border-border-subtle px-[20px]">
        <LumenText weight="semibold">Lumen</LumenText>
        <div aria-label={`Step ${currentIndex + 1} of ${onboardingSteps.length}`} className="flex shrink-0 items-center gap-[8px]">
          {onboardingSteps.map((item, index) => (
            <span
              key={item}
              aria-hidden="true"
              className={index <= currentIndex ? 'h-[3px] w-[18px] rounded-pill bg-accent' : 'h-[3px] w-[18px] rounded-pill bg-border-strong'}
            />
          ))}
        </div>
      </header>
      <div ref={sceneViewportRef} className="flex min-h-0 min-w-0 flex-col overflow-x-hidden overflow-y-auto py-[24px]">
        <AnimatePresence custom={directionRef.current} initial={false} mode="wait">
          <motion.div
            key={step}
            data-motion-direction={reducedMotion ? 'fade' : 'spatial'}
            data-testid="onboarding-scene"
            className="my-auto min-w-0 w-full shrink-0"
            animate="center"
            custom={directionRef.current}
            exit="exit"
            initial="enter"
            transition={{duration: pageDuration}}
            variants={{
              enter: (direction: 'forward' | 'backward') => (
                reducedMotion
                  ? {opacity: 0}
                  : {opacity: 0, transform: `translateX(${direction === 'forward' ? 18 : -18}px)`}
              ),
              center: {opacity: 1, transform: 'translateX(0px)'},
              exit: (direction: 'forward' | 'backward') => (
                reducedMotion
                  ? {opacity: 0}
                  : {opacity: 0, transform: `translateX(${direction === 'forward' ? -14 : 14}px)`}
              ),
            }}
          >
            {step === 'root' ? (
              <RootSelectionScene root={root} service={rootService} onRoot={setRoot} />
            ) : step === 'shortcut' ? (
              <ShortcutScene shortcut={shortcut} />
            ) : (
              <StandardScene step={step} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      <footer className="flex min-h-[64px] min-w-0 flex-wrap items-center justify-between gap-[12px] border-t border-border-subtle px-[20px] py-[12px]">
        {completionError ? <span className="min-w-0 flex-1 text-xs text-danger [overflow-wrap:anywhere]" role="alert">{completionError}</span> : null}
        {currentIndex > 0 && !completionError ? (
          <LumenButton data-testid="onboarding-back-action" size="medium" variant="quiet" onPress={goBack}>Back</LumenButton>
        ) : <span aria-hidden="true" className="w-[36px]" />}
        <LumenButton
          data-onboarding-primary="true"
          data-testid="onboarding-primary-action"
          isDisabled={completing || (step === 'root' && !isValidRoot(root))}
          size="medium"
          variant="primary"
          onPress={advance}
        >
          {primaryLabel}
        </LumenButton>
      </footer>
    </LumenSurface>
  );
}
