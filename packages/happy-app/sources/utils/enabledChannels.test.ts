import { describe, expect, it } from 'vitest';
import { channelEnabled, enabledChannels } from './enabledChannels';

describe('enabledChannels', () => {
    it('reads the list as the set of channels that are on', () => {
        expect(enabledChannels(['lan', 'relay', 'server'])).toEqual({ lan: true, relay: true, server: true });
        // Omitting one is how it is switched off — the whole point of the list being a set. (Not
        // `['lan','server']`: that exact list is the pre-relay default, and is migrated below.)
        expect(enabledChannels(['lan', 'relay'])).toEqual({ lan: true, relay: true, server: false });
        expect(enabledChannels(['server'])).toEqual({ lan: false, relay: false, server: true });
    });

    it('answers the same as resolution about an empty or unreadable list', () => {
        // The sites this replaced read the raw setting, so a device whose list had been blanked had
        // channels that were on for reading and off for connecting. Normalised, it is the default
        // set in both places.
        expect(enabledChannels([])).toEqual({ lan: true, relay: true, server: true });
        expect(enabledChannels(['nonsense'] as never)).toEqual({ lan: true, relay: true, server: true });
    });

    it('migrates the pre-relay list rather than treating it as a decision about the relay', () => {
        // `['lan','server']` is the old default, not a device that switched the relay off — it did
        // not exist when the list was saved. Same rule as `normalizeChannelPriority`.
        expect(channelEnabled(['lan', 'server'], 'relay')).toBe(true);
    });

    it('never turns on a channel it does not know', () => {
        expect(enabledChannels(['lan', 'future-channel'] as never)).toEqual({ lan: true, relay: false, server: false });
    });

    it('answers for one channel without building a different answer than the set does', () => {
        for (const priority of [['lan', 'relay', 'server'], ['relay'], ['lan', 'server'], []] as never[][]) {
            const set = enabledChannels(priority);
            for (const channel of ['lan', 'relay', 'server'] as const) {
                expect(channelEnabled(priority, channel)).toBe(set[channel]);
            }
        }
    });
});
