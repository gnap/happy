import { lanProofFor } from './client';
import { bump } from '@/sync/metrics';

/**
 * The live LAN channel.
 *
 * The daemon pushes the *same* `update` envelopes its server socket carries, so whatever consumes
 * this feeds them to the App's ordinary update handler — the LAN channel is transparent at the
 * protocol level rather than a parallel path with its own parsing.
 *
 * One socket carries every session on that machine, which is why this is opened per machine
 * rather than per session: the daemon's socket is machine-wide, and the App demultiplexes on
 * `body.sid` exactly as it does for the server channel.
 *
 * Authentication is a challenge proof spent at the upgrade — no bearer token, because a socket
 * does not need one: it authenticates once and then *is* the authenticated channel, so there is
 * no short-lived credential to leak or expire.
 *
 * Recovery is deliberately blunt: any close or error simply means "not live right now". The
 * caller keeps its polling fallback, so a socket that cannot stay up degrades to what the channel
 * did before it existed rather than going dark.
 */

/** Frames the daemon sends: an event name plus the payload that name routes. */
type LanSocketFrame = {
    event: string;
    payload: unknown;
};

/** An upgrade that has not completed by now is not going to be useful this tick. */
const LAN_SOCKET_OPEN_TIMEOUT_MS = 5_000;

export type LanSocketHandle = {
    baseUrl: string;
    /**
     * Writes a user message back over the live channel. False when the socket is not open, which
     * the caller treats as "not this channel" rather than as a failure — the outbox still holds
     * the message, and the server path is still there.
     *
     * `content` is the ciphertext the server route carries: the LAN is plain HTTP, so the payload
     * must stay unreadable here and is decrypted only by the session that owns the key.
     */
    send: (message: { sessionId: string; localId: string; content: string }) => boolean;
    /**
     * Ask the daemon to prove the connection is alive. False when the socket is not open; a true
     * return only means the frame was written, so liveness is the `onBeat` callback, not this.
     */
    ping: () => boolean;
    close: () => void;
};

/** `http://host:port` → `ws://host:port`; the path is appended by the caller. */
function toWebSocketBase(baseUrl: string): string {
    return baseUrl.replace(/^http/, 'ws');
}

/**
 * Opens an authenticated socket to a daemon. Returns null when it cannot be established —
 * no challenge, a rejected proof, or a socket that never opens — leaving the caller to carry on
 * with whatever it had.
 */
export async function openLanSocket(options: {
    baseUrl: string;
    machineKey: Uint8Array;
    /** Called for every `update` payload the daemon pushes. */
    onUpdate: (payload: unknown) => void;
    /** Called once the socket closes, for any reason; the caller decides whether to reopen. */
    /**
     * The socket ended, and how. `deliberate` is this App's own close; otherwise the code and
     * reason are what the peer sent — 1006 with no reason means the connection died without one,
     * which is what a network change or a suspension looks like from here, while any other code is
     * the far end saying something.
     */
    onClosed?: (info: { deliberate: boolean; code?: number; reason?: string }) => void;
    /**
     * Called with the session's verdict on a message the App sent this way. A write is not a
     * delivery, and only the session can say whether the message reached the agent.
     */
    onDelivered?: (result: { sessionId: string; localId: string; delivered: boolean }) => void;
    /**
     * The daemon answered a heartbeat. This is the only proof that the connection is alive *now*:
     * a socket killed silently — the usual shape after iOS suspends an app — still reads as open
     * from here, and without this nothing would ever notice, so pushes would simply stop arriving.
     */
    onBeat?: () => void;
}): Promise<LanSocketHandle | null> {
    let nonce: string;
    try {
        const response = await fetch(`${options.baseUrl}/lan/challenge`, { method: 'POST' });
        if (!response.ok) {
            return null;
        }
        nonce = ((await response.json()) as { nonce: string }).nonce;
    } catch {
        return null;
    }

    const proof = await lanProofFor(options.machineKey, nonce);
    const url =
        `${toWebSocketBase(options.baseUrl)}/lan/socket` +
        `?nonce=${encodeURIComponent(nonce)}&proof=${encodeURIComponent(proof)}`;

    const socket = new WebSocket(url);
    let deliberatelyClosed = false;

    socket.onmessage = (event) => {
        bump('socketFrames');
        if (typeof event.data !== 'string') {
            return;
        }
        let frame: LanSocketFrame;
        try {
            frame = JSON.parse(event.data) as LanSocketFrame;
        } catch {
            return;
        }
        // An unknown event is ignored rather than guessed at, so a daemon that learns to push more
        // cannot make an older App misread it.
        if (frame.event === 'pong') {
            options.onBeat?.();
            return;
        }
        if (frame.event === 'update') {
            options.onUpdate(frame.payload);
            return;
        }
        if (frame.event === 'delivered') {
            const result = frame.payload as { sessionId?: unknown; localId?: unknown; delivered?: unknown };
            if (typeof result?.localId === 'string') {
                options.onDelivered?.({
                    sessionId: typeof result.sessionId === 'string' ? result.sessionId : '',
                    localId: result.localId,
                    delivered: result.delivered === true,
                });
            }
        }
    };

    // Wait for the upgrade before handing the socket out, so the caller's two outcomes are
    // unambiguous: null means "not usable", and a close *after* this means a genuine drop worth
    // reopening. Without the wait, a socket that failed immediately would be handed over as if
    // it were live, and the caller would never try again.
    const opened = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), LAN_SOCKET_OPEN_TIMEOUT_MS);
        const settle = (value: boolean) => {
            clearTimeout(timer);
            resolve(value);
        };
        socket.onopen = () => settle(true);
        socket.onclose = () => settle(false);
        socket.onerror = () => settle(false);
    });

    if (!opened) {
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        try {
            socket.close();
        } catch {
            /* already gone */
        }
        return null;
    }

    // Open, so from here a close is a drop rather than a failed handshake.
    socket.onclose = (event) => {
        options.onClosed?.({ deliberate: deliberatelyClosed, code: event?.code, reason: event?.reason });
    };
    socket.onerror = () => {
        // An error is followed by a close; reporting both would double-count the same drop.
    };

    return {
        baseUrl: options.baseUrl,
        ping: () => {
            if (deliberatelyClosed || socket.readyState !== 1) {
                return false;
            }
            try {
                socket.send(JSON.stringify({ event: 'ping' }));
                return true;
            } catch {
                return false;
            }
        },
        send: (message) => {
            // 1 = OPEN. Checked per send rather than once, because a socket can close between
            // sends and reporting success for a write nobody receives would lose the message.
            if (deliberatelyClosed || socket.readyState !== 1) {
                return false;
            }
            try {
                socket.send(JSON.stringify({ event: 'send', payload: message }));
                return true;
            } catch {
                return false;
            }
        },
        close: () => {
            // Detach first: a deliberate close must not report back as a drop, or the caller
            // would reopen the socket it just asked to shut.
            deliberatelyClosed = true;
            socket.onclose = null;
            socket.onerror = null;
            socket.onmessage = null;
            try {
                socket.close();
            } catch {
                /* already gone */
            }
        },
    };
}
