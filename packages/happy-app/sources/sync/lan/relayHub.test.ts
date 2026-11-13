import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayHub, relayHubUrl, relayMachinesUrl, relayOriginOf, type SocketLike } from './relayHub';

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

    /** The relay accepted the connection, with the directory as a frame (the older shape). */
    accept(machines: { tag: string; sessions: unknown[] }[] = []): void {
        this.readyState = 1;
        this.onopen?.();
        this.onmessage?.({ data: JSON.stringify({ t: 'ok', machines }) });
    }

    /** The relay accepted the connection and serves the directory over HTTP (the newer shape). */
    acceptHttp(etag: string): void {
        this.readyState = 1;
        this.onopen?.();
        this.onmessage?.({ data: JSON.stringify({ t: 'ok', etag }) });
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

describe('relay hub handshake', () => {
    it('abandons a handshake that never opens, and retries', () => {
        // A black-holed connect can sit for over a minute at the OS level, with no close and no
        // reconnect — every machine behind the relay reads as unreachable the whole time.
        vi.useFakeTimers();
        const { hub, socket } = hubWith();
        expect(socket.closed).toBe(false);

        vi.advanceTimersByTime(15_000);
        expect(socket.closed).toBe(true);

        // The close schedules the ordinary reconnect, which opens a fresh socket.
        vi.advanceTimersByTime(1_000);
        expect(FakeSocket.last).not.toBe(socket);
        hub.close();
    });

    it('leaves a socket that opened alone', () => {
        vi.useFakeTimers();
        const { hub, socket } = hubWith();
        socket.accept();
        // Past the handshake bound, and past the first heartbeat (which only asks, and is not
        // answered here until its own 45s timeout): the socket that opened is not the one this
        // timer is for.
        vi.advanceTimersByTime(20_000);
        expect(socket.closed).toBe(false);
        hub.close();
    });
});

describe('relayHubUrl', () => {
    it('turns the relay base URL into the hub endpoint, asking for the directory over HTTP', () => {
        // A relay that predates `dir=http` ignores the query and sends the directory as a frame;
        // one that understands it answers with only an etag, and the body is read over HTTP.
        expect(relayHubUrl('https://relay.example')).toBe('wss://relay.example/client?dir=http');
        expect(relayHubUrl('https://relay.example/')).toBe('wss://relay.example/client?dir=http');
        expect(relayHubUrl('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080/client?dir=http');
    });

    it('derives the directory read from the hub URL', () => {
        expect(relayMachinesUrl(relayHubUrl('https://relay.example'))).toBe('https://relay.example/machines');
        expect(relayMachinesUrl(relayHubUrl('http://127.0.0.1:8080'))).toBe('http://127.0.0.1:8080/machines');
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

describe('RelayHub directory', () => {
    const directory = (body: unknown, etag: string) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', etag } });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

    it('reads the directory over HTTP when the relay answers with an etag', async () => {
        // A relay that understands `dir=http` sends no directory body on the socket: the version
        // is the handshake, and the state is a read like any other.
        const fetchMock = vi.fn(async (..._args: unknown[]) => directory({ machines: [{ tag: 'aaaa', sessions: [] }] }, '"e1"'));
        vi.stubGlobal('fetch', fetchMock);
        const { hub, socket } = hubWith();
        socket.acceptHttp('"e1"');
        await settle();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('https://relay.example/machines');
        expect(hub.machines()).toEqual([{ tag: 'aaaa', sessions: [] }]);
    });

    it('re-reads only when the relay says the directory moved', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(directory({ machines: [{ tag: 'aaaa', sessions: [] }] }, '"e1"'))
            .mockResolvedValueOnce(directory({ machines: [{ tag: 'aaaa', sessions: [] }, { tag: 'bbbb', sessions: [] }] }, '"e2"'));
        vi.stubGlobal('fetch', fetchMock);
        const { hub, socket } = hubWith();
        socket.acceptHttp('"e1"');
        await settle();
        expect(hub.machines().map((m) => m.tag)).toEqual(['aaaa']);

        // The version this client already holds is not news.
        socket.deliver({ t: 'dir', etag: '"e1"' });
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        socket.deliver({ t: 'dir', etag: '"e2"' });
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[1][1]).toMatchObject({ headers: { 'if-none-match': '"e1"' } });
        expect(hub.machines().map((m) => m.tag)).toEqual(['aaaa', 'bbbb']);
    });

    it('keeps the directory it has when the read says nothing changed', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(directory({ machines: [{ tag: 'aaaa', sessions: [] }] }, '"e1"'))
            .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"e2"' } }));
        vi.stubGlobal('fetch', fetchMock);
        const { hub, socket } = hubWith();
        socket.acceptHttp('"e1"');
        await settle();

        socket.deliver({ t: 'dir', etag: '"e2"' });
        await settle();
        expect(hub.machines().map((m) => m.tag)).toEqual(['aaaa']);
    });

    it('keeps the copy it has when the read fails, rather than pretending the relay is empty', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(directory({ machines: [{ tag: 'aaaa', sessions: [] }] }, '"e1"'))
            .mockRejectedValueOnce(new Error('offline'));
        vi.stubGlobal('fetch', fetchMock);
        const { hub, socket } = hubWith();
        socket.acceptHttp('"e1"');
        await settle();

        socket.deliver({ t: 'dir', etag: '"e2"' });
        await settle();
        expect(hub.machines().map((m) => m.tag)).toEqual(['aaaa']);
    });

    it('still takes the directory as a frame from a relay that does not serve it over HTTP', async () => {
        // The older shape: no etag in `ok`, no read. This is what keeps a new App working against a
        // relay that predates the HTTP route.
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { hub, socket } = hubWith();
        socket.accept([{ tag: 'aaaa', sessions: [] }]);
        socket.deliver({ t: 'machines', machines: [{ tag: 'aaaa', sessions: [] }, { tag: 'bbbb', sessions: [] }] });
        await settle();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(hub.machines().map((m) => m.tag)).toEqual(['aaaa', 'bbbb']);
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

    it('writes the probe as soon as the stream is routed, so a silent peer still opens it', () => {
        // A daemon's LAN socket sends its snapshot on upgrade only when it has one: a machine
        // running no sessions answers an upgrade with nothing at all. Waiting for its first frame
        // therefore read a perfectly healthy machine as a relay that did not answer. The probe is
        // the LAN protocol's own question, and the pong is the stream being open.
        const { hub, socket } = hubWith();
        socket.accept();
        const stream = hub.stream('aaaa', '/lan/socket?nonce=n', JSON.stringify({ event: 'ping' })) as SocketLike;
        expect(socket.frames()).toEqual([
            { t: 'open', id: 1, tag: 'aaaa', path: '/lan/socket?nonce=n' },
            { t: 'msg', id: 1, data: JSON.stringify({ event: 'ping' }) },
        ]);
        expect(stream.readyState).toBe(0);

        const open = vi.fn();
        stream.onopen = open;
        socket.deliver({ t: 'msg', id: 1, data: JSON.stringify({ event: 'pong' }) });
        expect(open).toHaveBeenCalledTimes(1);
        expect(stream.readyState).toBe(1);
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

    it('reports a write the hub cannot take, instead of accepting a frame nothing carries', () => {
        // The window iOS leaves after a suspension: the hub's socket is dead but has not reported
        // its close, so the stream still reads as open. A send here used to return success and sit
        // on the delivery deadline; the failure belongs to this call.
        const { hub, socket } = hubWith();
        socket.accept();
        const stream = hub.stream('aaaa', '/lan/socket') as SocketLike;
        socket.deliver({ t: 'msg', id: 1, data: 'open me' });
        expect(stream.readyState).toBe(1);

        socket.readyState = 3;
        expect(() => stream.send('a frame')).toThrow();
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

    it('keeps the last directory when this side loses the hub', () => {
        // The directory is the relay's statement about what it holds; our socket dropping is this
        // side's interface, and the machine is connected to the relay rather than to us. Emptying it
        // here made every relay-backed session look unreachable for the length of a reconnect.
        const { hub, socket } = hubWith();
        socket.accept([{ tag: 'aaaa', sessions: [] }]);
        expect(hub.machines().map((m) => m.tag)).toEqual(['aaaa']);

        socket.close();

        expect(hub.machines().map((m) => m.tag)).toEqual(['aaaa']);
        hub.close();
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
