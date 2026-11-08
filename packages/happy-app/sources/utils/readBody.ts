import { yieldTask } from './yieldTask';

/**
 * Reads a response body without holding the JS thread for its whole duration.
 *
 * `response.text()` is one promise, but the work behind it is not necessarily off-thread: when the
 * fetch implementation exposes a `ReadableStream`, the polyfill pumps it through JS, and a 1.1MB
 * body arrives as one long chain of small tasks — measured on a device as 18–85 s during which the
 * app's timers did not fire and the screen would not update, with the body read's own duration
 * matching the stall. Reading chunk by chunk and yielding between them keeps timer callbacks and
 * renders interleaved; the total time is the same, the freeze is not.
 *
 * Falls back to `text()` where there is no stream (the XHR-based polyfill), which is one native
 * read and has no such chain.
 */
export async function readResponseTextCooperatively(response: Response): Promise<{ text: string; streamed: boolean }> {
    const body = (response as unknown as { body?: { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } }).body;
    const reader = body && typeof body.getReader === 'function' ? body.getReader() : null;
    if (!reader) {
        return { text: await response.text(), streamed: false };
    }
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value) {
            text += decoder.decode(value, { stream: true });
        }
        await yieldTask();
    }
    text += decoder.decode();
    return { text, streamed: true };
}
