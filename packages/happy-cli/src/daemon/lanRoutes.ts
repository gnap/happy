/**
 * Which interfaces this machine's traffic actually leaves by.
 *
 * The endpoint publisher enumerated every interface with a private-looking address, and that is not
 * the same question as "where can a client on my network reach me". A machine with a direct-attach
 * link -- a Thunderbolt cable, a point-to-point segment, a lab switch -- has an address on it that
 * looks exactly like a LAN address (`10.99.0.1/24` is private by any definition) and that nothing
 * but the machine at the other end of that link can route to. The interface flags do not tell them
 * apart either: measured on the host this was written for, the direct-attach port and the Wi-Fi port
 * report identical flags, and neither is point-to-point.
 *
 * The one thing that does tell them apart is the routing table: the interface carrying the default
 * route is the one this machine's traffic uses to reach a network, so it is the one a client is
 * most likely to share. Everything else is a link this machine happens to have an address on.
 *
 * **Fail open.** When the table cannot be read -- an unknown platform, a sandbox, a subprocess that
 * will not answer -- this returns null and the caller publishes what it always did. Offering one
 * address too many costs a client a connection attempt; offering none costs it the LAN entirely.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** How long a reading of the table is good for. A route change is rare; the tick is 20s. */
const CACHE_MS = 15_000;
/** A wedged `route`/`netstat` must not hold up the publisher's tick. */
const COMMAND_TIMEOUT_MS = 1_000;

/**
 * The interface carrying the IPv4 default route, from Linux's `/proc/net/route`.
 *
 * Columns are `Iface Destination Gateway Flags RefCnt Use Metric Mask ...`, all hexadecimal and
 * little-endian, so a default route is destination 0 with mask 0.
 *
 * Deliberately not looking at the gateway. `Gateway 00000000` with a zero destination is an on-link
 * default route, which some setups have and which is still this machine's way out -- and the
 * failure directions are not symmetric: accepting a route that is not really a default costs one
 * extra address, while refusing one that is costs the host its LAN channel.
 */
export function parseProcNetRoute(content: string): Set<string> {
  const interfaces = new Set<string>();
  for (const line of content.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 8) {
      continue;
    }
    const [iface, destination, , , , , , mask] = columns;
    if (destination === '00000000' && mask === '00000000') {
      interfaces.add(iface);
    }
  }
  return interfaces;
}

/**
 * The same for IPv6, from `/proc/net/ipv6_route`.
 *
 * Worth reading separately rather than assuming the v4 answer covers it: a host whose only default
 * route is IPv6 is exactly the host whose clients connect over IPv6, and dropping its interface
 * because the v4 table says nothing would take away the channel that works. The fields are
 * destination, destination prefix length, source, source prefix length, next hop, then counters,
 * flags and the interface name last. A default route is an all-zero destination with a zero prefix
 * length, and nothing else about the line is consulted -- see the note above on failing open.
 */
export function parseProcNetIpv6Route(content: string): Set<string> {
  const interfaces = new Set<string>();
  for (const line of content.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 10) {
      continue;
    }
    const [destination, prefixLength] = columns;
    const iface = columns[columns.length - 1];
    if (/^0+$/.test(destination) && prefixLength === '00' && iface.length > 0) {
      interfaces.add(iface);
    }
  }
  return interfaces;
}

/** The interface from macOS's `route -n get -inet[6] default` output. */
export function parseRouteGetOutput(content: string): string | null {
  for (const line of content.split('\n')) {
    const match = /^\s*interface:\s*(\S+)\s*$/.exec(line);
    if (match) {
      return match[1];
    }
  }
  return null;
}

export type RouteTableDeps = {
  platform: NodeJS.Platform;
  readFile: (path: string) => string;
  /** Runs a command and returns its stdout, or null when it could not be run. */
  run: (command: string, args: string[]) => string | null;
};

const defaultDeps = (): RouteTableDeps => ({
  platform: process.platform,
  readFile: (path) => readFileSync(path, 'utf8'),
  run: (command, args) => {
    try {
      return execFileSync(command, args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      // Not installed, not permitted, or too slow: the caller fails open either way.
      return null;
    }
  },
});

/**
 * The interfaces carrying this machine's default routes, or null when that cannot be determined.
 *
 * Null is a distinct answer from an empty set, and the caller depends on the difference: empty
 * means "read the table and none of them is a default route", null means "no idea, publish as
 * before".
 */
export function readDefaultRouteInterfaces(deps: RouteTableDeps = defaultDeps()): Set<string> | null {
  try {
    if (deps.platform === 'linux') {
      const v4 = deps.readFile('/proc/net/route');
      const v6 = tryRead(deps, '/proc/net/ipv6_route');
      const interfaces = parseProcNetRoute(v4);
      for (const name of v6 ? parseProcNetIpv6Route(v6) : []) {
        interfaces.add(name);
      }
      return interfaces;
    }
    if (deps.platform === 'darwin') {
      const interfaces = new Set<string>();
      for (const family of ['-inet', '-inet6']) {
        const output = deps.run('route', ['-n', 'get', family, 'default']);
        const iface = output === null ? null : parseRouteGetOutput(output);
        if (iface) {
          interfaces.add(iface);
        }
      }
      return interfaces.size === 0 ? null : interfaces;
    }
    // Windows and anything else: no reader written, so say so by answering nothing knowable.
    return null;
  } catch {
    return null;
  }
}

function tryRead(deps: RouteTableDeps, path: string): string | null {
  try {
    return deps.readFile(path);
  } catch {
    return null;
  }
}

/**
 * A reader that remembers its last answer for a short while.
 *
 * The publisher ticks every 20s and the value only moves when someone changes the network, so
 * asking the routing table every time would be reading a file to be told the same thing -- and on
 * macOS it would be spawning a process to do it.
 */
export function cachedDefaultRouteInterfaces(
  read: () => Set<string> | null = () => readDefaultRouteInterfaces(),
  now: () => number = () => Date.now(),
  cacheMs: number = CACHE_MS,
): () => Set<string> | null {
  let at = 0;
  let cached: Set<string> | null = null;
  let known = false;
  return () => {
    const current = now();
    if (known && current - at < cacheMs) {
      return cached;
    }
    cached = read();
    at = current;
    known = true;
    return cached;
  };
}
