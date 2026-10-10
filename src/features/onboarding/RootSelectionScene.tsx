import {useEffect, useRef, useState} from 'react';

import {LumenUiIcon} from '../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../design-system/primitives/LumenButton';
import {LumenText} from '../../design-system/primitives/LumenText';
import {OnboardingScene} from './OnboardingScene';
import type {RootSelectionService} from './root-selection-service';

export interface RootSelectionSceneProps {
  root: string;
  service: RootSelectionService;
  onRoot(root: string): boolean;
}

export function RootSelectionScene({root, service, onRoot}: RootSelectionSceneProps) {
  const [message, setMessage] = useState('');
  const [choosing, setChoosing] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const chooseRoot = async () => {
    if (pending.current) return;
    pending.current = true;
    setChoosing(true);
    setMessage('');
    try {
      const selection = await service.chooseRoot();
      if (!mounted.current) return;
      setMessage(!selection ? 'No folder was selected.' : onRoot(selection) ? '' : 'Choose a valid local folder.');
    } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : 'The folder picker could not be opened.');
    } finally {
      pending.current = false;
      if (mounted.current) setChoosing(false);
    }
  };

  return (
    <OnboardingScene
      description="Start with one development directory you know well."
      icon={<LumenUiIcon className="size-12" name="folderOpen" />}
      support="You can add, pause, exclude, or remove roots later."
      title="Choose one place to start"
    >
      <LumenButton isDisabled={choosing} className="max-w-full" size="large" variant="subtle" onPress={chooseRoot}>
        Choose folder
      </LumenButton>
      {root ? <div className="min-w-0 w-full max-w-[440px] rounded-control border border-border-subtle bg-surface-inset px-[16px] py-[12px] text-text-secondary [overflow-wrap:anywhere]" title={root}>{root}</div> : null}
      {message ? <LumenText role="status" tone="secondary" variant="caption">{message}</LumenText> : null}
    </OnboardingScene>
  );
}
