import {useState} from 'react';
import {ImprovementActivityControls} from '../../improvement/ImprovementControls';

import {LumenUiIcon} from '../../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {LumenIconButton} from '../../../design-system/primitives/LumenIconButton';
import {LumenText} from '../../../design-system/primitives/LumenText';
import {
  createActivityService,
  type ActivityPolicy,
  type ActivityService,
  type ActivitySnapshot,
} from '../../../services/activity/activity-service';
import {ActivityStatus} from '../../activity/ActivityStatus';
import {ApplicationOverrideRow} from '../../activity/ApplicationOverrideRow';
import {useActivityStore} from '../../activity/activity.store';
import type {ActivityMode} from '../../activity/activity.types';
import {SettingRow} from '../components/SettingRow';
import {SettingSection} from '../components/SettingSection';
import {LumenSelect, LumenSwitch, LumenTextField} from '../components/SettingsControls';
import {SettingsCallout, SettingsPage} from '../components/SettingsPage';
import type {ActivitySettings, ApplicationOverride} from '../settings.schema';
import {useSettingsStore} from '../settings.store';

const defaultActivityService = createActivityService();

function applicationId(application: string) {
  return `app-${application.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function nativePolicy(activity: ActivitySettings): ActivityPolicy {
  return {
    detectGames: activity.detectGames,
    detectFullscreen: activity.detectFullscreen,
    allowDuringVideo: activity.allowDuringVideo,
    cinemaMetadataOnly: activity.cinemaMetadataOnly,
    pauseOnBattery: activity.pauseOnBattery,
    resumeDelaySeconds: activity.resumeDelaySeconds,
    gameIdentities: activity.userGames.flatMap((item) => item.identityHash ? [item.identityHash] : []),
    overrides: activity.overrides.flatMap((item) => item.identityHash
      ? [{identityHash: item.identityHash, policy: item.policy}]
      : []),
  };
}

function reflectSnapshot(snapshot: ActivitySnapshot, message = '') {
  useActivityStore.setState({
    active: snapshot.mode !== 'indexing',
    mode: snapshot.mode,
    detectedApplication: null,
    message,
  });
}

export function ActivityPage({
  activityService = defaultActivityService,
  nativeRuntime,
}: {
  activityService?: ActivityService;
  nativeRuntime?: boolean;
} = {}) {
  const native = nativeRuntime ?? (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);
  const activity = useSettingsStore((state) => state.activity);
  const updateActivity = useSettingsStore((state) => state.updateActivity);
  const mode = useActivityStore((state) => state.mode);
  const message = useActivityStore((state) => state.message);
  const setMode = useActivityStore((state) => state.setMode);
  const toggleUserPause = useActivityStore((state) => state.toggleUserPause);
  const resetClassifications = useActivityStore((state) => state.resetClassifications);
  const [overrideName, setOverrideName] = useState('');
  const [gameName, setGameName] = useState('');
  const [nativeMessage, setNativeMessage] = useState('');

  const applyPolicy = async (next: ActivitySettings, appliedMessage?: string) => {
    if (!native) {
      await updateActivity(next);
      return;
    }
    const previous = activity;
    try {
      const snapshot = await activityService.setPolicy(nativePolicy(next));
      if (!await updateActivity(next)) {
        await activityService.setPolicy(nativePolicy(previous));
        setNativeMessage('Activity policy was restored because the device setting could not be saved.');
        return;
      }
      reflectSnapshot(snapshot, appliedMessage);
      setNativeMessage('');
    } catch (error) {
      setNativeMessage(error instanceof Error ? error.message : 'Activity policy could not be applied.');
    }
  };

  const changePolicy = (patch: Partial<ActivitySettings>) => {
    void applyPolicy({...activity, ...patch});
  };

  const pauseOrResume = async () => {
    if (!native) {
      toggleUserPause();
      return;
    }
    try {
      const paused = mode !== 'user';
      reflectSnapshot(
        await activityService.setUserPause(paused),
        paused ? 'Background work paused.' : 'Background work resumed.',
      );
      setNativeMessage('');
    } catch (error) {
      setNativeMessage(error instanceof Error ? error.message : 'Background work could not be changed.');
    }
  };

  const addOverride = async () => {
    if (native) {
      const executable = await activityService.chooseExecutable();
      if (!executable || activity.overrides.some((item) => item.identityHash === executable.identityHash)) return;
      await applyPolicy({
        ...activity,
        overrides: [...activity.overrides, {
          id: `app-${executable.identityHash}`,
          application: executable.fileName,
          identityHash: executable.identityHash,
          policy: 'automatic',
        }],
      }, `${executable.fileName} added.`);
      return;
    }
    const application = overrideName.trim();
    if (!application || activity.overrides.some((item) => item.application.toLowerCase() === application.toLowerCase())) return;
    await updateActivity({
      overrides: [...activity.overrides, {
        id: applicationId(application),
        application,
        identityHash: null,
        policy: 'automatic',
      }],
    });
    setOverrideName('');
  };

  const addGame = async () => {
    if (native) {
      const executable = await activityService.chooseExecutable();
      if (!executable || activity.userGames.some((item) => item.identityHash === executable.identityHash)) return;
      await applyPolicy({
        ...activity,
        userGames: [...activity.userGames, {
          id: `game-${executable.identityHash}`,
          name: executable.fileName,
          identityHash: executable.identityHash,
        }],
      }, `${executable.fileName} added as a game.`);
      return;
    }
    const game = gameName.trim();
    if (!game || activity.userGames.some((item) => item.name === game)) return;
    await updateActivity({
      userGames: [...activity.userGames, {id: applicationId(game), name: game, identityHash: null}],
    });
    setGameName('');
  };

  const updateOverride = (nextOverride: ApplicationOverride) => {
    void applyPolicy({
      ...activity,
      overrides: activity.overrides.map((item) => item.id === nextOverride.id ? nextOverride : item),
    });
  };

  const resetAll = () => {
    void applyPolicy({...activity, overrides: [], userGames: []}, 'Automatic classifications reset.');
    if (!native) resetClassifications();
  };

  return (
    <SettingsPage>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-[12px]">
        {!native ? (
          <LumenSelect<ActivityMode>
            aria-label="Development activity state"
            options={[
              {id: 'indexing', label: 'Indexing'},
              {id: 'slow', label: 'Indexing slowly'},
              {id: 'gaming', label: 'Paused for gaming'},
              {id: 'fullscreen', label: 'Paused for fullscreen'},
              {id: 'cinema', label: 'Cinema mode'},
              {id: 'idle', label: 'Waiting for idle'},
              {id: 'battery', label: 'Paused on battery'},
              {id: 'user', label: 'Paused by user'},
            ]}
            value={mode}
            onChange={(next) => setMode(next)}
          />
        ) : <LumenText tone="secondary">Live Windows activity</LumenText>}
        <LumenButton size="small" variant={mode === 'user' ? 'primary' : 'subtle'} onPress={() => void pauseOrResume()}>
          {mode === 'user' ? 'Resume indexing' : 'Pause indexing'}
        </LumenButton>
      </div>
      <ActivityStatus mode={mode} />
      {nativeMessage || message ? <SettingsCallout>{nativeMessage || message}</SettingsCallout> : null}
      <SettingSection title="Automatic quiet modes" description="Classification changes background work only; the launcher remains available.">
        <SettingRow label="Detect configured games" description="Pause background indexing for executable identities you select below.">
          <LumenSwitch aria-label="Detect games automatically" isSelected={activity.detectGames} onChange={(detectGames) => changePolicy({detectGames})} />
        </SettingRow>
        <SettingRow label="Detect fullscreen applications" description="Stay quiet when a foreground app occupies the display.">
          <LumenSwitch aria-label="Detect fullscreen applications" isSelected={activity.detectFullscreen} onChange={(detectFullscreen) => changePolicy({detectFullscreen})} />
        </SettingRow>
        {!native ? (
          <>
            <SettingRow label="Allow indexing during video" description="Permit normal indexing instead of Cinema behavior.">
              <LumenSwitch aria-label="Allow indexing during video" isSelected={activity.allowDuringVideo} onChange={(allowDuringVideo) => changePolicy({allowDuringVideo})} />
            </SettingRow>
            <SettingRow label="Metadata-only Cinema mode" description="During playback, retain lightweight filename work while content work waits.">
              <LumenSwitch aria-label="Metadata-only Cinema mode" isSelected={activity.cinemaMetadataOnly} onChange={(cinemaMetadataOnly) => changePolicy({cinemaMetadataOnly})} />
            </SettingRow>
          </>
        ) : null}
        <SettingRow label="Pause on battery" description="Protect battery life when the device is unplugged.">
          <LumenSwitch aria-label="Pause on battery" isSelected={activity.pauseOnBattery} onChange={(pauseOnBattery) => changePolicy({pauseOnBattery})} />
        </SettingRow>
        <SettingRow label="Resume delay" description="Wait after a restricted app closes before background work resumes.">
          <LumenSelect
            aria-label="Resume delay"
            options={[{id: '0', label: 'Immediately'}, {id: '15', label: '15 seconds'}, {id: '30', label: '30 seconds'}, {id: '60', label: '1 minute'}]}
            value={String(activity.resumeDelaySeconds) as '0' | '15' | '30' | '60'}
            onChange={(value) => changePolicy({resumeDelaySeconds: Number(value)})}
          />
        </SettingRow>
      </SettingSection>
      <SettingSection title="Application overrides" description="Give a selected executable a stable policy instead of relying on classification.">
        <div className={native ? 'flex min-w-0 flex-wrap justify-end p-[16px]' : 'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[8px] p-[16px] @min-[32rem]/settings:grid-cols-[minmax(0,1fr)_auto]'}>
          {!native ? (
            <LumenTextField
              aria-label="Application override"
              placeholder="Example: render.exe"
              value={overrideName}
              onChange={setOverrideName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void addOverride();
                }
              }}
            />
          ) : null}
          <LumenButton aria-label={native ? 'Choose application executable' : 'Add application override'} className="justify-self-start" size="small" onPress={() => void addOverride()}>
            <LumenUiIcon name="add" size="small" /> {native ? 'Choose executable' : 'Add'}
          </LumenButton>
        </div>
        {activity.overrides.map((override) => (
          <ApplicationOverrideRow
            key={override.id}
            override={override}
            onChange={updateOverride}
            onRemove={() => void applyPolicy({...activity, overrides: activity.overrides.filter((item) => item.id !== override.id)})}
          />
        ))}
      </SettingSection>
      <SettingSection title="User-defined games" description="Select games that Windows may not classify consistently.">
        <div className={native ? 'flex min-w-0 flex-wrap justify-end p-[16px]' : 'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[8px] p-[16px] @min-[32rem]/settings:grid-cols-[minmax(0,1fr)_auto]'}>
          {!native ? <LumenTextField aria-label="User-defined game" placeholder="Example: game.exe" value={gameName} onChange={setGameName} /> : null}
          <LumenButton aria-label={native ? 'Choose game executable' : 'Add user-defined game'} className="justify-self-start" size="small" onPress={() => void addGame()}>
            <LumenUiIcon name="tools" size="small" /> {native ? 'Choose game' : 'Add game'}
          </LumenButton>
        </div>
        {activity.userGames.length ? (
          <div className="flex min-w-0 flex-wrap gap-[8px] p-[16px]">
            {activity.userGames.map((game) => (
              <span key={game.id} className="inline-flex min-h-[36px] min-w-0 max-w-full items-center gap-[4px] rounded-pill bg-surface-inset pl-[12px] text-xs text-text-secondary">
                <span className="min-w-0 [overflow-wrap:anywhere]">{game.name}</span>
                <LumenIconButton aria-label={`Remove game ${game.name}`} size="small" variant="quiet" onPress={() => void applyPolicy({...activity, userGames: activity.userGames.filter((item) => item.id !== game.id)})}>
                  <LumenUiIcon name="close" size="small" />
                </LumenIconButton>
              </span>
            ))}
          </div>
        ) : <div className="flex flex-wrap gap-[8px] p-[16px]"><LumenText tone="tertiary" variant="meta">No custom game classifications.</LumenText></div>}
      </SettingSection>
      <LumenButton aria-label="Reset classifications" size="small" variant="quiet" onPress={resetAll}>Reset classifications</LumenButton>
      <ImprovementActivityControls />
    </SettingsPage>
  );
}
