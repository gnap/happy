import { describe, expect, it, vi } from 'vitest';
import { readRoutes } from './readRoute';

const acceptsAll = () => true;

describe('readRoutes', () => {
    it('reads on the channel the session is on, and only that one', () => {
        expect(readRoutes({ chosen: 'relay', accepts: acceptsAll })).toEqual(['relay']);
        expect(readRoutes({ chosen: 'lan', accepts: acceptsAll })).toEqual(['lan']);
    });

    it('honours a pin above what the priority chose', () => {
        // The rule most easily lost: a person pinned this session, and a pin is not a preference.
        expect(readRoutes({ pinned: 'lan', chosen: 'relay', accepts: acceptsAll })).toEqual(['lan']);
        expect(readRoutes({ pinned: 'relay', chosen: 'lan', accepts: acceptsAll })).toEqual(['relay']);
    });

    it('reads on no daemon route at all when the pin is the server', () => {
        expect(readRoutes({ pinned: 'server', chosen: 'lan', accepts: acceptsAll })).toEqual([]);
    });

    it('honours a caller that demanded a route, above everything', () => {
        expect(readRoutes({ forced: 'relay', pinned: 'lan', chosen: 'lan', accepts: acceptsAll })).toEqual(['relay']);
    });

    it('offers every daemon channel that would take it when the server is carrying the session', () => {
        // The server has no channel of its own, so the read falls to the channels — in the device's
        // priority order, which is what this used to hard-code as lan-then-relay.
        expect(readRoutes({ chosen: 'server', accepts: acceptsAll })).toEqual(['lan', 'relay']);
        expect(readRoutes({ chosen: 'server', accepts: (route) => route === 'relay' })).toEqual(['relay']);
        expect(readRoutes({ chosen: 'server', accepts: () => false })).toEqual([]);
    });

    it('asks the channels rather than assuming they can carry it', () => {
        const accepts = vi.fn((_route: 'lan' | 'relay') => true);
        readRoutes({ chosen: 'server', accepts });
        expect(accepts.mock.calls.map(([route]) => route)).toEqual(['lan', 'relay']);
    });
});
