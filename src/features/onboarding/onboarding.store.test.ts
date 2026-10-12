import {LazyStore} from '@tauri-apps/plugin-store';
import {afterEach, expect, it, vi} from 'vitest';
import {useOnboardingStore} from './onboarding.store';

afterEach(() => {Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); useOnboardingStore.getState().reset();});

it('publishes completion only after the native onboarding save succeeds and preserves choices on failure', async () => {
  Reflect.defineProperty(window, '__TAURI_INTERNALS__', {configurable: true, value: {}});
  useOnboardingStore.setState({root: 'C:\\Projects', currentIndex: 3});
  vi.spyOn(LazyStore.prototype, 'set').mockResolvedValue();
  let reject!: (error: Error) => void;
  vi.spyOn(LazyStore.prototype, 'save').mockImplementationOnce(() => new Promise<void>((_, fail) => {reject = fail;})).mockResolvedValue();
  const completion = useOnboardingStore.getState().complete();
  await Promise.resolve();
  expect(useOnboardingStore.getState().completed).toBe(false);
  const failed = expect(completion).rejects.toThrow('Disk unavailable');
  reject(new Error('Disk unavailable'));
  await failed;
  expect(useOnboardingStore.getState()).toMatchObject({completed: false, root: 'C:\\Projects', currentIndex: 3});
  expect(await useOnboardingStore.getState().complete()).toBe(true);
  expect(useOnboardingStore.getState().completed).toBe(true);
});
