/**
 * The endpoints published here land in a server-stored blob that outlives the daemon and is
 * readable account-wide, so the filter matters: a VPN or bridge address would leak topology
 * into something durable, and every wrong address costs a connection attempt on the client.
 * Tests inject a synthetic interface table rather than reading a real NIC.
 */

import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { computeEndpoints, startEndpointPublisher, type PublishedEndpoints } from './lanEndpoints';

const LAN_PORT = 55673;

function interfaces(entries: Record<string, Array<[string, 'IPv4' | 'IPv6']>>, opts: { internal?: string[] } = {}) {
  const out: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {};
  for (const [name, addrs] of Object.entries(entries)) {
    out[name] = addrs.map(([address, family]) => ({
      address,
      netmask: '',
      family,
      mac: '00:00:00:00:00:00',
      internal: (opts.internal ?? []).includes(name),
      cidr: null,
      scopeid: 0,
    })) as os.NetworkInterfaceInfo[];
  }
  return out;
}

describe('computeEndpoints', () => {
  it('drops loopback, APIPA, VPN and bridge interfaces, ranking LAN before IPv6', () => {
    const set = computeEndpoints(
      interfaces(
        {
          lo0: [['127.0.0.1', 'IPv4']],
          en0: [['192.168.1.5', 'IPv4']],
          en1: [['169.254.1.1', 'IPv4']], // APIPA: no real address was obtained
          awdl0: [['169.254.2.2', 'IPv4']], // Apple peer-to-peer, unroutable from a phone
          utun3: [['10.8.0.2', 'IPv4']], // VPN
          bridge100: [['192.168.64.1', 'IPv4']], // VM bridge
          en2: [['2408:8207::1', 'IPv6']],
          en3: [['fd00::1', 'IPv6']], // unique-local, ranked last
          en4: [['fe80::1', 'IPv6']], // link-local, meaningless to a client
        },
        { internal: ['lo0'] },
      ),
      LAN_PORT,
    );

    expect(set.endpoints).toEqual([
      { t: 'lan', addr: '192.168.1.5', port: LAN_PORT },
      { t: 'ipv6', addr: '2408:8207::1', port: LAN_PORT },
      { t: 'ipv6', addr: 'fd00::1', port: LAN_PORT },
    ]);
  });

  it('caps the candidate list', () => {
    const many = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`en${i}`, [[`10.0.${i}.1`, 'IPv4'] as [string, 'IPv4']]]),
    );
    const set = computeEndpoints(interfaces(many), LAN_PORT);
    expect(set.endpoints).toHaveLength(4);
  });
});

describe('startEndpointPublisher', () => {
  const setA = interfaces({ en0: [['192.168.1.5', 'IPv4']] });
  const setB = interfaces({ en0: [['192.168.1.99', 'IPv4']] });

  function publisher(opts: {
    readInterfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    publish: (e: PublishedEndpoints) => Promise<boolean>;
    isConnected?: () => boolean;
  }) {
    return startEndpointPublisher({
      lanPort: LAN_PORT,
      readInterfaces: opts.readInterfaces,
      publish: opts.publish,
      isConnected: opts.isConnected ?? (() => true),
      now: () => 1_700_000_000_000,
    });
  }

  it('publishes on the first tick and then stays quiet while the address set is unchanged', async () => {
    const publish = vi.fn(async (_e: PublishedEndpoints) => true);
    const p = publisher({ readInterfaces: () => setA, publish });

    expect(await p.tick()).toBe(true);
    expect(await p.tick()).toBe(false);
    expect(await p.tick()).toBe(false);

    // Quiet means quiet: one call, not one per tick.
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls.map((c) => c[0].endpoints)).toEqual([[{ t: 'lan', addr: '192.168.1.5', port: LAN_PORT }]]);
    p.stop();
  });

  it('re-publishes when the address set changes', async () => {
    let current = setA;
    const publish = vi.fn(async (_e: PublishedEndpoints) => true);
    const p = publisher({ readInterfaces: () => current, publish });

    await p.tick();
    current = setB;
    expect(await p.tick()).toBe(true);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.map((c) => c[0].endpoints)[1]).toEqual([{ t: 'lan', addr: '192.168.1.99', port: LAN_PORT }]);
    p.stop();
  });

  it('does not write while disconnected, and retries once connected', async () => {
    let connected = false;
    const publish = vi.fn(async (_e: PublishedEndpoints) => true);
    const p = publisher({ readInterfaces: () => setA, publish, isConnected: () => connected });

    expect(await p.tick()).toBe(false);
    expect(publish).not.toHaveBeenCalled();

    connected = true;
    expect(await p.tick()).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('retries a failed write on the next tick instead of assuming it landed', async () => {
    // An OCC conflict resolves to false inside tryUpdateDaemonState; the publisher must not
    // treat that as delivered, or the endpoint would never be published.
    const publish = vi.fn(async (_e: PublishedEndpoints) => false);
    const p = publisher({ readInterfaces: () => setA, publish });

    expect(await p.tick()).toBe(false);
    expect(await p.tick()).toBe(false);
    expect(publish).toHaveBeenCalledTimes(2);

    publish.mockResolvedValue(true);
    expect(await p.tick()).toBe(true);
    expect(await p.tick()).toBe(false); // now recorded, so quiet again
    p.stop();
  });

  it('stops ticking after stop()', async () => {
    const publish = vi.fn(async (_e: PublishedEndpoints) => true);
    const p = publisher({ readInterfaces: () => setA, publish });
    p.stop();

    expect(await p.tick()).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });
});
