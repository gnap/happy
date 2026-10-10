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
            const handle = { baseUrl: t.baseUrl, send: vi.fn(() => true), ping: vi.fn(() => true), close: vi.fn() } as unknown as LanSocketHandle;
            opens.push({ target: t, handlers, handle });
            return handle;
        },
        onUpdate: () => {},
        onDelivered: () => {},
        onStateChange: (route, s) => { state.push([route, s]); },
        log: () => {},
        retryDelayMs: () => 0,
        heartbeat: { intervalMs: 1, timeoutMs: 4 },
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
        expect(manager.has('m1', 'lan')).toBe(true);
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
        expect(manager.current('m1', 'lan')?.baseUrl).toBe('http://10.0.0.9:55673');
        // Every transition is published with what the route is doing, so a reader can tell a channel
        // being replaced from one that is idle or stuck: live at the old address, opening at the new
        // one, then live there.
        expect(state.map(([, s]) => [(s as { phase: string }).phase, (s as { baseUrl?: string }).baseUrl ?? null])).toEqual([
            ['opening', 'http://10.0.0.2:55673'],
            ['live', 'http://10.0.0.2:55673'],
            ['opening', 'http://10.0.0.9:55673'],
            ['live', 'http://10.0.0.9:55673'],
        ]);
    });

    it('keeps retrying a route whose open never produced a socket', async () => {
        // `want` is idempotent, so a failed open used to be the end of it: the route stayed wanted
        // and idle until something unrelated moved its address.
        const failures: number[] = [];
        let attempt = 0;
        const manager = new DaemonConnections({
            open: async () => {
                attempt += 1;
                failures.push(attempt);
                return attempt <= 2 ? null : ({ baseUrl: 'x', send: () => true, ping: () => true, close: () => {} } as unknown as LanSocketHandle);
            },
            onUpdate: () => {},
            onDelivered: () => {},
            onStateChange: () => {},
            log: () => {},
            retryDelayMs: () => 1,
        });
        manager.want(target());
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(failures.length).toBeGreaterThanOrEqual(3);
        expect(manager.current('m1', 'lan')).not.toBeNull();
    });

    it('closes a connection that arrives after the route stopped being wanted', async () => {
        const { manager, opens } = makeManager();
        manager.want(target());
        manager.unwant('m1:lan', 'test');
        await tick();
        expect(opens[0].handle.close).toHaveBeenCalled();
        expect(manager.current('m1', 'lan')).toBeNull();
    });

    it('reconnects by itself after a drop, and stops when nothing wants it', async () => {
        const { manager, opens } = makeManager();
        manager.want(target());
        await tick();
        opens[0].handlers.onClosed({ deliberate: false, code: 1006 });
        expect(manager.current('m1', 'lan')).toBeNull();
        await tick();
        expect(opens).toHaveLength(2);

        manager.unwant('m1:lan', 'test');
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
        expect(manager.current('m1', 'lan')?.baseUrl).toBe('http://10.0.0.9:55673');
        expect(opens).toHaveLength(2);
    });

    it('keeps a connection whose daemon never answers a heartbeat, and says so', async () => {
        // A daemon whose CLI predates the heartbeat cannot answer one, and that is indistinguishable
        // from a dead socket except by trying. Tearing it down on every timeout left a working
        // connection flapping forever — the answer was never going to come — so it is learned once:
        // the socket is kept, the caller is told, and the daemon is not asked again.
        const unsupported: string[] = [];
        const opens: any[] = [];
        const manager = new DaemonConnections({
            open: async (t) => {
                const handle = { baseUrl: t.baseUrl, send: vi.fn(() => true), ping: vi.fn(() => true), close: vi.fn() } as unknown as LanSocketHandle;
                opens.push(handle);
                return handle;
            },
            onUpdate: () => {},
            onDelivered: () => {},
            onStateChange: () => {},
            onHeartbeatUnsupported: (target) => unsupported.push(target.machineId),
            log: () => {},
            retryDelayMs: () => 0,
            heartbeat: { intervalMs: 1, timeoutMs: 4 },
        });
        manager.want(target());
        await tick();
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(unsupported).toEqual(['m1']);
        // Kept, not replaced: one connection, still live, and no longer pinged.
        expect(opens).toHaveLength(1);
        expect(opens[0].close).not.toHaveBeenCalled();
        expect(manager.current('m1', 'lan')).not.toBeNull();
        expect(manager.trusted('m1', 'lan')).not.toBeNull();
        expect(opens[0].ping).toHaveBeenCalledTimes(1);
    });

    it('still ends a connection whose socket will not take the heartbeat at all', async () => {
        // The other half of the same question: a socket that cannot even be written to is not one to
        // keep, and that is what the reconnect path is for.
        let attempt = 0;
        const manager = new DaemonConnections({
            open: async (t) => {
                attempt += 1;
                return {
                    baseUrl: t.baseUrl,
                    send: () => true,
                    ping: () => attempt > 1,
                    close: vi.fn(),
                } as unknown as LanSocketHandle;
            },
            onUpdate: () => {},
            onDelivered: () => {},
            onStateChange: () => {},
            log: () => {},
            retryDelayMs: () => 1,
            heartbeat: { intervalMs: 1, timeoutMs: 4 },
        });
        manager.want(target());
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(attempt).toBeGreaterThan(1);
    });

    it('treats an answered heartbeat as the connection being alive', async () => {
        const { manager, opens } = makeManager();
        manager.want(target());
        await tick();
        const answered = setInterval(() => opens[opens.length - 1]?.handlers.onBeat(), 1);
        await new Promise((resolve) => setTimeout(resolve, 30));
        clearInterval(answered);
        expect(manager.current('m1', 'lan')).not.toBeNull();
        expect(opens).toHaveLength(1);
    });

    it('stops offering a connection to write on once a heartbeat goes unanswered', async () => {
        // `current` still names it — it is open, and only the beat loop decides it is gone — but a
        // send into a socket whose peer has vanished is accepted locally and goes nowhere, which is
        // exactly how a message gets lost with the App believing it sent.
        const { manager, opens } = makeManager();
        manager.want(target());
        await tick();
        expect(manager.trusted('m1', 'lan')?.handle).toBe(opens[0].handle);

        // A whole beat interval passes with no answer.
        await new Promise((resolve) => setTimeout(resolve, 3));
        expect(manager.trusted('m1', 'lan')).toBeNull();
        expect(manager.current('m1', 'lan')).not.toBeNull();

        // A late answer restores it: a slow pong must not cost a reconnect.
        opens[0].handlers.onBeat();
        expect(manager.trusted('m1', 'lan')?.handle).toBe(opens[0].handle);
    });

    it('drops every daemon not listed when asked for a set', async () => {
        const { manager, opens } = makeManager();
        manager.want(target());
        manager.want(target({ route: 'relay', baseUrl: 'https://relay.example/r/tag' }));
        await tick();
        manager.wantOnly([target({ route: 'relay', baseUrl: 'https://relay.example/r/tag' })]);
        expect(manager.has('m1', 'lan')).toBe(false);
        expect(manager.has('m1', 'relay')).toBe(true);
        expect(opens[0].handle.close).toHaveBeenCalled();
    });
});
