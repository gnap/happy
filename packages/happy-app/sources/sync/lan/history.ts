/**
 * Turns a LAN history response into plaintext.
 *
 * The daemon hands back the ciphertext exactly as the session process wrote it to its local
 * log, plus the session key wrapped to this account's content public key. That wrapped blob is
 * the same `version(1) || box(contentKey -> account content public key)` shape the server
 * serves as `Session.dataEncryptionKey`, so `Encryption.decryptEncryptionKey` opens it with no
 * changes — which is the whole reason the LAN response copies the field name.
 *
 * Nothing here touches the server: given the machine key (to authenticate) and the account
 * content key (to unwrap), a client can read history with the server down.
 */

import { decodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import type { LanHistory } from './types';

export type DecryptedLanEntry = {
    id: string;
    localId: string | null;
    /** 'in' for messages received from the server, 'out' for messages this machine sent. */
    dir: 'in' | 'out';
    /** When the session process recorded the entry. */
    at: number;
    /** The decrypted envelope, or null when this entry did not decrypt. */
    content: any | null;
};

export type DecryptedLanHistory = {
    tag: string;
    entries: DecryptedLanEntry[];
    /** How many entries actually opened — a short count means the key is wrong for some. */
    decryptedCount: number;
};

/**
 * Thrown when the wrapped session key cannot be opened with this account's content keypair.
 * That means the history was written for a different account, or the key blob is corrupt.
 */
export class LanKeyUnwrapError extends Error {
    constructor() {
        super('could not unwrap the session key from the LAN history response');
        this.name = 'LanKeyUnwrapError';
    }
}

export async function decryptLanHistory(
    encryption: Encryption,
    history: LanHistory
): Promise<DecryptedLanHistory> {
    const sessionKey = await encryption.decryptEncryptionKey(history.dataEncryptionKey);
    if (!sessionKey) {
        throw new LanKeyUnwrapError();
    }

    const decryptor = await encryption.openEncryption(sessionKey);
    const plaintexts = await decryptor.decrypt(history.entries.map((entry) => decodeBase64(entry.c, 'base64')));

    const entries: DecryptedLanEntry[] = history.entries.map((entry, index) => ({
        id: entry.id,
        localId: entry.localId ?? null,
        dir: entry.dir,
        at: entry.at,
        content: plaintexts[index] ?? null,
    }));

    return {
        tag: history.tag,
        entries,
        decryptedCount: entries.filter((entry) => entry.content !== null).length,
    };
}
