import { afterEach, describe, expect, it, vi } from 'vitest';

// The client under test only touches the network here, so the native HMAC stub is the same one the
// other LAN tests use.
vi.mock('@/encryption/hmac_sha256', () => ({ hmac_sha256: vi.fn(async () => new Uint8Array(32)) }));

const { archiveSessionAt, restartAskBody, restartSessionAt, sessionControlAt } = await import('./client');

const base = 'http://10.0.0.2:55673';

afterEach(() => { vi.unstubAllGlobals(); });

function stub(answer: { status: number; body?: unknown }) {
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
        calls.push({ url: String(url), init });
        return {
            ok: answer.status >= 200 && answer.status < 300,
            status: answer.status,
            json: async () => answer.body ?? {},
            text: async () => (answer.body === undefined ? '' : JSON.stringify(answer.body)),
        } as unknown as Response;
    }));
    return calls;
}

describe('sessionControlAt', () => {
    it('hands the call over and says so', async () => {
        const calls = stub({ status: 200 });
        expect(await sessionControlAt(base, 't1', 'sess-1', 'permission', 'cipher')).toBe(true);
        expect(calls[0].url).toBe(`${base}/lan/sessions/sess-1/control`);
    });

    it('says false only for a session this machine does not have', async () => {
        // The one answer that belongs to another channel: who holds the session.
        stub({ status: 404 });
        expect(await sessionControlAt(base, 't1', 'sess-1', 'permission', 'cipher')).toBe(false);
    });

    it('throws a proof refusal with the daemon’s own words, not a collapsed "failed"', async () => {
        // A 403 used to come back as `false` — "nobody here to ask" — which sent the same request
        // to another channel and reported the machine's refusal as its absence.
        stub({ status: 403, body: { error: 'account proof required' } });
        await expect(sessionControlAt(base, 't1', 'sess-1', 'permission', 'cipher'))
            .rejects.toMatchObject({ name: 'LanRequestError', status: 403, body: 'account proof required' });
    });

    it('throws a body-limit answer with its status and the daemon’s explanation', async () => {
        stub({ status: 413, body: { error: 'Payload Too Large' } });
        await expect(sessionControlAt(base, 't1', 'sess-1', 'permission', 'cipher'))
            .rejects.toMatchObject({ name: 'LanRequestError', status: 413, body: 'Payload Too Large' });
    });
});

describe('archiveSessionAt', () => {
    it('posts the deletion to the daemon, with the account proof it was given', async () => {
        const calls = stub({ status: 200 });
        expect(await archiveSessionAt(base, 't1', 'sess-1', { 'x-happy-proof-signature': 'sig' })).toBe(true);
        expect(calls[0].url).toBe(`${base}/lan/sessions/sess-1/archive`);
        expect(calls[0].init.method).toBe('POST');
        expect(calls[0].init.headers['x-happy-proof-signature']).toBe('sig');
    });

    it('says false only for a session this machine has nothing to delete', async () => {
        // A build without the route, or no session by that id: the server may still hold it, so
        // this is the one answer that belongs to another channel.
        stub({ status: 404 });
        expect(await archiveSessionAt(base, 't1', 'sess-1')).toBe(false);
    });

    it('throws a proof refusal rather than sending the same delete to the server', async () => {
        stub({ status: 403, body: { error: 'account proof required' } });
        await expect(archiveSessionAt(base, 't1', 'sess-1'))
            .rejects.toMatchObject({ name: 'LanRequestError', status: 403, body: 'account proof required' });
    });
});

describe('restartAskBody', () => {
    it('says nothing when there is nothing to ask', () => {
        // No body at all: a POST declaring JSON with an empty one is rejected before the route.
        expect(restartAskBody(undefined)).toBeNull();
        expect(restartAskBody({})).toBeNull();
    });

    it('carries the observed generation without asking for acceptance', () => {
        // Older behavior: the machine still waits for the outcome. The generation alone is enough
        // for it to tell a repeat from a new restart.
        expect(restartAskBody({ generation: 7 })).toEqual({ generation: 7 });
    });

    it('keeps the desktop mode when it is false', () => {
        // `false` is a move *out* of the desktop session, not "unset"; dropping it would leave the
        // session where the caller asked to take it from.
        expect(restartAskBody({ requiresDesktop: false })).toEqual({ requiresDesktop: false });
    });

    it('carries all three when the caller asks for all of them', () => {
        expect(restartAskBody({ requiresDesktop: true, generation: 4, expectAccepted: true }))
            .toEqual({ requiresDesktop: true, generation: 4, expect: 'accepted' });
    });
});

describe('restartSessionAt', () => {
    it('returns null only for the 404 of nothing to restart', async () => {
        stub({ status: 404 });
        expect(await restartSessionAt(base, 't1', 'sess-1')).toBeNull();
    });

    it('throws a proof refusal rather than reading it as "cannot be asked"', async () => {
        stub({ status: 403, body: { error: 'account proof required' } });
        await expect(restartSessionAt(base, 't1', 'sess-1'))
            .rejects.toMatchObject({ name: 'LanRequestError', status: 403, body: 'account proof required' });
    });

    it('returns the verdict the daemon gave, including when the answer is no', async () => {
        stub({ status: 200, body: { success: false, error: 'no desktop to move it to' } });
        expect(await restartSessionAt(base, 't1', 'sess-1')).toEqual({ success: false, error: 'no desktop to move it to' });
    });

    it('asks with the generation and the acceptance, and reads the structured answer back', async () => {
        // The two fields travel together and the answer's whole shape survives: the caller needs
        // the accepted generation to know which ask a later repeat is a repeat of.
        const calls = stub({ status: 200, body: { success: true, accepted: true, stage: 'scheduled', generation: 8, phase: 'Restarting' } });
        expect(await restartSessionAt(base, 't1', 'sess-1', undefined, { generation: 7, expectAccepted: true }))
            .toEqual({ success: true, accepted: true, stage: 'scheduled', generation: 8, phase: 'Restarting' });
        expect(calls[0].init.headers['content-type']).toBe('application/json');
        expect(JSON.parse(calls[0].init.body)).toEqual({ generation: 7, expect: 'accepted' });
    });

    it('sends no body and no JSON content type when it has nothing to say', async () => {
        // The common legacy ask must stay byte-for-byte what older daemons already accept.
        const calls = stub({ status: 200, body: { success: true } });
        await restartSessionAt(base, 't1', 'sess-1');
        expect(calls[0].init.body).toBeUndefined();
        expect(calls[0].init.headers['content-type']).toBeUndefined();
    });
});
