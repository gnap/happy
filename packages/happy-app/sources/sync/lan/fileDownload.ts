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

import { Platform } from 'react-native';
import { fetchSessionFileBytes, fetchSessionFolderBytes, LanRequestError } from './client';

export type SessionFileDownload =
    /** The file is on this device now, at `uri`. */
    | { kind: 'done'; uri: string; size: number }
    /**
     * The bytes themselves, because there is no file system to write them to. A browser has no
     * download task; the viewer reads the characters and draws the image from these.
     */
    | { kind: 'bytes'; bytes: Uint8Array; size: number }
    /** The machine answered and has no such file (or no file route at all). */
    | { kind: 'not-found' };

/** One directory, packed by the machine, on its way to wherever this device keeps downloads. */
export type SessionFolderDownload =
    | { kind: 'done'; uri: string; name: string }
    | { kind: 'bytes'; bytes: Uint8Array; name: string }
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
    // No file system on web/Tauri: the request is the transport. Fetching here rather than
    // letting the native download throw is what makes a preview reach the machine at all.
    if (Platform.OS === 'web') {
        const fetched = await fetchSessionFileBytes(
            options.baseUrl,
            options.token,
            options.sessionId,
            options.path,
            options.proof,
        );
        if (fetched === null) {
            return { kind: 'not-found' };
        }
        // A fetch has no middle to report: it either has the bytes or the attempt failed, so the
        // progress bar goes straight to the end instead of hanging at zero.
        options.onProgress?.(fetched.size, fetched.size);
        return { kind: 'bytes', bytes: fetched.bytes, size: fetched.size };
    }
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

/**
 * One directory, packed on the machine and brought over the same channel.
 *
 * The archive is a download in the ordinary sense — the App saves it and opens it wherever it
 * likes — so the native path writes it to a cache file and the web path keeps the bytes for a
 * save anchor. Null/`not-found` is the machine saying it has no such directory, which the carry
 * reports as `absent` rather than as an address that failed.
 */
export async function downloadSessionFolderFromDaemon(options: {
    baseUrl: string;
    token: string;
    sessionId: string;
    path: string;
    proof?: Record<string, string>;
}): Promise<SessionFolderDownload> {
    const name = safeName(options.path.split('/').filter(Boolean).pop() || 'project') + '.tar.gz';
    if (Platform.OS === 'web') {
        const fetched = await fetchSessionFolderBytes(
            options.baseUrl,
            options.token,
            options.sessionId,
            options.path,
            options.proof,
        );
        return fetched === null
            ? { kind: 'not-found' }
            : { kind: 'bytes', bytes: fetched.bytes, name: fetched.name || name };
    }
    const fs = await import('expo-file-system');
    const directory = new fs.Directory(fs.Paths.cache, 'happy-folders');
    directory.create({ intermediates: true, idempotent: true });
    const destination = new fs.File(directory, name);
    if (destination.exists) {
        destination.delete();
    }
    const url = `${options.baseUrl}/lan/sessions/${encodeURIComponent(options.sessionId)}/folder`
        + `?path=${encodeURIComponent(options.path)}`;
    const task = fs.File.createDownloadTask(url, destination, {
        headers: {
            authorization: `Bearer ${options.token}`,
            ...(options.proof ?? {}),
        },
    });
    try {
        await task.downloadAsync();
        return { kind: 'done', uri: destination.uri, name };
    } catch (error) {
        const status = statusOf(error);
        if (status === 404) {
            return { kind: 'not-found' };
        }
        if (status !== null) {
            throw new LanRequestError(
                error instanceof Error ? error.message : 'folder request failed',
                status,
                error instanceof Error ? error.message : undefined,
            );
        }
        throw error;
    }
}
