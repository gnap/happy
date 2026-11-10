import { afterEach, describe, expect, it, vi } from 'vitest';

// The client under test only touches the network here, so the native HMAC stub is the same one the
// other LAN tests use.
vi.mock('@/encryption/hmac_sha256', () => ({ hmac_sha256: vi.fn(async () => new Uint8Array(32)) }));

const { archiveSessionAt, restartSessionAt, sessionControlAt } = await import('./client');

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

describe('restartSessionAt', () => {    it('returns null only for the 404 of nothing to restart', async () => {
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
});
