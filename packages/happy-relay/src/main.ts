import { startRelay } from './relay';

const certFile = process.env.RELAY_CERT;
const keyFile = process.env.RELAY_KEY;
const handle = startRelay({
    port: Number(process.env.RELAY_PORT) || 443,
    tls: certFile && keyFile ? { certFile, keyFile } : undefined,
});
console.log(`happy-relay listening on :${handle.port}${certFile ? ' (tls)' : ''}`);
