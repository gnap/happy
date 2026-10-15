/**
 * Writing to a session, over whichever channel is carrying it.
 *
 * The three transports were three branches of one function body in the sync engine, each with its
 * own idea of what a successful write means — and the differences are real, not incidental:
 *
 * - the **server's socket** echoes the message back, so handing it over *is* the acknowledgement;
 * - the **server's HTTP route** answers with the seqs it assigned, which is both an acknowledgement
 *   and where the App now stands;
 * - a **daemon's socket** acknowledges nothing. A write proves only that this side handed bytes to a
 *   socket whose peer may already be gone — and treating that write as the delivery is what made
 *   the first message of a connection disappear while the second went through.
 *
 * So the outcome says which of those happened, and the caller acts on it. A lowest-common-
 * denominator "did it work" would have to answer *yes* for the daemon's write, which is the bug
 * this shape exists to keep out.
 *
 * The transports are handed in rather than imported, so what each one does with a batch can be
 * pinned down without a device: this file is the ops half of the channel layer, and the half that
 * sync owns.
 */

import type { SessionChannel } from '@/sync/lan/types';

/** One message on its way out, already encrypted. */
export type OutgoingMessage = { localId: string; content: string };

/** What happened to a batch handed to a channel. */
export type SendOutcome =
    /**
     * The channel took it and stands behind it. `advanceTo` is where the session now stands, when
     * the channel says — the server's HTTP route knows the seq it assigned; its socket does not,
     * and says so by leaving it out.
     */
    | { kind: 'acked'; advanceTo?: number }
    /**
     * The channel took it and nothing has confirmed it. The caller waits for the session's own
     * verdict; on the daemon channels that is the only thing that ever proves delivery.
     */
    | { kind: 'unconfirmed'; awaitVerdict: (localId: string) => void }
    /** This channel cannot take it at all — not connected, or the write was refused. Try another. */
    | { kind: 'unavailable' }
    /** The channel tried and failed in a way worth reporting. */
    | { kind: 'failed'; error: unknown };

/** The daemon's socket, as far as sending is concerned. */
export type DaemonSendSocket = {
    send(message: { sessionId: string; localId: string; content: string }): boolean;
};

/** The server's transports, as far as sending is concerned. */
export type ServerSendTransport = {
    isConnected: boolean;
    send(event: string, payload: unknown): void;
    request(path: string, init: {
        method: string;
        body: string;
        headers: Record<string, string>;
        signal?: AbortSignal;
    }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
};

/**
 * Hand a batch to the session over the machine's own channel.
 *
 * Unconfirmed by construction: the session's log entry is the only proof, and it arrives later —
 * so the caller is given the wait to register rather than a verdict this cannot give.
 */
export function sendOverDaemonSocket(args: {
    socket: DaemonSendSocket;
    sessionId: string;
    batch: readonly OutgoingMessage[];
    /** Registered by the caller for each entry: how it waits for the session's verdict. */
    awaitVerdict: (localId: string) => void;
}): SendOutcome {
    const written = args.batch.filter((message) => args.socket.send({
        sessionId: args.sessionId,
        localId: message.localId,
        content: message.content,
    }));
    if (written.length !== args.batch.length) {
        // A socket that refused part of the batch is not carrying this session: the caller falls
        // through to the server, and the entries stay queued either way.
        return { kind: 'unavailable' };
    }
    return { kind: 'unconfirmed', awaitVerdict: args.awaitVerdict };
}

/**
 * Hand a batch to the session over the server's socket.
 *
 * The echo is the acknowledgement: the server sends the message back, and the session's own copy
 * follows. Nothing to wait for beyond that, which is why the entries are settled here.
 */
export function sendOverServerSocket(args: {
    transport: ServerSendTransport;
    sessionId: string;
    batch: readonly OutgoingMessage[];
}): SendOutcome {
    if (!args.transport.isConnected) {
        return { kind: 'unavailable' };
    }
    try {
        for (const message of args.batch) {
            args.transport.send('message', {
                sid: args.sessionId,
                message: message.content,
                localId: message.localId,
            });
        }
        return { kind: 'acked' };
    } catch (error) {
        // A socket that threw mid-batch may have taken some of it: the caller falls through to the
        // HTTP route, which is idempotent on `localId`.
        return { kind: 'failed', error };
    }
}

/**
 * Hand a batch to the session over the server's HTTP route.
 *
 * The acknowledgement carries the seqs the server assigned, so this is the one path that also says
 * where the session now stands — the App's receive cursor moves with it rather than being pulled.
 */
export async function sendOverServerHttp(args: {
    transport: ServerSendTransport;
    sessionId: string;
    batch: readonly OutgoingMessage[];
    signal?: AbortSignal;
}): Promise<SendOutcome> {
    try {
        const response = await args.transport.request(`/v3/sessions/${args.sessionId}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                messages: args.batch.map((message) => ({
                    localId: message.localId,
                    content: message.content,
                })),
            }),
            headers: { 'Content-Type': 'application/json' },
            signal: args.signal,
        });
        if (!response.ok) {
            return { kind: 'failed', error: new Error(`Failed to send messages for ${args.sessionId}: ${response.status}`) };
        }
        const data = await response.json() as { messages?: { seq: number }[] };
        const seqs = (data.messages ?? []).map((message) => message.seq).filter((seq) => typeof seq === 'number');
        return seqs.length > 0 ? { kind: 'acked', advanceTo: Math.max(...seqs) } : { kind: 'acked' };
    } catch (error) {
        return { kind: 'failed', error };
    }
}

/** The channels that can hand a message to a session, in the caller's order of preference. */
export const SEND_CHANNELS: readonly SessionChannel[] = ['lan', 'relay', 'server'];
