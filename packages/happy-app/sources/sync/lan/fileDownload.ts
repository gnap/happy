/**
 * One file from a machine's working tree, fetched over that machine's own channel.
 *
 * The App's file viewer used to read through the session's `readFile` RPC, which travels to the
 * server and back — the slowest route in the system, and one that stops answering when the server
 * does. The machine holding the file answers this itself, over LAN or the relay, and the response
 * carries a `content-length`, which is what makes a progress bar possible at all.
 *
 * The bytes go straight to a cache file: they are never text here, and a base64 round trip would
 * inflate a PDF by a third on its way to disk.
 */

import { LanRequestError } from './client';

export type SessionFileDownload =
    /** The file is on this device now, at `uri`. */
    | { kind: 'done'; uri: string; size: number }
    /** The machine answered and has no such file (or no file route at all). */
    | { kind: 'not-found' };

/** A name from another filesystem is not a path this device should interpret. */
function safeName(name: string): string {
    return name.replace(/[^A-Za-z0-9._-]/g, '_') || 'file';
}

/**
 * The HTTP status an `UnableToDownload` failure carries.
 *
 * expo-file-system reports a non-2xx response as a download failure whose message names the code;
 * there is no structured status on the error, so this is how the carry tells "this machine has no
 * such file" (404, an answer) from "the address did not answer" (silence).
 */
function statusOf(error: unknown): number | null {
    const message = error instanceof Error ? error.message : String(error);
    const match = /\b(4\d\d|5\d\d)\b/.exec(message);
    return match ? Number(match[1]) : null;
}

export async function downloadSessionFileFromDaemon(options: {
    baseUrl: string;
    token: string;
    sessionId: string;
    path: string;
    proof?: Record<string, string>;
    onProgress?: (written: number, total: number) => void;
}): Promise<SessionFileDownload> {
    const fs = await import('expo-file-system');
    const directory = new fs.Directory(fs.Paths.cache, 'happy-files');
    directory.create({ intermediates: true, idempotent: true });
    const name = options.path.split('/').pop() || 'file';
    const destination = new fs.File(directory, safeName(name));
    // A download task will not overwrite an existing file. A retry over another address — or a
    // second preview of the same file — writes the same name, so the old copy goes first.
    if (destination.exists) {
        destination.delete();
    }
    const url = `${options.baseUrl}/lan/sessions/${encodeURIComponent(options.sessionId)}/file`
        + `?path=${encodeURIComponent(options.path)}`;
    const task = fs.File.createDownloadTask(url, destination, {
        headers: {
            authorization: `Bearer ${options.token}`,
            ...(options.proof ?? {}),
        },
        onProgress: ({ bytesWritten, totalBytes }) => options.onProgress?.(bytesWritten, totalBytes),
    });
    try {
        await task.downloadAsync();
        return { kind: 'done', uri: destination.uri, size: destination.size ?? 0 };
    } catch (error) {
        const status = statusOf(error);
        if (status === 404) {
            // Either the machine has no such file or it predates this route. Both mean "ask
            // somewhere else", which is the carry's `absent` — not an address that failed.
            return { kind: 'not-found' };
        }
        if (status !== null) {
            // A refused or oversized request is the machine's own word about this device or this
            // file; another address would say the same, so the carry must stop here.
            throw new LanRequestError(
                error instanceof Error ? error.message : 'file request failed',
                status,
                error instanceof Error ? error.message : undefined,
            );
        }
        throw error;
    }
}
