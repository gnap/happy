/**
 * Query a running daemon's LAN API the way a client would, and decrypt what comes back.
 *
 * This proves the *serving* half: that the daemon hands out the same ciphertext the session
 * process wrote. It decrypts with the session key persisted in `~/.happy/session-key-*`,
 * which is the plaintext the app effectively obtains after unwrapping the `dataEncryptionKey`
 * the response also carries.
 *
 * It deliberately does NOT verify the wrapping: the response's `dataEncryptionKey` is sealed
 * to the account's content public key, whose private half exists only on the app. That path is
 * covered by `scripts/lan-e2e.ts`, which plays the app with its own keypair.
 *
 *   npx tsx scripts/lan-query.ts                    # list what the daemon sees
 *   npx tsx scripts/lan-query.ts <sessionId>        # fetch and decrypt that session
 *   npx tsx scripts/lan-query.ts <sessionId> --port 55673 --host 192.168.31.75
 */

import { decodeBase64, decrypt } from '@/api/encryption';
import { readCredentials } from '@/persistence';
import { readSessionKey } from '@/api/sessionKeyPersistence';
import { lanProofFor } from '@/daemon/lanServer';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
// Anything that is not a flag and does not follow one is the session id.
const positional: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith('--')) {
    i += 1;
    continue;
  }
  positional.push(args[i]);
}
const sessionId = positional[0];
const host = flag('host', '127.0.0.1');
const port = flag('port', '55673');
const base = `http://${host}:${port}`;

const die = (message: string): never => {
  console.error(`❌ ${message}`);
  process.exit(1);
};

const credentials = await readCredentials();
if (!credentials) {
  die('no credentials in ~/.happy/access.key -- run `happy` and authenticate first');
}
if (credentials.encryption.type !== 'dataKey') {
  die('these credentials are legacy; the LAN API only starts for dataKey accounts');
}
const machineKey = credentials.encryption.machineKey;

// ── Authenticate: prove possession of the machine key.
let nonce: string;
try {
  const res = await fetch(`${base}/lan/challenge`, { method: 'POST' });
  if (!res.ok) {
    die(`challenge failed with ${res.status} -- is the daemon running with HAPPY_LAN_ENABLED=1?`);
  }
  nonce = ((await res.json()) as { nonce: string }).nonce;
} catch (error) {
  die(`cannot reach ${base} (${String(error)}) -- is the daemon running with HAPPY_LAN_ENABLED=1?`);
}

const redeemRes = await fetch(`${base}/lan/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ nonce, proof: lanProofFor(machineKey, nonce) }),
});
if (!redeemRes.ok) {
  die(`proof rejected with ${redeemRes.status} -- machine key mismatch?`);
}
const { token } = (await redeemRes.json()) as { token: string };
const auth = { headers: { authorization: `Bearer ${token}` } };
console.log(`authenticated against ${base} ✅\n`);

// ── No session id: show what the daemon can see, so one can be picked.
if (!sessionId) {
  const identity = (await (await fetch(`${base}/lan/identity`, auth)).json()) as {
    machineId: string;
    accountFingerprint: string;
  };
  const { sessions } = (await (await fetch(`${base}/lan/sessions`, auth)).json()) as {
    sessions: Array<{ happySessionId: string; directory: string; agent: string; isAlive: boolean }>;
  };
  console.log(`machine ${identity.machineId}  fingerprint ${identity.accountFingerprint}`);
  console.log(`${sessions.length} session(s):\n`);
  for (const s of sessions) {
    const probe = await fetch(`${base}/lan/sessions/${s.happySessionId}/history`, auth);
    console.log(`  ${s.happySessionId}  ${probe.ok ? 'has local history ✅' : 'no history'}  ${s.directory}`);
  }
  console.log('\nPass a session id to fetch and decrypt its history.');
  process.exit(0);
}

// ── Fetch and decrypt.
const res = await fetch(`${base}/lan/sessions/${sessionId}/history`, auth);
if (res.status === 404) {
  die(`daemon has no local history for ${sessionId}`);
}
if (!res.ok) {
  die(`history request failed with ${res.status}`);
}
const history = (await res.json()) as {
  tag: string;
  dataEncryptionKey: string;
  entries: Array<{ id: string; dir: string; at: number; c: string }>;
};

console.log(`tag       ${history.tag}`);
console.log(`entries   ${history.entries.length}`);
console.log(`wrapped   ${history.dataEncryptionKey.length} bytes (only the account holder can unwrap)`);

// The plaintext session key the session process persisted; what the app ends up with after
// unwrapping the blob above.
const sessionKey = readSessionKey(history.tag);
if (!sessionKey) {
  die(`no local session key for tag ${history.tag} -- the history cannot be decrypted here`);
}

let decrypted = 0;
const previews: string[] = [];
for (const entry of history.entries) {
  const record = decrypt(sessionKey, 'dataKey', decodeBase64(entry.c)) as
    | { content?: { ev?: { t?: string; text?: string }; type?: string } }
    | null;
  if (record === null) {
    continue;
  }
  decrypted += 1;
  const ev = record.content?.ev;
  if (previews.length < 5) {
    const label = ev?.t ?? record.content?.type ?? '?';
    const text = ev?.text ? ` ${String(ev.text).slice(0, 60)}` : '';
    previews.push(`  [${entry.dir}] ${label}${text}`);
  }
}

console.log(`decrypted ${decrypted}/${history.entries.length} ${decrypted === history.entries.length ? '✅' : '⚠️ some entries did not decrypt'}`);
console.log('\nfirst entries:');
console.log(previews.join('\n'));
