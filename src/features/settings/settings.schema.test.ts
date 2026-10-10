import {describe, expect, it} from 'vitest';
import {defaultSettings, parseSettings} from './settings.schema';

describe('presentation migration', () => {
  it('discards the obsolete motion switch while retaining saved choices', () => {
    const migrated = parseSettings({...defaultSettings, presentation: {
      glassIntensity: 38, synchronizeReducedMotion: false,
    }});
    expect(migrated.presentation).toEqual({glassIntensity: 38});
    expect(migrated.general).toEqual(defaultSettings.general);
    expect(parseSettings({...migrated, presentation: {glassIntensity: 60}}).presentation)
      .toEqual({glassIntensity: 60});
  });
});
