import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayHub, relayHubUrl, relayOriginOf, type SocketLike } from './relayHub';

/**
 * A WebSocket the test drives by hand.
 *
 * The hub's whole job is a protocol over one connection, so the connection is the thing to fake:
 * what matters is which frames it writes for which calls, and what it does with the frames it is
 * handed — not that a real socket carries them.
 */
class FakeSocket {
    static last: FakeSocket | null = null;
    readyState = 0;
    closed = false;
    sent: string[] = [];
    onopen: ((event?: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
    onerror: ((event?: unknown) => void) | null = null;

    constructor(readonly url: string) {
        FakeSocket.last = this;
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this.closed = true;
        this.readyState = 3;
        this.onclose?.({ code: 1000 });
    }

    /** The relay accepted the connection. */
    accept(machines: { tag: string; sessions: unknown[] }[] = []): void {
        this.readyState = 1;
        this.onopen?.();
        this.onmessage?.({ data: JSON.stringify({ t: 'ok', machines }) });
    }

    /** A frame from the relay. */
    deliver(frame: unknown): void {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }

    frames(): any[] {
        return this.sent.map((s) => JSON.parse(s));
    }
}

beforeEach(() => {
    FakeSocket.last = null;
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const hubWith = () => {
    const hub = new RelayHub(relayHubUrl('https://relay.example'));
    hub.connect();
    return { hub, socket: FakeSocket.last! };
};

describe('relayHubUrl', () => {
    it('turns the relay base URL into the hub endpoint', () => {
        expect(relayHubUrl('https://relay.example')).toBe('wss://relay.example/client');
        expect(relayHubUrl('https://relay.example/')).toBe('wss://relay.example/client');
        expect(relayHubUrl('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080/client');
    });
});

describe('relayOriginOf', () => {
    it('reads the relay out of a route a machine published', () => {
        // The address is learned from the machines rather than typed in by a person: a daemon is
        // configured with its relay and publishes the route it built from it.
        expect(relayOriginOf(`https://47.80.241.214/r/${'a'.repeat(32)}`)).toBe('https://47.80.241.214');
        expect(relayOriginOf(`http://relay.example:8080/r/${'b'.repeat(32)}/`)).toBe('http://relay.example:8080');
    });

    it('refuses anything that is not that shape', () => {
        expect(relayOriginOf('https://relay.example')).toBeNull();
        expect(relayOriginOf(`https://relay.example/r/${'a'.repeat(31)}`)).toBeNull();
        expect(relayOriginOf('not a url')).toBeNull();
    });
});

describe('RelayHub', () => {
    it('opens a stream to the named machine on the one connection', () => {
        const { hub, socket } = hubWith();
        socket.accept();
        hub.stream('aaaa', '/lan/socket?nonce=n');
        expect(socket.frames()).toEqual([{ t: 'open', id: 1, tag: 'aaaa', path: '/lan/socket?nonce=n' }]);
        // A second machine rides the same connection, which is the whole point of the hub.
        hub.stream('bbbb', '/lan/socket?nonce=m');
        expect(socket.frames()).toHaveLength(2);
        expect(socket.frames()[1]).toMatchObject({ id: 2, tag: 'bbbb' });
    });

    it('hands a stream the frames the relay routes to it, and only those', () => {
        const { hub, socket } = hubWith();
        socket.accept();
        const first = hub.stream('aaaa', '/lan/socket') as SocketLike;
        const second = hub.stream('bbbb', '/lan/socket') as SocketLike;
        const got: string[] = [];
        first.onmessage = (event) => got.push(String(event.data));
        const other: string[] = [];
        second.onmessage = (event) => other.push(String(event.data));

        socket.deliver({ t: 'msg', id: 2, data: 'for-b' });
        expect(other).toEqual(['for-b']);
        expect(got).toEqual([]);
        socket.deliver({ t: 'msg', id: 1, data: 'for-a' });
        expect(got).toEqual(['for-a']);
    });

    it('looks like a socket that was already open when the first frame arrives', () => {
        // The daemon answers an upgrade with a frame, so a stream is open the moment one arrives —
        // and the socket the caller gets has already reported itself open, the way a WebSocket does.
        const { hub, socket } = hubWith();
        socket.accept();
        const stream = hub.stream('aaaa', '/lan/socket') as SocketLike;
        const open = vi.fn();
        const messages: string[] = [];
        stream.onopen = open;
        stream.onmessage = (event) => messages.push(String(event.data));
        socket.deliver({ t: 'msg', id: 1, data: 'hello' });
        expect(open).toHaveBeenCalledTimes(1);
        expect(messages).toEqual(['hello']);
        expect(stream.readyState).toBe(1);
    });

    it('closes a stream the relay reports closed, with the code it gave', () => {
        const { hub, socket } = hubWith();
        socket.accept();
        const stream = hub.stream('aaaa', '/lan/socket') as SocketLike;
        const closed: { code?: number; reason?: string }[] = [];
        socket.deliver({ t: 'msg', id: 1, data: 'open me' });
        stream.onclose = (event) => closed.push(event ?? {});
        socket.deliver({ t: 'close', id: 1, code: 1000, reason: 'bye' });
        expect(closed).toEqual([{ code: 1000, reason: 'bye' }]);
        expect(stream.readyState).toBe(3);
    });

    it('fails every stream when the connection goes, rather than leaving them looking alive', () => {
        const { hub, socket } = hubWith();
        socket.accept();
        const stream = hub.stream('aaaa', '/lan/socket') as SocketLike;
        const closed: number[] = [];
        socket.deliver({ t: 'msg', id: 1, data: 'open me' });
        stream.onclose = (event) => closed.push(event?.code ?? 0);
        let connected = true;
        hub.onStatus((value) => { connected = value; });

        socket.close();
        expect(closed).toEqual([1006]);
        expect(connected).toBe(false);
        expect(hub.isConnected()).toBe(false);
    });

    it('reports the machines the relay holds, and pushes them when they change', () => {
        const { hub, socket } = hubWith();
        const seen: number[] = [];
        hub.onMachines((machines) => seen.push(machines.length));
        socket.accept([{ tag: 'aaaa', sessions: [] }]);
        expect(hub.machines()).toEqual([{ tag: 'aaaa', sessions: [] }]);

        socket.deliver({ t: 'machines', machines: [{ tag: 'aaaa', sessions: [{ happySessionId: 's1' }] }, { tag: 'bbbb', sessions: [] }] });
        expect(hub.machines().map((m) => m.tag)).toEqual(['aaaa', 'bbbb']);
        expect(seen).toEqual([1, 2]);
    });

    it('keeps its own liveness check on the one connection, and reconnects when it stops answering', () => {
        // Whether a *machine* is up is the relay's business — it holds that connection. Whether
        // this connection is still carrying anything is only knowable here, so this is the one
        // heartbeat on this side, and there is exactly one of them however many machines there are.
        vi.useFakeTimers();
        try {
            const { hub, socket } = hubWith();
            socket.accept();
            expect(hub.isConnected()).toBe(true);

            vi.advanceTimersByTime(15_000);
            expect(socket.frames()).toEqual([{ t: 'ping' }]);

            // Answered: still connected, and asked again on the next interval.
            socket.deliver({ t: 'pong' });
            vi.advanceTimersByTime(15_000);
            expect(socket.frames()).toEqual([{ t: 'ping' }, { t: 'ping' }]);
            expect(hub.isConnected()).toBe(true);

            // Unanswered past the timeout: the connection is dropped so the ordinary reconnect can
            // replace it, rather than being believed indefinitely.
            vi.advanceTimersByTime(45_000);
            expect(socket.closed).toBe(true);
            expect(hub.isConnected()).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('closes a machine\'s stream when the relay stops holding that machine', async () => {
        // The relay is the one that knows a machine went: acting on the directory is how the App
        // finds out without asking the daemon — which is what the per-machine heartbeat used to be.
        const { hub, socket } = hubWith();
        socket.accept([{ tag: 'aaaa', sessions: [] }]);
        const stream = hub.stream('aaaa', '/lan/socket') as SocketLike;
        socket.deliver({ t: 'msg', id: 1, data: 'open me' });
        const closed: number[] = [];
        stream.onclose = (event) => closed.push(event?.code ?? 0);

        socket.deliver({ t: 'machines', machines: [] });
        expect(closed).toEqual([4502]);
        expect(hub.machines()).toEqual([]);
    });

    it('tells a stream the relay is not connected, instead of waiting for an answer', async () => {
        // A stream opened before the connection is up has no one to ask: saying so is what stops the
        // caller holding a socket that will never produce a frame.
        const { hub } = hubWith();
        const stream = hub.stream('aaaa', '/lan/socket') as SocketLike;
        const closed: number[] = [];
        stream.onclose = (event) => closed.push(event?.code ?? 0);
        stream.onerror = () => closed.push(-1);
        // Reported on a tick, so the caller has the socket before it hears about the failure.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(closed).toEqual([-1, 4502]);
    });
});
