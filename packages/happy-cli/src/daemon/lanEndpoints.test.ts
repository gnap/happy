/**
 * What is computed here is a fact about this machine, and it is recorded locally — so the filter
 * matters for a different reason than it used to: the set is carried to the server and to the
 * relay, readable account-wide, and a VPN or bridge address would leak topology into something
 * durable. Every wrong address also costs a connection attempt on the client. Tests inject a
 * synthetic interface table rather than reading a real NIC.
 */

import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { computeEndpoints, startEndpointPublisher, type LanEndpoint, type PublishedEndpoints } from './lanEndpoints';

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
    record: (e: PublishedEndpoints) => boolean;
    extraEndpoints?: () => LanEndpoint[];
  }) {
    return startEndpointPublisher({
      lanPort: LAN_PORT,
      readInterfaces: opts.readInterfaces,
      record: opts.record,
      extraEndpoints: opts.extraEndpoints,
      now: () => 1_700_000_000_000,
    });
  }

  it('publishes on the first tick and then stays quiet while the address set is unchanged', async () => {
    const record = vi.fn((_e: PublishedEndpoints) => true);
    const p = publisher({ readInterfaces: () => setA, record });

    expect(await p.tick()).toBe(true);
    expect(await p.tick()).toBe(false);
    expect(await p.tick()).toBe(false);

    // Quiet means quiet: one call, not one per tick.
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls.map((c) => c[0].endpoints)).toEqual([[{ t: 'lan', addr: '192.168.1.5', port: LAN_PORT }]]);
    p.stop();
  });

  it('re-publishes when the address set changes', async () => {
    let current = setA;
    const record = vi.fn((_e: PublishedEndpoints) => true);
    const p = publisher({ readInterfaces: () => current, record });

    await p.tick();
    current = setB;
    expect(await p.tick()).toBe(true);

    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls.map((c) => c[0].endpoints)[1]).toEqual([{ t: 'lan', addr: '192.168.1.99', port: LAN_PORT }]);
    p.stop();
  });

  it('records whether or not there is a server to hear about it', async () => {
    // There used to be a connectivity gate here — nothing written unless the server socket was up —
    // and its effect was that the address existed only while the server was reachable, which is the
    // one case where a client has another way to learn it. Recording is local now, so there is
    // nothing to gate on.
    const record = vi.fn((_e: PublishedEndpoints) => true);
    const p = publisher({ readInterfaces: () => setA, record });

    expect(await p.tick()).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('retries a write that did not land on the next tick instead of assuming it did', async () => {
    // A log that could not be appended to (a full disk, a permission it lost) must not be recorded
    // as done, or the address would never be written down.
    const record = vi.fn((_e: PublishedEndpoints) => false);
    const p = publisher({ readInterfaces: () => setA, record });

    expect(await p.tick()).toBe(false);
    expect(await p.tick()).toBe(false);
    expect(record).toHaveBeenCalledTimes(2);

    record.mockReturnValue(true);
    expect(await p.tick()).toBe(true);
    expect(await p.tick()).toBe(false); // now recorded, so quiet again
    p.stop();
  });

  it('stops ticking after stop()', async () => {
    const record = vi.fn((_e: PublishedEndpoints) => true);
    const p = publisher({ readInterfaces: () => setA, record });
    p.stop();

    expect(await p.tick()).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('appends relay endpoints after the on-link ones and republishes when one appears', async () => {
    const record = vi.fn((_e: PublishedEndpoints) => true);
    let extra: LanEndpoint[] = [];
    const p = publisher({ readInterfaces: () => setA, record, extraEndpoints: () => extra });

    expect(await p.tick()).toBe(true);
    expect(await p.tick()).toBe(false);

    extra = [{ t: 'relay', addr: '1.2.3.4', port: 443, tag: 'a'.repeat(32) }];
    expect(await p.tick()).toBe(true);
    const last = record.mock.calls.at(-1)![0];
    expect(last.endpoints.at(-1)).toEqual(extra[0]);
    expect(last.endpoints[0].t).toBe('lan');
    p.stop();
  });
});
