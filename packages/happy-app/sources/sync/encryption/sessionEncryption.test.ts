import { describe, expect, it } from 'vitest';
import { SessionEncryption } from './sessionEncryption';
import { EncryptionCache } from './encryptionCache';
import { encodeBase64 } from '@/encryption/base64';

/** Ciphertext here is just the JSON payload, so the test can name what it encrypts. */
const ciphertext = (value: unknown) => encodeBase64(new TextEncoder().encode(JSON.stringify(value)));

const fakeEncryptor = {
    encrypt: async (data: any[]) => data.map((item) => new TextEncoder().encode(JSON.stringify(item))),
    decrypt: async (data: Uint8Array[]) => data.map((item) => JSON.parse(new TextDecoder().decode(item))),
};

const metadata = (model: string) => ({ path: '/tmp/project', host: 'host', currentModelCode: model });

describe('SessionEncryption decryption cache', () => {
    it('returns each ciphertext when one version carries different content', async () => {
        const encryption = new SessionEncryption('session-1', fakeEncryptor, new EncryptionCache());

        // A session mirrors an unacknowledged write at the last acknowledged version, so the
        // same version can arrive with different content before the server's numbered update.
        const first = await encryption.decryptMetadata(5, ciphertext(metadata('first')));
        const second = await encryption.decryptMetadata(5, ciphertext(metadata('second')));

        expect(first?.currentModelCode).toBe('first');
        expect(second?.currentModelCode).toBe('second');
    });

    it('does the same for agent state', async () => {
        const encryption = new SessionEncryption('session-1', fakeEncryptor, new EncryptionCache());

        const first = await encryption.decryptAgentState(2, ciphertext({ controlledByUser: true }));
        const second = await encryption.decryptAgentState(2, ciphertext({ controlledByUser: false }));

        expect(first.controlledByUser).toBe(true);
        expect(second.controlledByUser).toBe(false);
    });
});
