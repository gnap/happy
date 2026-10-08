import { lanProofFor } from './client';

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
    onClosed?: () => void;
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
        if (typeof event.data !== 'string') {
            return;
        }
        let frame: LanSocketFrame;
        try {
            frame = JSON.parse(event.data) as LanSocketFrame;
        } catch {
            return;
        }
        // Only `update` is acted on today. An unknown event is ignored rather than guessed at,
        // so a daemon that learns to push more cannot make an older App misread it.
        if (frame.event === 'update') {
            options.onUpdate(frame.payload);
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
    socket.onclose = () => {
        if (!deliberatelyClosed) {
            options.onClosed?.();
        }
    };
    socket.onerror = () => {
        if (!deliberatelyClosed) {
            options.onClosed?.();
        }
    };

    return {
        baseUrl: options.baseUrl,
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
