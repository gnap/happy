/**
 * Asking the channels to do something, without any caller knowing which one will.
 *
 * Every operation the App performs on a machine used to pick its own route and its own address: a
 * read asked `preferredChannel` and built a candidate list, control and restart wrote the same
 * `['lan', 'relay']` ordering twice and took the *first* address on a route, versions were asked at
 * three differently-built address lists, and sends walked a ladder of their own. One of those lists
 * consulted what the addresses had done lately; the others did not, which is how a broken address
 * could stand for a working route.
 *
 * Here the drivers are asked in the device's priority order and each one carries the operation over
 * *its own* endpoints, so "how do I reach this machine" has one answer per channel and no call site
 * repeats it. What a caller supplies is the operation's own act — what to do at one endpoint — and
 * this decides which endpoint, in what order, and what each attempt proved.
 *
 * The rule about failures is the one the address health is built on: **only "nothing answered here"
 * counts against an address.** A daemon that answers 404 has told us about the session; one that
 * refuses has told us about the proof or about itself. Neither says the address is bad, and
 * recording them as failures would take a working address out of the running.
 *
 * And an answer is not a reason to ask another channel. Two of them end the carry outright: a
 * *refusal* (401/403 — about this device, or about this action) and a *bad request* (400/413/429/5xx
 * — about the request itself), because the next channel is either the same machine by another road
 * or a substitution for an action the machine declined. What keeps the carry going is exactly two
 * things: silence, which is the only availability fact there is, and a 404, which says this channel
 * has nothing — a different question, which the next channel may answer differently.
 */

import { candidateKey, type CandidateHealth } from './health';
import type { ChannelDriver, ChannelEndpoint, ChannelOperation } from './types';
import type { DaemonRoute, SessionChannel } from '@/sync/lan/types';

/** What one attempt at one endpoint came back with. */
export type ChannelAttempt<T> =
    /** It worked. */
    | { kind: 'done'; value: T }
    /** It answered, and has nothing of what was asked for (a 404, an unknown session). */
    | { kind: 'absent' }
    /** Nothing answered at this endpoint: refused to connect, or timed out. */
    | { kind: 'unreachable'; error?: unknown }
    /** It answered and refused this device or this action: a bad proof, or a token it would not take. */
    | { kind: 'refused'; status?: number; body?: string }
    /**
     * It answered, and the request as sent cannot be served — a body over the route's limit, a
     * shape it will not parse, a rate it will not take. Not silence and not a refusal about this
     * device: the same bytes down another route are the same mistake.
     */
    | { kind: 'bad-request'; status: number; body?: string };

/**
 * What a daemon's answer with this status means for the carry: 401 and 403 are about this device
 * or this action — a refusal, which ends the carry and is reported as the machine saying no —
 * and anything else is about the request itself, which no channel should be handed the same
 * bytes to say again.
 */
export const attemptFromStatus = (status: number, body?: string): ChannelAttempt<never> =>
    status === 401 || status === 403
        ? { kind: 'refused', status, body }
        : { kind: 'bad-request', status, body };

/** Where an attempt's outcome is recorded, so the next caller starts from what this one learned. */
export type HealthRecorder = {
    succeeded(machineId: string, route: DaemonRoute, baseUrl: string): void;
    failed(machineId: string, route: DaemonRoute, baseUrl: string): void;
};

export type CarryOutcome<T> =
    | { kind: 'done'; value: T; channel: SessionChannel; endpoint: ChannelEndpoint }
    /** A channel that took it answered, and did not have it. The next channel may still be asked. */
    | { kind: 'absent'; channel: SessionChannel }
    /**
     * Nothing carried it. `unsupported` is no channel being able to do this kind of thing at all
     * (or no channel this action was even offered to); `no-endpoint` is a channel that answered
     * and refused this device — with what it said, when it said anything.
     */
    | { kind: 'refused'; reason: 'unsupported' | 'no-endpoint'; channel: SessionChannel | null; status?: number; body?: string }
    /** Every address of every accepting channel was tried and none answered — with the first error, for the report. */
    | { kind: 'unreachable'; channel: SessionChannel; tried: string[]; error?: unknown }
    /**
     * A channel answered that the request itself cannot be served as sent. The carry stopped
     * there — no other channel was asked, because it would have been handed the same bytes — and
     * the status and body are the daemon's own words about why.
     */
    | { kind: 'bad-request'; status: number; body?: string; channel: SessionChannel };

/** The addresses an attempt got through, for the log line an `unreachable` deserves. */
const triedOf = (endpoints: readonly ChannelEndpoint[]): string[] =>
    endpoints.map((endpoint) => (endpoint.kind === 'address' ? endpoint.baseUrl : 'server'));

/**
 * Carries an operation for a machine, over whichever channel will take it.
 *
 * Drivers are tried in the order given — which is the device's channel priority — and a channel that
 * accepts the operation is asked to carry it over each of its endpoints in turn. `unreachable` moves
 * to the next endpoint (and records the failure); `absent` ends that channel's turn, because it is an
 * answer rather than silence — a 404 for a session is true of every address of the machine that
 * answered it — while the next *channel* may still help, as the server holds what the daemon does
 * not. A refusal and a bad request end the whole carry, with the daemon's words attached: the next
 * channel would be the same machine by another road, or a substitution for an action it declined.
 */
export async function carryOperation<T>(args: {
    drivers: readonly ChannelDriver[];
    operation: ChannelOperation;
    machineId: string;
    attempt: (endpoint: ChannelEndpoint, driver: ChannelDriver) => Promise<ChannelAttempt<T>>;
    recorder?: HealthRecorder;
    now?: number;
}): Promise<CarryOutcome<T>> {
    const now = args.now ?? Date.now();
    let sawChannel = false;
    let lastChannel: SessionChannel | null = null;
    const tried: string[] = [];
    let firstError: unknown;
    /** The one answer that keeps looking for another channel: this one has nothing. */
    let answered: Extract<CarryOutcome<T>, { kind: 'absent' }> | null = null;

    for (const driver of args.drivers) {
        if (!driver.accepts(args.operation, args.machineId, now)) {
            continue;
        }
        sawChannel = true;
        lastChannel = driver.channel;
        for (const endpoint of driver.endpoints(args.machineId, now)) {
            tried.push(...triedOf([endpoint]));
            const record = (kind: 'succeeded' | 'failed') => {
                if (args.recorder && endpoint.kind === 'address') {
                    args.recorder[kind](args.machineId, endpoint.route, endpoint.baseUrl);
                }
            };
            let attempt: ChannelAttempt<T>;
            try {
                attempt = await args.attempt(endpoint, driver);
            } catch (error) {
                // A thrown request is an address that did not answer, which is exactly what the
                // health record is for — and it is why this is caught here rather than left to the
                // caller, where it would abandon the machine's other addresses too.
                attempt = { kind: 'unreachable', error };
            }
            if (attempt.kind === 'done') {
                record('succeeded');
                return { kind: 'done', value: attempt.value, channel: driver.channel, endpoint };
            }
            if (attempt.kind === 'unreachable') {
                firstError ??= attempt.error;
                record('failed');
                continue;
            }
            if (attempt.kind === 'absent') {
                // An answer rather than silence, so this machine's other addresses cannot say
                // anything new — a 404 for a session is true of every address that reaches that
                // daemon. The next *channel* may still help, though: the server holds what the
                // daemon does not, which is the whole reason a read falls back to it.
                answered = { kind: 'absent', channel: driver.channel };
                break;
            }
            // A refusal is about this device or this action; a bad request is about the request
            // itself. Neither is a fact about the address, and neither is something another
            // channel should be handed the same request to say again — the carry ends here, with
            // what the daemon actually said.
            return attempt.kind === 'refused'
                ? { kind: 'refused', reason: 'no-endpoint', channel: driver.channel, status: attempt.status, body: attempt.body }
                : { kind: 'bad-request', status: attempt.status, body: attempt.body, channel: driver.channel };
        }
    }

    if (answered) {
        return answered;
    }
    if (!sawChannel) {
        return { kind: 'refused', reason: 'unsupported', channel: null };
    }
    return { kind: 'unreachable', channel: lastChannel!, tried, error: firstError };
}

/**
 * Whether an address is worth trying at all, in the caller's own words.
 *
 * Kept here beside the carrying so a caller that filters before calling cannot use a different rule
 * from the one the attempts record.
 */
export const endpointKey = (machineId: string, endpoint: ChannelEndpoint): string | null =>
    endpoint.kind === 'address' ? candidateKey(machineId, endpoint.route, endpoint.baseUrl) : null;

/** Read-only view of the health map, for callers that want to show or filter by it. */
export type HealthView = Record<string, CandidateHealth>;
