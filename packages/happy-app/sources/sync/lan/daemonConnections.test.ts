import { describe, expect, it, vi } from 'vitest';
import { DaemonConnections, type DaemonTarget } from './daemonConnections';
import type { LanSocketHandle } from './socket';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const target = (over: Partial<DaemonTarget> = {}): DaemonTarget => ({
    route: 'lan',
    baseUrl: 'http://10.0.0.2:55673',
    machineId: 'm1',
    machineKey: new Uint8Array(32),
    ...over,
});

/** A manager wired to a fake opener that records what it was asked for. */
function makeManager() {
    const opens: { target: DaemonTarget; handlers: any; handle: LanSocketHandle }[] = [];
    const state: [string, unknown][] = [];
    const manager = new DaemonConnections({
        open: async (t, handlers) => {
            const handle = { baseUrl: t.baseUrl, send: vi.fn(() => true), close: vi.fn() } as unknown as LanSocketHandle;
            opens.push({ target: t, handlers, handle });
            return handle;
        },
        onUpdate: () => {},
        onDelivered: () => {},
        onStateChange: (route, s) => { state.push([route, s]); },
        log: () => {},
        retryDelayMs: () => 0,
    });
    return { manager, opens, state };
}

describe('DaemonConnections', () => {
    it('opens one connection per route, however many times it is asked', async () => {
        const { manager, opens } = makeManager();
        manager.want(target());
        manager.want(target());
        await tick();
        manager.want(target());
        await tick();
        expect(opens).toHaveLength(1);
        expect(manager.has('lan')).toBe(true);
        expect(manager.connectedCount).toBe(1);
    });

    it('keeps one open to one route even when the asks arrive before it resolves', async () => {
        // The failure this replaces: several sessions read at once after a resume, each passed the
        // "is there one already?" check while the first was still opening, and each opened its own.
        const { manager, opens } = makeManager();
        manager.want(target());
        manager.want(target());
        manager.want(target());
        await tick();
        expect(opens).toHaveLength(1);
    });

    it('closes the old connection when the route moves to another address', async () => {
        const { manager, opens, state } = makeManager();
        manager.want(target());
        await tick();
        manager.want(target({ baseUrl: 'http://10.0.0.9:55673' }));
        await tick();
        expect(opens).toHaveLength(2);
        expect(opens[0].handle.close).toHaveBeenCalled();
        expect(manager.current('lan')?.baseUrl).toBe('http://10.0.0.9:55673');
        // Published as connected, then nothing, then connected again at the new address.
        expect(state.map(([, s]) => (s as any)?.baseUrl ?? null)).toEqual([
            'http://10.0.0.2:55673',
            null,
            'http://10.0.0.9:55673',
        ]);
    });

    it('closes a connection that arrives after the route stopped being wanted', async () => {
        const { manager, opens } = makeManager();
        manager.want(target());
        manager.unwant('lan', 'test');
        await tick();
        expect(opens[0].handle.close).toHaveBeenCalled();
        expect(manager.current('lan')).toBeNull();
    });

    it('reconnects by itself after a drop, and stops when nothing wants it', async () => {
        const { manager, opens } = makeManager();
        manager.want(target());
        await tick();
        opens[0].handlers.onClosed({ deliberate: false, code: 1006 });
        expect(manager.current('lan')).toBeNull();
        await tick();
        expect(opens).toHaveLength(2);

        manager.unwant('lan', 'test');
        opens[1].handlers.onClosed({ deliberate: false, code: 1006 });
        await tick();
        expect(opens).toHaveLength(2);
    });

    it('ignores the close event of a connection it deliberately replaced', async () => {
        const { manager, opens } = makeManager();
        manager.want(target());
        await tick();
        manager.want(target({ baseUrl: 'http://10.0.0.9:55673' }));
        await tick();
        expect(opens).toHaveLength(2);
        // The old handle reports a deliberate close, which must not disturb the live one.
        opens[0].handlers.onClosed({ deliberate: true });
        await tick();
        expect(manager.current('lan')?.baseUrl).toBe('http://10.0.0.9:55673');
        expect(opens).toHaveLength(2);
    });

    it('drops every route not listed when asked for a set', async () => {
        const { manager, opens } = makeManager();
        manager.want(target());
        manager.want(target({ route: 'relay', baseUrl: 'https://relay.example/r/tag' }));
        await tick();
        manager.wantOnly([target({ route: 'relay', baseUrl: 'https://relay.example/r/tag' })]);
        expect(manager.has('lan')).toBe(false);
        expect(manager.has('relay')).toBe(true);
        expect(opens[0].handle.close).toHaveBeenCalled();
    });
});
