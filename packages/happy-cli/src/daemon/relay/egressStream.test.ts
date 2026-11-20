import { describe, expect, it } from 'vitest';
import { EGRESS_CHUNK_BYTES, EGRESS_WINDOW_BYTES, RelayEgressStream } from './egressStream';

type Frame = Record<string, unknown>;

function makeStream(id = 1) {
    const frames: Frame[] = [];
    const stream = new RelayEgressStream(id, (frame) => frames.push(frame));
    return { frames, stream };
}

function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5));
}

describe('RelayEgressStream', () => {
    it('splits a write into frames no larger than the chunk size', async () => {
        const { frames, stream } = makeStream(9);
        const payload = Buffer.alloc(EGRESS_CHUNK_BYTES + 10, 7);
        await new Promise<void>((resolve, reject) => stream.write(payload, (error) => error ? reject(error) : resolve()));

        const data = frames.filter((frame) => frame.t === 'eg-data');
        expect(data).toHaveLength(2);
        expect(data[0]).toEqual({ t: 'eg-data', id: 9, d: payload.subarray(0, EGRESS_CHUNK_BYTES).toString('base64') });
        expect(data[1]).toEqual({ t: 'eg-data', id: 9, d: payload.subarray(EGRESS_CHUNK_BYTES).toString('base64') });
        stream.destroy();
    });

    it('stops at the credit window and resumes when the relay credits the consumed bytes', async () => {
        const { frames, stream } = makeStream(2);
        let done = false;
        stream.write(Buffer.alloc(EGRESS_WINDOW_BYTES + EGRESS_CHUNK_BYTES), () => { done = true; });
        await tick();

        const before = frames.filter((frame) => frame.t === 'eg-data').length;
        expect(before).toBe(EGRESS_WINDOW_BYTES / EGRESS_CHUNK_BYTES);
        expect(done).toBe(false);

        stream.addCredit(EGRESS_CHUNK_BYTES);
        await tick();
        expect(frames.filter((frame) => frame.t === 'eg-data').length).toBe(before + 1);
        expect(done).toBe(true);
        stream.destroy();
    });

    it('credits the relay for bytes it delivers once the reader has room', async () => {
        const { frames, stream } = makeStream(3);
        const received: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => received.push(chunk));

        stream.receiveData(Buffer.from('abc'));
        await tick();
        expect(received).toEqual([Buffer.from('abc')]);
        expect(frames).toContainEqual({ t: 'eg-credit', id: 3, n: 3 });
        stream.destroy();
    });

    it('ends the readable side on a half close without closing the writable side', async () => {
        const { frames, stream } = makeStream(4);
        const ended = new Promise<void>((resolve) => stream.once('end', resolve));
        stream.on('data', () => { /* drain so `end` can arrive */ });
        stream.remoteHalf();
        await ended;

        await new Promise<void>((resolve, reject) => stream.write('still going', (error) => error ? reject(error) : resolve()));
        expect(frames.filter((frame) => frame.t === 'eg-data')).toHaveLength(1);
        stream.destroy();
    });

    it('sends a half close of its own when the daemon is done writing', async () => {
        const { frames, stream } = makeStream(5);
        await new Promise<void>((resolve) => stream.end(() => resolve()));
        expect(frames).toContainEqual({ t: 'eg-half', id: 5 });
    });

    it('does not echo a close back when the relay was the one closing', () => {
        const { frames, stream } = makeStream(6);
        stream.remoteClose();
        expect(frames.filter((frame) => frame.t === 'eg-close')).toHaveLength(0);
    });

    it('does not send frames after the relay has closed the pipe', () => {
        const { frames, stream } = makeStream(7);
        stream.receiveData(Buffer.from('late'));
        stream.remoteClose();
        frames.length = 0;

        stream.receiveData(Buffer.from('later'));
        stream.addCredit(10);
        expect(frames).toHaveLength(0);
    });
});
