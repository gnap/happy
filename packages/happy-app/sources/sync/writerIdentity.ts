/**
 * Reader-side extraction of the per-writer identity `(sid, site, n)`.
 *
 * The CLI stamps this onto every outbound record so a reader can order and gap-check a session
 * without depending on the server's `seq`. It is always *inside the ciphertext* — for session
 * records it rides in the envelope, for the legacy `role:'agent'` shapes (cursor, codex, output,
 * acp, session-event) there is no envelope, so it sits in `content` next to `type`. Those legacy
 * shapes are the main path for a cursor session, which is why they were stamped too.
 *
 * The rule below is the CLI's own, from `packages/happy-cli/src/api/sessionPayloads.ts`
 * (`stampAgentRecord`): `role === 'session' ? content.data ?? content : content`. Keeping it
 * identical matters more than it looking tidy — a divergence here silently yields "no identity"
 * for a whole class of records, which reads as missing messages to gap detection.
 */

/** The writer identity triple. `n` is absent on records written before the CLI stamped them. */
export type WriterIdentity = {
    /** Client-owned session identity (the CLI's `tag`). */
    sid?: string;
    /** Writer identity — the CLI's `machineId`. */
    site?: string;
    /** Per-writer monotonic counter. Contiguity within a `site` is the gap signal. */
    n?: number;
};

/** A decrypted record, in the shape `normalizeRawMessage` receives. */
type DecryptedRecord = {
    role?: unknown;
    content?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Pulls `(sid, site, n)` off a decrypted record.
 *
 * Returns `null` when the record carries no identity at all — a record written before the CLI
 * started stamping, or one authored by a client that does not stamp. Callers must treat that as
 * "this record has no ordering key", not as an error.
 */
export function parseWriterIdentity(raw: DecryptedRecord | null | undefined): WriterIdentity | null {
    if (!isObject(raw)) {
        return null;
    }
    const content = raw.content;
    if (!isObject(content)) {
        return null;
    }

    // Session records keep the triple inside the envelope (`content.data`); the legacy agent
    // shapes keep it directly on `content`. `?? content` also covers the unwrapped envelope
    // shape that `preprocessMessageContent` rewrites.
    const carrier = raw.role === 'session' ? (isObject(content.data) ? content.data : content) : content;

    const sid = typeof carrier.sid === 'string' ? carrier.sid : undefined;
    const site = typeof carrier.site === 'string' ? carrier.site : undefined;
    const n = typeof carrier.n === 'number' ? carrier.n : undefined;

    if (sid === undefined && site === undefined && n === undefined) {
        return null;
    }
    return { sid, site, n };
}

/**
 * Ordering key for two records written by the same `site`.
 *
 * `(n, site)` is the intended order — it is server-independent, so it survives a channel switch.
 * Records without an `n` fall back to `null` and their caller's secondary key (timestamp), because
 * inventing a position for them would reorder real messages around them.
 */
export function compareByIdentity(a: WriterIdentity | null, b: WriterIdentity | null): number | null {
    if (!a || !b) {
        return null;
    }
    if (a.n === undefined || b.n === undefined) {
        return null;
    }
    // Different writers have independent counters; `(n, site)` is only an order within one site.
    if (a.site !== undefined && b.site !== undefined && a.site !== b.site) {
        return null;
    }
    return a.n - b.n;
}

/**
 * Whether `n` is contiguous across `identities` for a single site — i.e. whether gap detection can
 * be trusted for that site at all.
 *
 * Returns the missing counters when there is a gap. An empty array means contiguous. `null` means
 * the question is unanswerable: the identities span more than one site, or any of them lacks `n`
 * (in which case a "gap" would be an artefact of unstamped records, not a lost message).
 */
export function findMissingCounters(identities: (WriterIdentity | null)[]): number[] | null {
    const sites = new Set<string>();
    const values: number[] = [];
    for (const identity of identities) {
        if (!identity || identity.n === undefined || identity.site === undefined) {
            return null;
        }
        sites.add(identity.site);
        values.push(identity.n);
    }
    if (sites.size > 1) {
        return null;
    }
    values.sort((a, b) => a - b);
    const missing: number[] = [];
    for (let i = 1; i < values.length; i++) {
        for (let n = values[i - 1] + 1; n < values[i]; n++) {
            missing.push(n);
        }
    }
    return missing;
}
