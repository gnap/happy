import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { notify } = vi.hoisted(() => ({
    notify: vi.fn(async () => ({ status: 'ok' })),
}));

vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonNetworkProxy: notify,
}));

import {
    applyNetworkProxyPolicy,
    captureSpawnProxyEnv,
    resetNetworkProxyPolicy,
    resetSpawnProxyEnvCapture,
    stripNetworkProxyKeys,
} from './networkProxy';
import { configuration } from '@/configuration';

const TOUCHED = [
    'ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
    'NO_PROXY', 'no_proxy', 'HAPPY_LOCAL_PROXY_URL', 'HAPPY_PROXY_VIA_RELAY', 'ANTHROPIC_BASE_URL',
    'HOP_USER', 'HOP_PASS',
];
const LOCAL_URL = 'http://abc123@127.0.0.1:41234';
const HOP = 'socks5h://user:pass@hop.example:1080';

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
    saved = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));
    for (const key of TOUCHED) delete process.env[key];
    notify.mockClear();
});

afterEach(() => {
    resetNetworkProxyPolicy();
    resetSpawnProxyEnvCapture();
    notify.mockClear();
    for (const key of TOUCHED) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
});

describe('applyNetworkProxyPolicy', () => {
    it('replaces the profile hop with the loopback proxy and registers the route', () => {
        process.env.HAPPY_LOCAL_PROXY_URL = LOCAL_URL;

        const policy = applyNetworkProxyPolicy({
            ALL_PROXY: HOP,
            ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        }, { label: 'session-1' });

        expect(policy.env).toEqual({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' });
        expect(process.env.ALL_PROXY).toBe(LOCAL_URL);
        expect(process.env.HTTPS_PROXY).toBe(LOCAL_URL);
        expect(process.env.HTTP_PROXY).toBe(LOCAL_URL);
        expect(process.env.NO_PROXY?.split(',')).toEqual(
            expect.arrayContaining(['localhost', '127.0.0.1', '::1']),
        );
        // The model host is not excused: a profile that names a route means the API traffic too.
        expect(process.env.NO_PROXY).not.toContain('api.deepseek.com');
        // The session's own server calls share this environment; they must not be sent to the
        // loopback proxy, which only accepts CONNECT and would answer 400.
        expect(process.env.NO_PROXY?.split(',')).toContain(new URL(configuration.serverUrl).hostname);
        expect(policy.registration).toEqual({
            token: 'abc123',
            socks5: HOP,
            viaRelay: false,
            label: 'session-1',
        });
        expect(notify).toHaveBeenCalledWith('abc123', policy.registration);
    });

    it('keeps a spawn-time socks hop out of the environment but still routes to it', () => {
        process.env.HAPPY_LOCAL_PROXY_URL = LOCAL_URL;
        process.env.ALL_PROXY = HOP;
        process.env.HTTPS_PROXY = 'http://corp.example:8080';

        captureSpawnProxyEnv();

        // The CLI's own HTTP clients must never see a socks URL: axios cannot speak SOCKS5 and
        // aborts the request with "protocol mismatch" before a session can be created.
        expect(process.env.ALL_PROXY).toBeUndefined();
        // An ordinary HTTP proxy is one this process can use; it is not the agent's hop.
        expect(process.env.HTTPS_PROXY).toBe('http://corp.example:8080');

        const policy = applyNetworkProxyPolicy({}, { label: 'spawned' });

        expect(policy.registration).toEqual({ token: 'abc123', socks5: HOP, viaRelay: false, label: 'spawned' });
        expect(process.env.ALL_PROXY).toBe(LOCAL_URL);
        expect(process.env.HTTPS_PROXY).toBe(LOCAL_URL);
    });

    it('expands a hop the profile names by reference before registering it', () => {
        process.env.HAPPY_LOCAL_PROXY_URL = LOCAL_URL;
        process.env.HOP_USER = 'user';
        process.env.HOP_PASS = 'pass';

        const policy = applyNetworkProxyPolicy({
            ALL_PROXY: 'socks5h://${HOP_USER}:${HOP_PASS}@hop.example:1080',
        });

        expect(policy.registration?.socks5).toBe(HOP);
    });

    it('fails closed when no daemon minted a loopback proxy', () => {
        const policy = applyNetworkProxyPolicy({ ALL_PROXY: HOP });

        expect(policy.env).toEqual({});
        expect(policy.registration).toBeNull();
        expect(process.env.ALL_PROXY).toBeUndefined();
        expect(notify).not.toHaveBeenCalled();
    });

    it('leaves a profile without a hop exactly as it was', () => {
        const env = { HTTP_PROXY: 'http://corp.example:3128' };
        const policy = applyNetworkProxyPolicy(env);

        expect(policy.env).toEqual(env);
        expect(policy.registration).toBeNull();
        expect(process.env.HTTP_PROXY).toBeUndefined();
    });

    it('routes through the relay when the profile names no hop at all', () => {
        process.env.HAPPY_LOCAL_PROXY_URL = LOCAL_URL;
        process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';

        const policy = applyNetworkProxyPolicy({ ANTHROPIC_MODEL: 'x' }, { viaRelay: true });

        expect(policy.registration).toEqual({ token: 'abc123', viaRelay: true });
        expect(policy.env).toEqual({ ANTHROPIC_MODEL: 'x' });
        expect(process.env.ALL_PROXY).toBe(LOCAL_URL);
        // With the relay chosen, the API host is not excused from the route.
        expect(process.env.NO_PROXY?.split(',')).toEqual(
            expect.arrayContaining(['localhost', '127.0.0.1', '::1']),
        );
        expect(process.env.NO_PROXY).not.toContain('api.deepseek.com');
    });

    it('honours an explicit relay choice and the spawn-time opt-in', () => {
        process.env.HAPPY_LOCAL_PROXY_URL = LOCAL_URL;

        expect(applyNetworkProxyPolicy({ ALL_PROXY: HOP }, { viaRelay: true }).registration?.viaRelay).toBe(true);
        resetNetworkProxyPolicy();

        process.env.HAPPY_PROXY_VIA_RELAY = '1';
        expect(applyNetworkProxyPolicy({ ALL_PROXY: HOP }).registration?.viaRelay).toBe(true);
        resetNetworkProxyPolicy();

        process.env.HAPPY_PROXY_VIA_RELAY = '0';
        expect(applyNetworkProxyPolicy({ ALL_PROXY: HOP }).registration?.viaRelay).toBe(false);
    });

    it('restores the previous proxy and clears the route when the hop goes away', () => {
        process.env.HTTP_PROXY = 'http://baseline.example:8080';
        process.env.HAPPY_LOCAL_PROXY_URL = LOCAL_URL;

        applyNetworkProxyPolicy({ ALL_PROXY: HOP });
        expect(process.env.HTTP_PROXY).toBe(LOCAL_URL);

        applyNetworkProxyPolicy({ ANTHROPIC_MODEL: 'x' });
        expect(process.env.HTTP_PROXY).toBe('http://baseline.example:8080');
        expect(notify).toHaveBeenLastCalledWith('abc123', null);
    });

    it('does not restore a hop it captured from the spawn environment', () => {
        process.env.ALL_PROXY = HOP;
        process.env.HAPPY_LOCAL_PROXY_URL = LOCAL_URL;

        applyNetworkProxyPolicy({});
        expect(process.env.ALL_PROXY).toBe(LOCAL_URL);

        resetNetworkProxyPolicy();
        expect(process.env.ALL_PROXY).toBeUndefined();
    });
});

describe('stripNetworkProxyKeys', () => {
    it('removes every spelling of a proxy key without touching the rest', () => {
        expect(stripNetworkProxyKeys({
            HTTP_PROXY: 'a', all_proxy: 'b', HTTPS_PROXY: 'c', ANTHROPIC_MODEL: 'm',
        })).toEqual({ ANTHROPIC_MODEL: 'm' });
    });
});
