/**
 * One raw TCP pipe, viewed as a Node duplex stream.
 *
 * The relay hands the daemon a byte pipe and nothing else: it does not know that a SOCKS5
 * handshake is about to happen over it, and it does not decide where it may lead. This class is
 * the daemon's end of that pipe — it turns frames into bytes and bytes into frames, and it keeps
 * the credit windows that stop either side from running ahead of the other.
 *
 * Credit is in bytes and in both directions. The daemon may send a window's worth toward the
 * target before the relay has to credit it, and the relay may send a window's worth back. Both
 * windows are replenished as bytes are actually consumed, not as they are queued: a slow reader
 * must become backpressure on the producer, never an unbounded buffer on the other side.
 *
 * These constants match `packages/happy-relay/src/relay.ts`; the two ends assume a window at
 * open time rather than negotiating one, which keeps the first frame from needing a handshake.
 */
import { Duplex } from 'node:stream';

export const EGRESS_CHUNK_BYTES = 32 * 1024;
export const EGRESS_WINDOW_BYTES = 512 * 1024;
/** Nothing may hold more than this much credit; a peer's arithmetic cannot become our buffer. */
export const EGRESS_MAX_CREDIT = 4 * 1024 * 1024;

export class RelayEgressStream extends Duplex {
    private credit = EGRESS_WINDOW_BYTES;
    /** The chunk currently being accepted by the writable side, and how much of it has gone. */
    private writing: Buffer | null = null;
    private written = 0;
    private writeCallback: ((error?: Error | null) => void) | null = null;
    /** Bytes received from the relay but not yet credited back to it. */
    private uncredited = 0;
    private peerClosed = false;

    constructor(
        private readonly id: number,
        private readonly send: (frame: Record<string, unknown>) => void,
    ) {
        // Both halves outlive each other: a CONNECT tunnel may legitimately end in one direction
        // while the other is still carrying the rest of a response.
        super({ allowHalfOpen: true, highWaterMark: EGRESS_WINDOW_BYTES });
    }

    _read(): void {
        this.grantCredit();
    }

    _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        // Writable serializes `_write`, so this only guards against a caller breaking that.
        if (this.writing) {
            callback(new Error('egress write already in flight'));
            return;
        }
        this.writing = Buffer.from(chunk);
        this.written = 0;
        this.writeCallback = callback;
        this.pump();
    }

    _final(callback: (error?: Error | null) => void): void {
        if (!this.peerClosed) this.send({ t: 'eg-half', id: this.id });
        callback();
    }

    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        // `eg-close` is the relay's cue to destroy the target socket; an echo of the peer's own
        // close is noise, and after a dropped control connection it would go nowhere anyway.
        if (!this.peerClosed) this.send({ t: 'eg-close', id: this.id });
        // A write in flight has no other way to learn the stream is gone: Node does not call an
        // in-flight `_write` callback on destroy, so without this the caller's pipe would wait
        // forever for credit that can never arrive.
        const pending = this.writeCallback;
        this.writing = null;
        this.writeCallback = null;
        pending?.(error ?? new Error('egress stream closed'));
        callback(error);
    }

    /** The relay wrote more to the target; the writable side may continue. */
    addCredit(amount: number): void {
        if (amount <= 0) return;
        this.credit = Math.min(this.credit + amount, EGRESS_MAX_CREDIT);
        this.pump();
    }

    /** Bytes arrived from the target. */
    receiveData(bytes: Buffer): void {
        if (this.peerClosed || bytes.length === 0) return;
        this.uncredited += bytes.length;
        // `push` returning false means the readable buffer is full; the next `_read` is the point
        // at which the consumer has made room again, and that is when the window may reopen.
        if (this.push(bytes)) this.grantCredit();
    }

    /** The target finished writing. The daemon may still write toward it. */
    remoteHalf(): void {
        this.push(null);
    }

    /** The relay closed the pipe; there is nothing left to write to. */
    remoteClose(): void {
        this.peerClosed = true;
        this.destroy();
    }

    private pump(): void {
        while (this.writing) {
            if (this.written >= this.writing.length) {
                const callback = this.writeCallback;
                this.writing = null;
                this.writeCallback = null;
                this.written = 0;
                callback?.();
                return;
            }
            const size = Math.min(EGRESS_CHUNK_BYTES, this.writing.length - this.written);
            if (this.credit < size) return;
            const piece = this.writing.subarray(this.written, this.written + size);
            this.written += size;
            this.credit -= size;
            this.send({ t: 'eg-data', id: this.id, d: piece.toString('base64') });
        }
    }

    private grantCredit(): void {
        if (this.uncredited === 0) return;
        const amount = this.uncredited;
        this.uncredited = 0;
        this.send({ t: 'eg-credit', id: this.id, n: amount });
    }
}
