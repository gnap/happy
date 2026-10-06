/**
 * mDNS advertisement for the LAN API.
 *
 * Uses `@homebridge/ciao` rather than `bonjour-service`/`multicast-dns`, which was measured
 * unusable on macOS: it cannot send multicast without pinning an interface (which then
 * collides with the system responder on 5353) and it cannot receive 5353 multicast at all,
 * so its service was invisible to the native Bonjour stack. ciao handles multi-homed
 * machines correctly, which matters because dev machines routinely have many interfaces
 * plus a VPN. See `docs/p2p-roadmap.md` §10 for the measurements.
 *
 * The TXT record carries identity only. The session list is deliberately excluded: TXT is
 * bounded by RFC 6763, and a list that changes on every spawn/stop would mean re-announcing
 * constantly, turning session churn into multicast churn on the whole network.
 */

import { getResponder } from '@homebridge/ciao';
import { logger } from '@/ui/logger';
import { LAN_PROTOCOL_VERSION } from './lanServer';

export const LAN_SERVICE_TYPE = 'happy';

export type LanDiscoveryOptions = {
  /** The port the LAN server actually bound; published via the SRV record. */
  port: number;
  machineId: string;
  /** Lets a client filter for its own account without probing every advertised machine. */
  accountFingerprint: string;
};

export type LanDiscoveryHandle = {
  stop: () => Promise<void>;
};

export async function startLanDiscovery(opts: LanDiscoveryOptions): Promise<LanDiscoveryHandle> {
  const responder = getResponder();
  const service = responder.createService({
    name: `happy-${opts.machineId}`,
    type: LAN_SERVICE_TYPE,
    port: opts.port,
    txt: {
      v: String(LAN_PROTOCOL_VERSION),
      machineId: opts.machineId,
      accountFingerprint: opts.accountFingerprint,
    },
  });

  await service.advertise();
  logger.debug(`[lan] advertising _${LAN_SERVICE_TYPE}._tcp.local on port ${opts.port}`);

  return {
    stop: async () => {
      try {
        await service.end();
        await responder.shutdown();
      } catch (error) {
        logger.warn('[lan] failed to withdraw mDNS advertisement', { error: String(error) });
      }
    },
  };
}
