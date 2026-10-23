/**
 * The routing table is what tells a direct-attach link apart from the network this machine is
 * actually on, so these pin the parsing against the real file formats -- and pin the fail-open
 * behaviour, which is the part that must not regress: an unreadable table publishes what the daemon
 * always published, it does not publish nothing.
 */

import { describe, expect, it, vi } from 'vitest';
import {
    cachedDefaultRouteInterfaces,
    parseProcNetIpv6Route,
    parseProcNetRoute,
    parseRouteGetOutput,
    readDefaultRouteInterfaces,
    type RouteTableDeps,
} from './lanRoutes';

/** `/proc/net/route` on the host this was written for: a direct-attach port and a real LAN. */
const PROC_ROUTE = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'enP7s7\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FCFFFF\t0\t0\t0',
    'wlP9s9\t00000000\tFE07A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    'wlP9s9\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FCFFFF\t0\t0\t0',
    'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    '',
].join('\n');

const PROC_IPV6_ROUTE = [
    '00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 00000400 00000001 00000000 00000003 wlP9s9',
    'fe800000000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000400 00000001 00000000 00000003 wlP9s9',
    '00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003 wlP9s9',
].join('\n');

const ROUTE_GET = [
    '   route to: default',
    'destination: default',
    '       mask: default',
    '    gateway: 192.168.11.254',
    '  interface: en0',
    '      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>',
].join('\n');

function deps(over: Partial<RouteTableDeps> = {}): RouteTableDeps {
    return {
        platform: 'linux',
        readFile: () => { throw new Error('no such file'); },
        run: () => null,
        ...over,
    };
}

describe('parseProcNetRoute', () => {
    it('takes the interface with the default route, and only that one', () => {
        // `enP7s7` appears in the table, but with its own network as the destination: it is an
        // interface this machine has an address on, not one its traffic leaves by. That address is
        // private by every definition and reachable by exactly one other machine, which is why a
        // name deny-list could never have caught it.
        expect([...parseProcNetRoute(PROC_ROUTE)]).toEqual(['wlP9s9']);
    });

    it('accepts an on-link default, because refusing one costs the host its LAN', () => {
        const onLink = [
            'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask',
            'ppp0\t00000000\t00000000\t0001\t0\t0\t0\t00000000',
        ].join('\n');
        expect([...parseProcNetRoute(onLink)]).toEqual(['ppp0']);
    });

    it('ignores the header and anything too short to be a route', () => {
        expect([...parseProcNetRoute('Iface\tDestination\nwlP9s9\t00000000\n')]).toEqual([]);
    });
});

describe('parseProcNetIpv6Route', () => {
    it('takes the interface with the v6 default route', () => {
        expect([...parseProcNetIpv6Route(PROC_IPV6_ROUTE)]).toEqual(['wlP9s9']);
    });
});

describe('parseRouteGetOutput', () => {
    it('reads the interface macOS reports for the default route', () => {
        expect(parseRouteGetOutput(ROUTE_GET)).toBe('en0');
        expect(parseRouteGetOutput('route: writing to routing socket: not in table')).toBeNull();
    });
});

describe('readDefaultRouteInterfaces', () => {
    it('unions the v4 and v6 tables, because a v6-only host still has a network', () => {
        const read = readDefaultRouteInterfaces(deps({
            readFile: (path) => {
                if (path === '/proc/net/route') return PROC_ROUTE;
                if (path === '/proc/net/ipv6_route') return PROC_IPV6_ROUTE;
                throw new Error('no such file');
            },
        }));
        expect([...(read ?? [])]).toEqual(['wlP9s9']);
    });

    it('answers from the v4 table alone when the v6 one cannot be read', () => {
        const read = readDefaultRouteInterfaces(deps({ readFile: (path) => {
            if (path === '/proc/net/route') return PROC_ROUTE;
            throw new Error('no such file');
        } }));
        expect([...(read ?? [])]).toEqual(['wlP9s9']);
    });

    it('answers nothing knowable when the table itself cannot be read', () => {
        // Null is not an empty set: the caller publishes everything rather than nothing.
        expect(readDefaultRouteInterfaces(deps())).toBeNull();
    });

    it('reads macOS through `route`, and gives up rather than guessing', () => {
        const run = vi.fn((_command: string, args: string[]) => (args[2] === '-inet' ? ROUTE_GET : null));
        expect([...(readDefaultRouteInterfaces(deps({ platform: 'darwin', run })) ?? [])]).toEqual(['en0']);
        expect(readDefaultRouteInterfaces(deps({ platform: 'darwin', run: () => null }))).toBeNull();
    });

    it('says "no idea" on a platform it has no reader for', () => {
        expect(readDefaultRouteInterfaces(deps({ platform: 'win32' }))).toBeNull();
    });
});

describe('cachedDefaultRouteInterfaces', () => {
    it('asks once, and asks again when the answer is old enough to have changed', () => {
        const read = vi.fn(() => new Set(['wlP9s9']));
        let now = 1_000;
        const cached = cachedDefaultRouteInterfaces(read, () => now, 15_000);

        expect([...(cached() ?? [])]).toEqual(['wlP9s9']);
        now += 14_000;
        cached();
        expect(read).toHaveBeenCalledTimes(1);

        // A laptop that moves networks is the case the cache must not hide.
        now += 2_000;
        cached();
        expect(read).toHaveBeenCalledTimes(2);
    });
});
