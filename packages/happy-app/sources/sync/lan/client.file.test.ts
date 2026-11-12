import { afterEach, describe, expect, it, vi } from 'vitest';

// The client under test only touches the network here, so the native HMAC stub is the same one the
// other LAN tests use.
vi.mock('@/encryption/hmac_sha256', () => ({ hmac_sha256: vi.fn(async () => new Uint8Array(32)) }));

const { fetchSessionFileBytes, fetchSessionFolderBytes } = await import('./client');

const base = 'http://10.0.0.2:55673';

afterEach(() => { vi.unstubAllGlobals(); });

function stub(answer: { status: number; bytes?: Uint8Array; body?: unknown; headers?: Record<string, string> }) {
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
        calls.push({ url: String(url), init });
        return {
            ok: answer.status >= 200 && answer.status < 300,
            status: answer.status,
            headers: { get: (name: string) => answer.headers?.[name.toLowerCase()] ?? null },
            arrayBuffer: async () => answer.bytes ?? new ArrayBuffer(0),
            json: async () => answer.body ?? {},
            text: async () => (answer.body === undefined ? '' : JSON.stringify(answer.body)),
        } as unknown as Response;
    }));
    return calls;
}

describe('fetchSessionFileBytes', () => {
    it('reads the file into memory, carrying the token and the account proof', async () => {
        // The web/Tauri viewer has no file system to download into; this is its transport.
        const calls = stub({ status: 200, bytes: new TextEncoder().encode('<html>hi</html>') });

        const file = await fetchSessionFileBytes(base, 't1', 'sess-1', 'viz/waterfall.html', {
            'x-happy-proof-nonce': 'n1',
            'x-happy-proof-at': '1',
            'x-happy-proof-signature': 'sig',
        });

        expect(calls[0].url).toBe(`${base}/lan/sessions/sess-1/file?path=viz%2Fwaterfall.html`);
        expect(calls[0].init.headers.authorization).toBe('Bearer t1');
        expect(calls[0].init.headers['x-happy-proof-nonce']).toBe('n1');
        expect(new TextDecoder().decode(file!.bytes)).toBe('<html>hi</html>');
        expect(file!.size).toBe(15);
    });

    it('returns null for a file this machine does not have, so the carry can say "absent"', async () => {
        stub({ status: 404 });
        expect(await fetchSessionFileBytes(base, 't1', 'sess-1', 'nope.txt')).toBeNull();
    });

    it('reports a refusal rather than pretending the file is absent', async () => {
        stub({ status: 403, body: { error: 'account proof required' } });
        await expect(fetchSessionFileBytes(base, 't1', 'sess-1', 'a.txt'))
            .rejects.toMatchObject({ status: 403 });
    });
});

describe('fetchSessionFolderBytes', () => {
    it('reads the packed directory and keeps the machine’s name for it', async () => {
        const archive = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
        const calls = stub({
            status: 200,
            bytes: archive,
            headers: { 'content-disposition': 'attachment; filename="static.tar.gz"' },
        });

        const folder = await fetchSessionFolderBytes(base, 't1', 'sess-1', 'pkg/web/static', {
            'x-happy-proof-nonce': 'n1',
        });

        expect(calls[0].url).toBe(`${base}/lan/sessions/sess-1/folder?path=pkg%2Fweb%2Fstatic`);
        expect(calls[0].init.headers.authorization).toBe('Bearer t1');
        expect(calls[0].init.headers['x-happy-proof-nonce']).toBe('n1');
        expect(folder!.name).toBe('static.tar.gz');
        expect(folder!.bytes).toEqual(archive);
    });

    it('returns null for a directory this machine does not have', async () => {
        stub({ status: 404 });
        expect(await fetchSessionFolderBytes(base, 't1', 'sess-1', 'nope')).toBeNull();
    });

    it('reports a refusal rather than pretending the folder is absent', async () => {
        stub({ status: 403 });
        await expect(fetchSessionFolderBytes(base, 't1', 'sess-1', 'a'))
            .rejects.toMatchObject({ status: 403 });
    });
});
