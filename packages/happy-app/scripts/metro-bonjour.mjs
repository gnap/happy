#!/usr/bin/env node
/**
 * Keeps Metro's `_expo._tcp` service on the network, over IPv4.
 *
 * Expo announces Bonjour once, through a raw mDNS socket of its own. On this machine that announce
 * has gone missing while Metro kept running (long uptime, WiFi sleeps, interface changes), and the
 * library it uses then failed to bring the service back: "mDNS unavailable on interface en1". The
 * dev client found no Metro at all while the URL and QR code still worked.
 *
 * This registers the same service through mDNSResponder (`dns-sd`), which owns the multicast and
 * survives interface changes without a socket of its own. It is a *proxy* registration (`-P`):
 * the service points at an explicit host and IPv4 address instead of the machine's own host name.
 * That matters on a dual-stack Mac — the system host publishes AAAA records too, the dev client
 * picked an IPv6 address from them, and opening that server crashed it. This advertises A only.
 *
 * Run it beside `expo start`:
 *
 *     node scripts/metro-bonjour.mjs 8081
 *
 * The TXT record is the one Expo publishes — the dev client filters on it, not just the name.
 */

import { getConfig } from '@expo/config';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import os from 'node:os';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? process.env.METRO_PORT ?? 8081);
if (!Number.isInteger(port) || port <= 0) {
    console.error(`[bonjour] invalid port: ${process.argv[2] ?? process.env.METRO_PORT}`);
    process.exit(1);
}

const { exp } = getConfig(projectRoot, { skipSDKVersionRequirement: true });
const name = String(exp.name ?? 'Expo');
// A fresh instance and host per this IPv4-only registration: the names the dual-stack
// announce used still have AAAA records cached on devices that saw them, and reusing either
// hands the dev client an IPv6 URL again — which expo-dev-launcher's network inspector turns
// into a fatal URL parse (no brackets around the host).
const instanceName = `${name} v4`;
const hostname = `${exp.slug ? String(exp.slug) : os.hostname().replace(/\.local\.?$/, '')}-v4.local`;
const txt = [
    `name=${name}`,
    exp.slug ? `slug=${String(exp.slug)}` : null,
    exp.android?.package ? `androidPackage=${String(exp.android.package)}` : null,
    exp.ios?.bundleIdentifier ? `iosBundleIdentifier=${String(exp.ios.bundleIdentifier)}` : null,
].filter((entry) => entry !== null);

/**
 * The address this Mac's traffic leaves by, which is the one a device on this network can reach.
 *
 * Read from the routing table rather than from the interface list: the first WiFi-looking address
 * is not necessarily the one carrying the default route (a second interface, a VPN, a direct
 * link), and advertising the wrong one is a dev server that resolves and never answers.
 */
function primaryIPv4() {
    try {
        const route = execFileSync('route', ['-n', 'get', 'default'], { encoding: 'utf8' });
        const iface = /interface:\s*(\S+)/.exec(route)?.[1];
        if (iface) {
            const address = execFileSync('ipconfig', ['getifaddr', iface], { encoding: 'utf8' }).trim();
            if (address) {
                return address;
            }
        }
    } catch {
        // Fall through to the interface list.
    }
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === 'IPv4' && !address.internal) {
                return address.address;
            }
        }
    }
    return null;
}

let child = null;
let advertisedIp = null;
let stopping = false;

function start() {
    if (stopping) {
        return;
    }
    const ip = primaryIPv4();
    if (!ip) {
        console.error('[bonjour] no IPv4 address to advertise; retrying in 5s');
        setTimeout(start, 5_000);
        return;
    }
    advertisedIp = ip;
    // `-P` publishes a proxy host record for `hostname` with exactly this address — one A record,
    // no AAAA — and holds both the host and the service for as long as the process runs.
    child = spawn('dns-sd', ['-P', instanceName, '_expo._tcp', 'local', String(port), hostname, ip, ...txt], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => process.stdout.write(data));
    child.stderr.on('data', (data) => process.stderr.write(data));
    console.log(`[bonjour] registering ${instanceName} on ${hostname}:${port} as ${ip}`);
    child.on('exit', (code, signal) => {
        child = null;
        if (stopping) {
            return;
        }
        console.error(`[bonjour] dns-sd exited (code=${code ?? 'none'} signal=${signal ?? 'none'}); restarting`);
        setTimeout(start, 2_000);
    });
    child.on('error', (error) => {
        console.error('[bonjour] could not start dns-sd:', error);
    });
}

// A DHCP lease that changes under a running proxy would leave the record pointing at an address
// this Mac no longer has. Watching the route is cheap; re-registering is how it follows.
setInterval(() => {
    const ip = primaryIPv4();
    if (ip && ip !== advertisedIp && child) {
        console.log(`[bonjour] address changed to ${ip}; re-registering`);
        child.kill('SIGTERM');
    }
}, 30_000);

function shutdown() {
    stopping = true;
    child?.kill('SIGTERM');
    process.exit(0);
}

start();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
