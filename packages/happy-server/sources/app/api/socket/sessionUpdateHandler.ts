import { sessionAliveEventsCounter, sessionPresenceEmittedCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import { buildNewMessageUpdate, buildSessionActivityEphemeral, buildUpdateSessionUpdate, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { allocateSessionSeq, allocateUserSeq } from "@/storage/seq";
import { AsyncLock } from "@/utils/lock";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { Socket } from "socket.io";

type SessionSnapshot = {
    sid: string;
    time: number;
    thinking?: boolean;
    thinkingAt?: number;
    startedAt?: number;
};

/**
 * The state snapshot a session sends for itself.
 *
 * The name is the old `session-alive`; the meaning is now "this is my current state", sent on a
 * transition or a reconnect rather than every two seconds. Absolute state makes a duplicate
 * harmless, which is what lets the old 2s fleet and this one share a handler.
 */
export async function applySessionAlive(
    userId: string,
    connectionSessionId: string | null,
    data: SessionSnapshot,
): Promise<{ sid: string; changed: boolean; presence: NonNullable<ReturnType<typeof activityCache.getSessionPresence>> } | null> {
    if (!data || typeof data.time !== 'number' || typeof data.sid !== 'string' || !data.sid) {
        return null;
    }
    // A session-scoped socket may only speak for the session it authenticated as.
    if (connectionSessionId !== null && data.sid !== connectionSessionId) {
        return null;
    }
    const t = Math.min(data.time, Date.now());
    if (t < Date.now() - 1000 * 60 * 10) {
        return null;
    }
    const isValid = await activityCache.isSessionValid(data.sid, userId);
    if (!isValid) {
        return null;
    }
    const result = activityCache.applySessionSnapshot(data.sid, userId, {
        time: t,
        thinking: data.thinking === true,
        thinkingAt: typeof data.thinkingAt === 'number' ? data.thinkingAt : undefined,
        startedAt: typeof data.startedAt === 'number' ? data.startedAt : undefined,
    });
    if (!result.accepted) {
        return null;
    }
    return { sid: data.sid, changed: result.changed, presence: result.presence };
}

/** The terminal transition. The database write is the cache's, so a queued alive update cannot undo it. */
export async function applySessionEnd(
    userId: string,
    connectionSessionId: string | null,
    data: { sid: string; time: number },
): Promise<{ sid: string; changed: boolean; presence: NonNullable<ReturnType<typeof activityCache.getSessionPresence>> } | null> {
    if (!data || typeof data.time !== 'number' || typeof data.sid !== 'string' || !data.sid) {
        return null;
    }
    if (connectionSessionId !== null && data.sid !== connectionSessionId) {
        return null;
    }
    const isValid = await activityCache.isSessionValid(data.sid, userId);
    if (!isValid) {
        return null;
    }
    const result = await activityCache.markSessionEnded(data.sid, userId, Date.now());
    if (!result.presence) {
        return null;
    }
    return { sid: data.sid, changed: result.changed, presence: result.presence };
}

export function sessionUpdateHandler(userId: string, socket: Socket, connection: ClientConnection) {
    socket.on('update-metadata', async (data: any, callback: (response: any) => void) => {
        try {
            const { sid, metadata, expectedVersion } = data;

            // Validate input
            if (!sid || typeof metadata !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }

            // Resolve session
            const session = await db.session.findUnique({
                where: { id: sid, accountId: userId }
            });
            if (!session) {
                return;
            }

            // Check version
            if (session.metadataVersion !== expectedVersion) {
                callback({ result: 'version-mismatch', version: session.metadataVersion, metadata: session.metadata });
                return null;
            }

            // Update metadata
            const { count } = await db.session.updateMany({
                where: { id: sid, metadataVersion: expectedVersion },
                data: {
                    metadata: metadata,
                    metadataVersion: expectedVersion + 1
                }
            });
            if (count === 0) {
                callback({ result: 'version-mismatch', version: session.metadataVersion, metadata: session.metadata });
                return null;
            }

            // Generate session metadata update
            const updSeq = await allocateUserSeq(userId);
            const metadataUpdate = {
                value: metadata,
                version: expectedVersion + 1
            };
            const updatePayload = buildUpdateSessionUpdate(sid, updSeq, randomKeyNaked(12), metadataUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
            });

            // Send success response with new version via callback
            callback({ result: 'success', version: expectedVersion + 1, metadata: metadata });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-metadata: ${error}`);
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });

    socket.on('update-state', async (data: any, callback: (response: any) => void) => {
        try {
            const { sid, agentState, expectedVersion } = data;

            // Validate input
            if (!sid || (typeof agentState !== 'string' && agentState !== null) || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }

            // Resolve session
            const session = await db.session.findUnique({
                where: {
                    id: sid,
                    accountId: userId
                }
            });
            if (!session) {
                callback({ result: 'error' });
                return null;
            }

            // Check version
            if (session.agentStateVersion !== expectedVersion) {
                callback({ result: 'version-mismatch', version: session.agentStateVersion, agentState: session.agentState });
                return null;
            }

            // Update agent state
            const { count } = await db.session.updateMany({
                where: { id: sid, agentStateVersion: expectedVersion },
                data: {
                    agentState: agentState,
                    agentStateVersion: expectedVersion + 1
                }
            });
            if (count === 0) {
                callback({ result: 'version-mismatch', version: session.agentStateVersion, agentState: session.agentState });
                return null;
            }

            // Generate session agent state update
            const updSeq = await allocateUserSeq(userId);
            const agentStateUpdate = {
                value: agentState,
                version: expectedVersion + 1
            };
            const updatePayload = buildUpdateSessionUpdate(sid, updSeq, randomKeyNaked(12), undefined, agentStateUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
            });

            // Send success response with new version via callback
            callback({ result: 'success', version: expectedVersion + 1, agentState: agentState });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-state: ${error}`);
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });
    socket.on('session-alive', async (data: SessionSnapshot) => {
        try {
            websocketEventsCounter.inc({ event_type: 'session-alive' });
            sessionAliveEventsCounter.inc();

            const sessionId = connection.connectionType === 'session-scoped' ? connection.sessionId : null;
            const result = await applySessionAlive(userId, sessionId, data);
            if (!result || !result.changed) {
                return;
            }

            eventRouter.emitEphemeral({
                userId,
                payload: buildSessionActivityEphemeral(
                    result.sid,
                    true,
                    result.presence.activeAt,
                    result.presence.thinking,
                    result.presence.thinkingAt,
                ),
                recipientFilter: { type: 'user-scoped-only' }
            });
            sessionPresenceEmittedCounter.inc({ event: 'alive' });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-alive: ${error}`);
        }
    });

    const receiveMessageLock = new AsyncLock();
    socket.on('message', async (data: any) => {
        await receiveMessageLock.inLock(async () => {
            try {
                websocketEventsCounter.inc({ event_type: 'message' });
                const { sid, message, localId } = data;

                log({ module: 'websocket' }, `Received message from socket ${socket.id}: sessionId=${sid}, messageLength=${message.length} bytes, connectionType=${connection.connectionType}, connectionSessionId=${connection.connectionType === 'session-scoped' ? connection.sessionId : 'N/A'}`);

                // Resolve session
                const session = await db.session.findUnique({
                    where: { id: sid, accountId: userId }
                });
                if (!session) {
                    return;
                }
                let useLocalId = typeof localId === 'string' ? localId : null;

                // Create encrypted message
                const msgContent: PrismaJson.SessionMessageContent = {
                    t: 'encrypted',
                    c: message
                };

                // Resolve seq
                const updSeq = await allocateUserSeq(userId);
                const msgSeq = await allocateSessionSeq(sid);

                // Check if message already exists
                if (useLocalId) {
                    const existing = await db.sessionMessage.findFirst({
                        where: { sessionId: sid, localId: useLocalId }
                    });
                    if (existing) {
                        return { msg: existing, update: null };
                    }
                }

                // Create message
                const msg = await db.sessionMessage.create({
                    data: {
                        sessionId: sid,
                        seq: msgSeq,
                        content: msgContent,
                        localId: useLocalId
                    }
                });

                // Emit new message update to relevant clients
                const updatePayload = buildNewMessageUpdate(msg, sid, updSeq, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: connection
                });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in message handler: ${error}`);
            }
        });
    });

    socket.on('session-end', async (data: { sid: string; time: number }) => {
        try {
            const sessionId = connection.connectionType === 'session-scoped' ? connection.sessionId : null;
            const result = await applySessionEnd(userId, sessionId, data);
            if (!result || !result.changed) {
                return;
            }

            eventRouter.emitEphemeral({
                userId,
                payload: buildSessionActivityEphemeral(result.sid, false, result.presence.activeAt, false, 0),
                recipientFilter: { type: 'user-scoped-only' }
            });
            sessionPresenceEmittedCounter.inc({ event: 'end' });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-end: ${error}`);
        }
    });

}