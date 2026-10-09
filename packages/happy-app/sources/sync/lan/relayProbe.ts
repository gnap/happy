/** A relay that has not answered by now is not going to be useful this tick. */
const PROBE_TIMEOUT_MS = 6_000;

/**
 * Asks a machine's relay route whether its daemon is there.
 *
 * `/lan/challenge` is the one daemon endpoint that needs no credential, and the relay answers 502
 * when the daemon is not registered — so a 200 with a nonce proves the whole chain (relay up,
 * daemon connected, daemon serving) with one request and nothing secret on the wire. It is the
 * relay's counterpart of an mDNS sighting, and like it never involves the Happy server.
 */
export async function probeRelay(baseUrl: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const response = await fetch(`${baseUrl}/lan/challenge`, { method: 'POST', signal: controller.signal });
        if (!response.ok) {
            return false;
        }
        const body = (await response.json()) as { nonce?: unknown };
        return typeof body.nonce === 'string';
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}
