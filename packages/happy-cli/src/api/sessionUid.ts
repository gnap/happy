/**
 * Persistence for a session lineage's uid.
 *
 * The tag names a lineage on this machine, but it is the CLI's private name: it is never published
 * to the App. `sessionUid` is the lineage's public name — an opaque, write-once id the App stores
 * alongside the server's `sessionId`, so it can eventually key rows by something the server does not
 * issue and this machine cannot change.
 *
 * It has to survive a resume without the server. A restart hands the new process the tag
 * (`--resume-session-tag`) and nothing else, and the resume may happen while the server is
 * unreachable; deriving the uid from the tag would make it a hash rather than an identity, and
 * asking the server would leave a resumed session nameless until it reconnects. So it is minted
 * once and written down beside the tag's key, keyed the same way.
 *
 * Everything here is wrapped: metadata construction runs on the session start path, where a
 * filesystem error must cost a uid, not a session.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

function warn(message: string, meta: Record<string, unknown>): void {
    try {
        logger.warn(`[session-uid] ${message}`, meta);
    } catch {
        /* logging must never break session start */
    }
}

/**
 * The tag is caller-supplied and never validated, so it is hashed rather than used as a filename.
 * Same scheme as the session key: one tag maps to one file in each store.
 */
export function sessionUidPath(tag: string): string {
    const name = createHash('sha256').update(tag).digest('hex').slice(0, 32);
    return join(configuration.happyHomeDir, `session-uid-${name}`);
}

export function readSessionUid(tag: string): string | null {
    const path = sessionUidPath(tag);
    if (!existsSync(path)) {
        return null;
    }
    try {
        const uid = readFileSync(path, 'utf8').trim();
        return uid.length > 0 ? uid : null;
    } catch (error) {
        warn('failed to read session uid', { tag, error: String(error) });
        return null;
    }
}

export function persistSessionUid(tag: string, uid: string): void {
    const path = sessionUidPath(tag);
    const tmp = join(configuration.happyHomeDir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    try {
        const dir = configuration.happyHomeDir;
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(tmp, uid, { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, path);
    } catch (error) {
        try {
            unlinkSync(tmp);
        } catch {
            /* best effort */
        }
        warn('failed to persist session uid', { tag, error: String(error) });
    }
}

/**
 * The uid for this tag, minted and written if this lineage has never had one.
 *
 * A failed write still returns the minted uid for this process: a session without a durable name is
 * better than a session without metadata, and the next start is the place to try again.
 */
export function resolveSessionUid(tag: string): string {
    const existing = readSessionUid(tag);
    if (existing) {
        return existing;
    }
    const uid = randomUUID();
    persistSessionUid(tag, uid);
    return uid;
}
