/**
 * Manual end-to-end check for the LAN API, without touching a running daemon.
 *
 * The second half plays the *client's* role exactly as the mobile app would: it proves
 * possession of the machine key, then unwraps the session content key with an account content
 * private key and decrypts the message ciphertext. None of that needs a device -- the app's
 * side of this path is purely cryptographic -- so a green run here means "a client on this
 * network can read this session's history with the server down", modulo UI.
 *
 *   npx tsx scripts/lan-e2e.ts
 *
 * Then, in another shell:  dns-sd -B _happy._tcp local
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';

// Must be set before anything imports `configuration`, hence the dynamic imports below.
const home = mkdtempSync(join(tmpdir(), 'happy-lan-e2e-'));
process.env.HAPPY_HOME_DIR = home;

const { appendSessionLog, readSessionLog } = await import('@/api/sessionLog');
const { persistSessionKey } = await import('@/api/sessionKeyPersistence');
const { encodeBase64, decodeBase64, encrypt, decrypt, libsodiumEncryptForPublicKey } = await import('@/api/encryption');
const { startLanServer, lanProofFor, accountFingerprintOf } = await import('@/daemon/lanServer');

const MACHINE_ID = 'e2e-machine';
const MACHINE_KEY = new Uint8Array(32).fill(9);
const TAG = 'e2e-tag';
const SESSION_KEY = new Uint8Array(32).fill(3);

// ── Stand in for the mobile app: the account content keypair it derives from masterSecret.
const appContentKeyPair = tweetnacl.box.keyPair();

// ── Produce a real session key on disk and a real local log, using the same writers the
//    session process uses.
persistSessionKey(TAG, SESSION_KEY);
const messages = ['first message', 'second message'];
for (const [i, text] of messages.entries()) {
  appendSessionLog(TAG, MACHINE_ID, {
    id: `env-${i}`,
    localId: `env-${i}`,
    dir: 'out',
    at: 1_700_000_000_000 + i,
    c: encodeBase64(encrypt(SESSION_KEY, 'dataKey', { role: 'session', content: { id: `env-${i}`, ev: { t: 'text', text } } })),
  });
}

// ── Serve it, wrapping the content key exactly as api.ts does when creating a session.
const server = await startLanServer({
  secret: MACHINE_KEY,
  machineId: MACHINE_ID,
  accountFingerprint: accountFingerprintOf(appContentKeyPair.publicKey),
  getSessions: () => [],
  getHistory: (sessionId) => {
    if (sessionId !== 'e2e-session') {
      return null;
    }
    const wrapped = libsodiumEncryptForPublicKey(SESSION_KEY, appContentKeyPair.publicKey);
    const dataEncryptionKey = new Uint8Array(wrapped.length + 1);
    dataEncryptionKey.set([0], 0); // version byte, matching api.ts
    dataEncryptionKey.set(wrapped, 1);
    return { tag: TAG, dataEncryptionKey: encodeBase64(dataEncryptionKey), entries: readSessionLog(TAG, MACHINE_ID) };
  },
  host: '127.0.0.1',
  port: 0,
});

const base = `http://127.0.0.1:${server.port}`;
const post = (path: string, body?: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

console.log(`LAN server on port ${server.port}\n`);

const unauth = await fetch(`${base}/lan/sessions`);
console.log(`no token           -> ${unauth.status} ${unauth.status === 401 ? '✅' : '❌ expected 401'}`);

const { nonce } = (await (await post('/lan/challenge')).json()) as { nonce: string };
const badProof = await post('/lan/session', { nonce, proof: 'wrong' });
console.log(`wrong proof        -> ${badProof.status} ${badProof.status === 401 ? '✅' : '❌ expected 401'}`);
const replay = await post('/lan/session', { nonce, proof: lanProofFor(MACHINE_KEY, nonce) });
console.log(`replayed nonce     -> ${replay.status} ${replay.status === 401 ? '✅ (nonce consumed)' : '❌ expected 401'}`);

const nonce2 = ((await (await post('/lan/challenge')).json()) as { nonce: string }).nonce;
const ok = await post('/lan/session', { nonce: nonce2, proof: lanProofFor(MACHINE_KEY, nonce2) });
const { token } = (await ok.json()) as { token: string };
console.log(`valid proof        -> ${ok.status} ${ok.status === 200 ? '✅ token issued' : '❌ expected 200'}`);

const mutation = await post('/lan/spawn-session', {}, token);
console.log(`mutation route     -> ${mutation.status} ${mutation.status === 404 ? '✅ (does not exist)' : '❌ expected 404'}`);

const missing = await fetch(`${base}/lan/sessions/not-a-session/history`, { headers: { authorization: `Bearer ${token}` } });
console.log(`unknown session    -> ${missing.status} ${missing.status === 404 ? '✅ (no local history)' : '❌ expected 404'}`);

// ── The client half: this is the whole of what the app must do.
const historyRes = await fetch(`${base}/lan/sessions/e2e-session/history`, { headers: { authorization: `Bearer ${token}` } });
const history = (await historyRes.json()) as { tag: string; dataEncryptionKey: string; entries: Array<{ c: string }> };
console.log(`fetch history      -> ${historyRes.status}, ${history.entries.length} entr(ies) ${historyRes.status === 200 ? '✅' : '❌'}`);

const bundle = decodeBase64(history.dataEncryptionKey, 'base64');
if (bundle[0] !== 0) {
  throw new Error(`unexpected key bundle version ${bundle[0]}`);
}
const sealed = bundle.slice(1);
const opened = tweetnacl.box.open(
  sealed.slice(56),
  sealed.slice(32, 56),
  sealed.slice(0, 32),
  appContentKeyPair.secretKey,
);
if (!opened) {
  throw new Error('❌ could not unwrap the session key with the account content private key');
}
console.log(`unwrap session key -> ✅ ${opened.length} bytes`);

const decrypted = history.entries.map((e) => {
  const record = decrypt(new Uint8Array(opened), 'dataKey', decodeBase64(e.c)) as { content: { ev: { text: string } } };
  return record.content.ev.text;
});
const matches = JSON.stringify(decrypted) === JSON.stringify(messages);
console.log(`decrypt history    -> ${matches ? '✅' : '❌'} ${JSON.stringify(decrypted)}`);

await server.stop();
rmSync(home, { recursive: true, force: true });

if (!matches) {
  process.exit(1);
}
console.log('\nA client with the machine key and the account private key can read this session\'s');
console.log('history over the LAN, with no server involved.');
