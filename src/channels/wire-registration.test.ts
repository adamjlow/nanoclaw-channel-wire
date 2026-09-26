/**
 * Behavioural registration test: imports the real channel barrel, so it goes
 * red if the `import './wire.js'` line is missing, the barrel fails to
 * evaluate, or the Wire SDK dependency is absent (wire.ts resolves it lazily,
 * so the dependency is asserted explicitly below). Importing must not start
 * anything or load the SDK.
 */
import { describe, expect, it } from 'vitest';

import { getChannelDefaults, getRegisteredChannelNames } from './channel-registry.js';
import './index.js';

describe('wire channel registration', () => {
  it('registers wire via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('wire');
  });

  it('declares conservative defaults', () => {
    const defaults = getChannelDefaults('wire');
    expect(defaults.dm).toMatchObject({ engageMode: 'pattern', engagePattern: '.', unknownSenderPolicy: 'strict' });
    expect(defaults.group).toMatchObject({ engageMode: 'mention', unknownSenderPolicy: 'strict' });
    expect(defaults.mentions).toBe('platform');
  });

  it('has the Wire SDK dependency installed', () => {
    expect(() => import.meta.resolve('@wireapp/wire-apps-js-sdk')).not.toThrow();
  });
});
