import { describe, expect, it } from 'vitest';
import { resolveMachinePresence } from './machinePresence';

const active = { active: true } as any;
const inactive = { active: false } as any;

describe('resolveMachinePresence', () => {
    it('orders server, then lan, then relay, then offline', () => {
        expect(resolveMachinePresence(active, true, true)).toBe('server');
        expect(resolveMachinePresence(inactive, true, true)).toBe('lan');
        expect(resolveMachinePresence(inactive, false, true)).toBe('relay');
        expect(resolveMachinePresence(inactive, false, false)).toBe('offline');
    });

    it('resolves a machine the server never reported from its sightings alone', () => {
        expect(resolveMachinePresence(undefined, false, true)).toBe('relay');
    });
});
