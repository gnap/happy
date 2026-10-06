/**
 * Manual end-to-end check for the LAN API, without touching a running daemon.
 *
 * Starts the read-only LAN server + mDNS advertisement in-process, then drives the full
 * client flow against it (challenge -> proof -> token -> read) and asserts the negative
 * cases. Run it, then verify discovery separately with `dns-sd -B _happy._tcp local`.
 *
 *   npx tsx scripts/lan-e2e.ts
 */

import { startLanServer, lanProofFor, accountFingerprintOf } from '@/daemon/lanServer';
import { startLanDiscovery } from '@/daemon/lanDiscovery';

const SECRET = new Uint8Array(32).map((_, i) => i + 1);
const MACHINE_ID = 'e2e-machine';

const server = await startLanServer({
  secret: SECRET,
  machineId: MACHINE_ID,
  accountFingerprint: accountFingerprintOf(SECRET),
  getSessions: () => [
    { happySessionId: 'e2e-session', directory: '/tmp/e2e', agent: 'claude', startedBy: 'daemon', isAlive: true },
  ],
});
const discovery = await startLanDiscovery({
  port: server.port,
  machineId: MACHINE_ID,
  accountFingerprint: accountFingerprintOf(SECRET),
});

const base = `http://127.0.0.1:${server.port}`;
const post = (path: string, body?: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

console.log(`LAN server on port ${server.port}, advertising _happy._tcp.local\n`);

const unauth = await fetch(`${base}/lan/sessions`);
console.log(`no token          -> ${unauth.status} ${unauth.status === 401 ? '✅' : '❌ expected 401'}`);

const { nonce } = (await (await post('/lan/challenge')).json()) as { nonce: string };
const badProof = await post('/lan/session', { nonce, proof: 'wrong' });
console.log(`wrong proof       -> ${badProof.status} ${badProof.status === 401 ? '✅' : '❌ expected 401'}`);
const replay = await post('/lan/session', { nonce, proof: lanProofFor(SECRET, nonce) });
console.log(`replayed nonce    -> ${replay.status} ${replay.status === 401 ? '✅ (nonce consumed)' : '❌ expected 401'}`);

const nonce2 = ((await (await post('/lan/challenge')).json()) as { nonce: string }).nonce;
const ok = await post('/lan/session', { nonce: nonce2, proof: lanProofFor(SECRET, nonce2) });
const { token } = (await ok.json()) as { token: string };
console.log(`valid proof       -> ${ok.status} ${ok.status === 200 ? '✅ token issued' : '❌ expected 200'}`);

const sessions = await fetch(`${base}/lan/sessions`, { headers: { authorization: `Bearer ${token}` } });
const body = (await sessions.json()) as { sessions: unknown[] };
console.log(`authorized read   -> ${sessions.status}, ${body.sessions.length} session(s) ${sessions.status === 200 ? '✅' : '❌'}`);

const mutation = await post('/lan/spawn-session', {}, token);
console.log(`mutation route    -> ${mutation.status} ${mutation.status === 404 ? '✅ (does not exist)' : '❌ expected 404'}`);

console.log('\nNow verify discovery in another shell:  dns-sd -B _happy._tcp local');
console.log('Ctrl-C to stop.');

const shutdown = async () => {
  await discovery.stop();
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
