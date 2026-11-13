/**
 * What this machine publishes to the relay's directory.
 *
 * The relay is a hub: it holds every daemon that dialled in and republishes each daemon's own
 * summary, so an App can list a machine's sessions without asking it and without holding a
 * connection to it. What that directory answers is small on purpose — a session is on this machine,
 * and is it running — and the relay already narrows every published row to exactly these fields
 * (`directorySession` in `packages/happy-relay`) before it serves or broadcasts it.
 *
 * The narrowing has to happen *here*, on the sending side, for two reasons:
 *
 * - **What the relay drops, the wire still carried.** The full summary a LAN reader needs carries
 *   the encrypted metadata, the wrapped session key and the server's agent state — hundreds of
 *   kilobytes for a large roster. The relay discarded all of it on arrival while the daemon paid to
 *   send it, every five seconds, on the same connection that carries every request and response of
 *   the relay channel. On a thin uplink that queue delays the answers behind it, and the answers
 *   most sensitive to it are the ones an App cannot proceed without: the challenge and the stream
 *   open.
 * - **Deduplication only works if the content is stable.** The client republishes when the encoded
 *   list differs from the last one it sent. The full summary carries `lastHeartbeat`, which moves
 *   on every session beat, so "unchanged" never happened and a quiet machine still published on
 *   every tick. Nothing in a directory row changes while the machine is idle, so a settled machine
 *   now says nothing at all.
 *
 * An older relay that does not narrow yet is unaffected: it republishes what it is given, and every
 * App that reads the directory reads these fields (and only these) from it.
 */
import type { LanSessionSummary } from '../lanServer';

/** One session as the directory describes it. */
export type DirectorySession = Pick<LanSessionSummary, 'happySessionId' | 'tag' | 'isAlive' | 'origin'>;

/**
 * The directory rows for a roster, dropping everything the relay would not serve.
 *
 * A row with neither name is dropped too: a client addresses sessions by one or the other, so there
 * would be nothing it could ask for. The relay applies the same rule to whatever it is sent.
 */
export function directoryRows(summaries: readonly LanSessionSummary[]): DirectorySession[] {
  const rows: DirectorySession[] = [];
  for (const summary of summaries) {
    if (summary.happySessionId === undefined && summary.tag === undefined) {
      continue;
    }
    rows.push({
      ...(summary.happySessionId === undefined ? {} : { happySessionId: summary.happySessionId }),
      ...(summary.tag === undefined ? {} : { tag: summary.tag }),
      isAlive: summary.isAlive,
      ...(summary.origin === undefined ? {} : { origin: summary.origin }),
    });
  }
  return rows;
}
