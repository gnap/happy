import { describe, expect, it, vi } from 'vitest';

// The module reaches the native HMAC through the challenge proof; the routing under test never
// runs it, but the import has to resolve in a Node test.
vi.mock('@/encryption/hmac_sha256', () => ({ hmac_sha256: vi.fn(async () => new Uint8Array(32)) }));

const { dispatchLanFrame } = await import('./socket');

/**
 * The routing table of the LAN socket, without a socket.
 *
 * The mapping is the contract between the daemon's frame names and the App's handlers; a frame the
 * App does not know must be ignored rather than guessed at, or a newer daemon breaks an older App.
 */
describe('dispatchLanFrame', () => {
    it('routes each named frame to its handler', () => {
        const onUpdate = vi.fn();
        const onEphemeral = vi.fn();
        const onDelivered = vi.fn();
        const onBeat = vi.fn();

        dispatchLanFrame({ event: 'update', payload: { body: {} } }, { onUpdate, onEphemeral, onDelivered, onBeat });
        dispatchLanFrame({ event: 'ephemeral', payload: { type: 'activity', id: 's1' } }, { onUpdate, onEphemeral, onDelivered, onBeat });
        dispatchLanFrame({ event: 'delivered', payload: { sessionId: 's1', localId: 'l1', delivered: true } }, { onUpdate, onEphemeral, onDelivered, onBeat });
        dispatchLanFrame({ event: 'pong', payload: null }, { onUpdate, onEphemeral, onDelivered, onBeat });

        expect(onUpdate).toHaveBeenCalledWith({ body: {} });
        expect(onEphemeral).toHaveBeenCalledWith({ type: 'activity', id: 's1' });
        expect(onDelivered).toHaveBeenCalledWith({ sessionId: 's1', localId: 'l1', delivered: true });
        expect(onBeat).toHaveBeenCalledTimes(1);
    });

    it('ignores a frame it does not know', () => {
        const handlers = { onUpdate: vi.fn(), onEphemeral: vi.fn() };
        dispatchLanFrame({ event: 'something-new', payload: {} }, handlers);
        dispatchLanFrame({ payload: {} }, handlers);
        dispatchLanFrame(null, handlers);
        expect(handlers.onUpdate).not.toHaveBeenCalled();
        expect(handlers.onEphemeral).not.toHaveBeenCalled();
    });

    it('does not hand over a delivery verdict without the id it is about', () => {
        const onDelivered = vi.fn();
        dispatchLanFrame({ event: 'delivered', payload: { delivered: true } }, { onDelivered });
        expect(onDelivered).not.toHaveBeenCalled();
    });
});
