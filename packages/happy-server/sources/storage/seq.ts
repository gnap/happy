/**
 * Two distinct seq spaces (do not mix in clients):
 * - User seq (Account.seq): global per account, used in realtime payload envelope (payload.seq).
 *   Allocate via allocateUserSeq(accountId). Monotonic across all sessions/artifacts/machines.
 * - Session seq (Session.seq): per-session message seq. GET /v1/sessions returns Session.seq.
 *   Realtime new-message sends body.message.seq = this. App should display Session.seq (session-internal), not envelope seq.
 */
import { db } from "@/storage/db";
import type { Prisma } from "@prisma/client";

type SeqClient = Pick<Prisma.TransactionClient, "account" | "session">;

function resolveClient(tx?: SeqClient) {
    return tx ?? db;
}

export async function allocateUserSeq(accountId: string) {
    const user = await db.account.update({
        where: { id: accountId },
        select: { seq: true },
        data: { seq: { increment: 1 } }
    });
    const seq = user.seq;
    return seq;
}

export async function allocateSessionSeq(sessionId: string) {
    const session = await db.session.update({
        where: { id: sessionId },
        select: { seq: true },
        data: { seq: { increment: 1 } }
    });
    const seq = session.seq;
    return seq;
}

export async function allocateSessionSeqBatch(sessionId: string, count: number, tx?: SeqClient) {
    if (count <= 0) {
        return [] as number[];
    }

    const client = resolveClient(tx);
    const session = await client.session.update({
        where: { id: sessionId },
        select: { seq: true },
        data: { seq: { increment: count } }
    });

    const endSeq = session.seq;
    const startSeq = endSeq - count + 1;
    return Array.from({ length: count }, (_, index) => startSeq + index);
}
