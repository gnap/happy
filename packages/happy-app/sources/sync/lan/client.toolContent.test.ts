import { afterEach, describe, expect, it, vi } from 'vitest';

// The client under test only touches the network here, so the native HMAC stub is the same one the
// other LAN tests use.
vi.mock('@/encryption/hmac_sha256', () => ({ hmac_sha256: vi.fn(async () => new Uint8Array(32)) }));

const { fetchToolContent } = await import('./client');

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
        } as unknown as Response;
    }));
    return calls;
}

describe('fetchToolContent', () => {
    it('asks the machine for the call, carrying the token and the account proof', async () => {
        const calls = stub({ status: 200, body: { args: { command: 'ls' }, result: { stdout: 'x' } } });

        const content = await fetchToolContent(base, 't1', 'sess-1', 'call-1', {
            'x-happy-proof-nonce': 'n1',
            'x-happy-proof-at': '1',
            'x-happy-proof-signature': 'sig',
        });

        expect(calls[0].url).toBe(`${base}/lan/sessions/sess-1/tool-content/call-1`);
        expect(calls[0].init.headers.authorization).toBe('Bearer t1');
        expect(calls[0].init.headers['x-happy-proof-nonce']).toBe('n1');
        expect(content).toEqual({ args: { command: 'ls' }, result: { stdout: 'x' } });
    });

    it('returns null for a call this machine does not have, so the caller can ask the server', async () => {
        stub({ status: 404 });
        expect(await fetchToolContent(base, 't1', 'sess-1', 'call-1')).toBeNull();
    });

    it('reports a refusal rather than pretending the content is absent', async () => {
        stub({ status: 403 });
        await expect(fetchToolContent(base, 't1', 'sess-1', 'call-1')).rejects.toMatchObject({ status: 403 });
    });
});
