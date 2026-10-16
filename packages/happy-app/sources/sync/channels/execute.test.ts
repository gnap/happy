import { describe, expect, it, vi } from 'vitest';
import { carryOperation, type ChannelAttempt, type HealthRecorder } from './execute';
import type { ChannelDriver, ChannelEndpoint, ChannelOperation } from './types';
import type { DaemonRoute, SessionChannel } from '@/sync/lan/types';

const LAN = 'http://192.168.5.87:55673';
const OTHER = 'http://10.99.0.1:55673';
const RELAY = 'https://relay.example.com/r/' + 'a'.repeat(32);

const endpoint = (route: DaemonRoute, baseUrl: string): ChannelEndpoint =>
    ({ kind: 'address', route, baseUrl, source: route === 'relay' ? 'published' : 'published' });

/** A driver that offers these endpoints and accepts everything it can do. */
const driver = (
    channel: SessionChannel,
    endpoints: ChannelEndpoint[],
    accepts: (operation: ChannelOperation) => boolean = () => true,
): ChannelDriver => ({
    channel,
    link: () => null,
    session: () => null,
    machine: () => null,
    capable: () => true,
    supports: accepts,
    endpoints: () => endpoints,
    socketTarget: () => endpoints[0] ?? null,
    accepts: (operation) => accepts(operation) && endpoints.length > 0,
});

const recorder = (): HealthRecorder & { succeeded: ReturnType<typeof vi.fn>; failed: ReturnType<typeof vi.fn> } => ({
    succeeded: vi.fn(),
    failed: vi.fn(),
});

describe('carryOperation', () => {
    it('asks the channels in the order it was given, and stops at the first that answers', async () => {
        const attempt = vi.fn(async (at: ChannelEndpoint): Promise<ChannelAttempt<string>> =>
            at.kind === 'address' && at.baseUrl === RELAY ? { kind: 'done', value: 'from relay' } : { kind: 'unreachable' });

        const outcome = await carryOperation({
            drivers: [driver('lan', [endpoint('lan', LAN)]), driver('relay', [endpoint('relay', RELAY)])],
            operation: 'read',
            machineId: 'm1',
            attempt,
        });

        expect(outcome).toEqual({ kind: 'done', value: 'from relay', channel: 'relay', endpoint: endpoint('relay', RELAY) });
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    it('tries the machine’s other addresses before giving up on the channel', async () => {
        // The bug this replaces: control and restart took the *first* address on a route and never
        // tried the second, so one unreachable address stood for the whole channel.
        const attempt = vi.fn(async (at: ChannelEndpoint): Promise<ChannelAttempt<string>> =>
            at.kind === 'address' && at.baseUrl === LAN ? { kind: 'done', value: 'here' } : { kind: 'unreachable' });

        const outcome = await carryOperation({
            drivers: [driver('lan', [endpoint('lan', OTHER), endpoint('lan', LAN)])],
            operation: 'restart',
            machineId: 'm1',
            attempt,
        });

        expect(outcome.kind).toBe('done');
        expect(attempt.mock.calls.map(([at]) => (at as { baseUrl: string }).baseUrl)).toEqual([OTHER, LAN]);
    });

    it('records a failure per address, and a success against the one that answered', async () => {
        const health = recorder();
        await carryOperation({
            drivers: [driver('lan', [endpoint('lan', OTHER), endpoint('lan', LAN)])],
            operation: 'identity',
            machineId: 'm1',
            attempt: async (at) => (at.kind === 'address' && at.baseUrl === LAN ? { kind: 'done', value: 1 } : { kind: 'unreachable' }),
            recorder: health,
        });

        expect(health.failed).toHaveBeenCalledWith('m1', 'lan', OTHER);
        expect(health.succeeded).toHaveBeenCalledWith('m1', 'lan', LAN);
    });

    it('does not hold a 404 or a refusal against the address', async () => {
        // They are answers about the session or about this device, and recording them as failures is
        // how a working address leaves the running.
        for (const answer of [{ kind: 'absent' } as const, { kind: 'refused', status: 403 } as const]) {
            const health = recorder();
            await carryOperation({
                drivers: [driver('lan', [endpoint('lan', LAN)])],
                operation: 'read',
                machineId: 'm1',
                attempt: async () => answer,
                recorder: health,
            });
            expect(health.failed).not.toHaveBeenCalled();
            expect(health.succeeded).not.toHaveBeenCalled();
        }
    });

    it('takes an answer as final for this machine, and still asks the next channel', async () => {
        // The daemon has no log for this session; the server may still hold it.
        const attempt = vi.fn(async (at: ChannelEndpoint): Promise<ChannelAttempt<string>> =>
            at.kind === 'server' ? { kind: 'done', value: 'from server' } : { kind: 'absent' });

        const outcome = await carryOperation({
            drivers: [driver('lan', [endpoint('lan', LAN), endpoint('lan', OTHER)]), driver('server', [{ kind: 'server' }])],
            operation: 'read',
            machineId: 'm1',
            attempt,
        });

        expect(outcome.kind).toBe('done');
        // One attempt on the LAN — the second address would reach the same daemon — and then the server.
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    it('reports where it went when nothing answered', async () => {
        const outcome = await carryOperation({
            drivers: [driver('lan', [endpoint('lan', OTHER), endpoint('lan', LAN)])],
            operation: 'read',
            machineId: 'm1',
            attempt: async () => ({ kind: 'unreachable' }),
        });

        expect(outcome).toEqual({ kind: 'unreachable', channel: 'lan', tried: [OTHER, LAN] });
    });

    it('refuses without asking when no channel can do this at all', async () => {
        // Starting a session is the server's, and the daemon drivers say so rather than being asked
        // and failing.
        const attempt = vi.fn(async (): Promise<ChannelAttempt<string>> => ({ kind: 'done', value: 'x' }));
        const outcome = await carryOperation({
            drivers: [driver('lan', [endpoint('lan', LAN)], () => false), driver('relay', [endpoint('relay', RELAY)], () => false)],
            operation: 'spawn',
            machineId: 'm1',
            attempt,
        });

        expect(outcome).toEqual({ kind: 'refused', reason: 'unsupported', channel: null });
        expect(attempt).not.toHaveBeenCalled();
    });

    it('skips a channel that could do it but has nowhere to send it', async () => {
        const attempt = vi.fn(async (): Promise<ChannelAttempt<string>> => ({ kind: 'done', value: 'x' }));
        const outcome = await carryOperation({
            drivers: [driver('lan', []), driver('server', [{ kind: 'server' }])],
            operation: 'listSessions',
            machineId: 'm1',
            attempt,
        });

        expect(outcome.kind).toBe('done');
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it('treats a thrown request as an address that did not answer', async () => {
        // Left to the caller, a throw would abandon the machine's other addresses too.
        const health = recorder();
        const outcome = await carryOperation({
            drivers: [driver('lan', [endpoint('lan', OTHER), endpoint('lan', LAN)])],
            operation: 'read',
            machineId: 'm1',
            attempt: async (at) => {
                if (at.kind === 'address' && at.baseUrl === OTHER) {
                    throw new Error('EHOSTUNREACH');
                }
                return { kind: 'done', value: 'ok' };
            },
            recorder: health,
        });

        expect(outcome.kind).toBe('done');
        expect(health.failed).toHaveBeenCalledWith('m1', 'lan', OTHER);
    });
});
