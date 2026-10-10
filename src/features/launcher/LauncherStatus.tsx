import {ActivityIndicator} from '../../design-system/animations/ActivityIndicator';
import {useLumenMotion} from '../../design-system/MotionProvider';
import {activityPresentations} from '../activity/activity.types';
import {useActivityStore} from '../activity/activity.store';
import {useLauncherStore} from './launcher.store';

export interface LauncherStatusProps {
  label?: string;
  searching?: boolean;
}

export function LauncherStatus({label = 'Ready', searching = false}: LauncherStatusProps) {
  const {reducedMotion} = useLumenMotion();
  const visible = useLauncherStore((state) => state.visible);
  const activityActive = useActivityStore((state) => state.active);
  const activityMode = useActivityStore((state) => state.mode);
  const activityLabel = activityPresentations[activityMode].compactLabel;
  const active = searching && !activityActive;
  return (
    <output
      aria-live="polite"
      data-activity-compact={activityActive || undefined}
      data-testid={activityActive ? 'launcher-activity' : undefined}
      className="inline-flex shrink-0 items-center gap-1.5"
    >
      <ActivityIndicator
        active={active}
        visible={visible}
        reducedMotion={reducedMotion}
        tone={activityActive ? 'warning' : 'success'}
      />
      <span className="text-xs text-[color:var(--einui-command-muted-text)]">
        {activityActive ? activityLabel : label}
      </span>
    </output>
  );
}
