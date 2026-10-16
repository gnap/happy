/**
 * Works out where this machine can be reached on the LAN, and hands it to whoever records it.
 *
 * What is computed here is a fact about this machine, and it is recorded as one — an entry in the
 * machine's own log, which is local, so computing it never depends on a channel being up. Each
 * channel then replays it: a client reads it directly over the LAN, and the server and the relay
 * each get it written to them at their own pace. It used to be published straight to the server
 * while the server socket was up, which made the address exist only in the case where a client has
 * no other way to learn it.
 *
 * Note the exposure is different in kind from the mDNS advertisement next to it. mDNS is
 * LAN-scoped and transient; this is carried to the server, readable by the account's client on
 * any network, and survives the daemon. That is why the filter below is a hard deny-list
 * rather than "publish whatever the OS reports" -- a VPN or VM-bridge address here would leak
 * the machine's topology into a durable, account-wide blob.
 *
 * Deliberately no STUN/reflexive address: without hole punching a published reflexive address
 * is only reachable behind a full-cone NAT, and the keepalive would maintain a mapping that
 * inbound cannot use anyway. That belongs with hole punching.
 */

import os from 'node:os';
import { logger } from '@/ui/logger';

export const ENDPOINT_PROTOCOL_VERSION = 1;
export const PUBLISH_INTERVAL_MS = 20_000;

/** Above this a candidate list costs more in connection attempts than it buys. */
const MAX_IPV4 = 4;
const MAX_IPV6 = 2;

/**
 * Interfaces a client on the LAN can never route to, or must not be told about: Apple's
 * peer-to-peer Wi-Fi, VPN tunnels, and VM/host bridges.
 */
const DENIED_INTERFACE_PREFIXES = ['awdl', 'llw', 'utun', 'tun', 'tap', 'wg', 'bridge', 'docker', 'vmnet', 'vboxnet'];

export type LanEndpoint = {
  /** `lan` for private IPv4, `ipv6` for a globally routable v6 address. */
  t: 'lan' | 'ipv6' | 'relay';
  addr: string;
  port: number;
  /** Relay only: the path segment the relay routes to this machine (`/r/<tag>`). */
  tag?: string;
};

export type EndpointSet = {
  v: number;
  endpoints: LanEndpoint[];
};

/** What actually gets written: the set plus when it was taken. */
export type PublishedEndpoints = EndpointSet & { at: number };

export type EndpointPublisherOptions = {
  /** The port the LAN API is listening on. */
  lanPort: number;
  /**
   * Writes the set down as a fact of this machine, and says whether it landed.
   *
   * Local by contract — an append to this machine's own log — so this is never the reason an address
   * goes unpublished. Whether any given channel has heard about it is that channel's progress, not
   * this function's.
   */
  record: (endpoints: PublishedEndpoints) => boolean;
  /** Extra endpoints appended after the on-link ones (e.g. a registered public relay). */
  extraEndpoints?: () => LanEndpoint[];
  /** Injected for tests, so nothing here touches a real NIC. */
  readInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  now?: () => number;
  intervalMs?: number;
};

export type EndpointPublisherHandle = {
  /** Recompute and publish if needed. Exposed so tests can drive it without timers. */
  tick: () => Promise<boolean>;
  stop: () => void;
};

function isDeniedInterface(name: string): boolean {
  const lower = name.toLowerCase();
  return DENIED_INTERFACE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Unique-local (fc00::/7): usable on-LAN, but ranked below a globally routable address. */
function isUniqueLocalIpv6(address: string): boolean {
  return /^f[cd][0-9a-f]{2}:/i.test(address);
}

/**
 * Pick the addresses worth telling a client about, best first.
 *
 * Ranked: private IPv4 on a physical interface, then globally routable IPv6, then ULA. A
 * globally routable IPv6 address is worth more than it looks -- in networks with native IPv6
 * there is often no NAT at all, so it is directly reachable.
 */
export function computeEndpoints(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
  lanPort: number,
): EndpointSet {
  const ipv4: string[] = [];
  const ipv6Global: string[] = [];
  const ipv6Ula: string[] = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses || isDeniedInterface(name)) {
      continue;
    }
    for (const info of addresses) {
      if (info.internal) {
        continue;
      }
      if (info.family === 'IPv4') {
        // 169.254/16 is APIPA: the machine failed to get a real address.
        if (!info.address.startsWith('169.254.') && isPrivateIpv4(info.address)) {
          ipv4.push(info.address);
        }
      } else if (info.family === 'IPv6') {
        if (/^fe80:/i.test(info.address)) {
          continue; // link-local, meaningless to a client
        }
        (isUniqueLocalIpv6(info.address) ? ipv6Ula : ipv6Global).push(info.address);
      }
    }
  }

  const endpoints: LanEndpoint[] = [
    ...[...new Set(ipv4)].slice(0, MAX_IPV4).map((addr) => ({ t: 'lan' as const, addr, port: lanPort })),
    ...[...new Set([...ipv6Global, ...ipv6Ula])].slice(0, MAX_IPV6).map((addr) => ({ t: 'ipv6' as const, addr, port: lanPort })),
  ];

  return { v: ENDPOINT_PROTOCOL_VERSION, endpoints };
}

export function startEndpointPublisher(opts: EndpointPublisherOptions): EndpointPublisherHandle {
  const readInterfaces = opts.readInterfaces ?? (() => os.networkInterfaces());
  const now = opts.now ?? (() => Date.now());
  const intervalMs = opts.intervalMs ?? PUBLISH_INTERVAL_MS;
  /** Serialized last published set; only a change is worth a write. */
  let lastPublished: string | null = null;
  let stopped = false;

  const tick = async (): Promise<boolean> => {
    if (stopped) {
      return false;
    }
    const base = computeEndpoints(readInterfaces(), opts.lanPort);
    const set = { ...base, endpoints: [...base.endpoints, ...(opts.extraEndpoints?.() ?? [])] };
    const key = JSON.stringify(set);
    if (key === lastPublished) {
      return false;
    }
    // No connectivity gate on purpose. There used to be one — nothing was written unless the server
    // socket was up — and it meant the machine's LAN address was published only while the server was
    // reachable, which is the one case where a client does not need to be told it. The write is now a
    // local append, so it cannot fail for the network being down, and each channel picks it up from
    // where it left off.
    const landed = opts.record({ ...set, at: now() });
    // Only remember it once it landed, so a failed write is retried rather than assumed done.
    if (landed) {
      lastPublished = key;
    }
    return landed;
  };

  const timer = setInterval(() => {
    void tick().catch((error) => logger.debug('[lan] endpoint publish tick failed', { error: String(error) }));
  }, intervalMs);
  timer.unref?.();

  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
