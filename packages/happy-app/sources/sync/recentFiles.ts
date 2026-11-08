/**
 * Files this device has opened, newest first.
 *
 * The file browser answers "where is everything"; this answers "where was I". Opening a file from
 * a message and coming back should not require finding it again through a tree or a search, and
 * the browser's own index is per-session and freshly fetched, so the last few open files are worth
 * keeping on the device.
 *
 * MMKV rather than the server: this is a reading trail on this device, not state about the session,
 * and it must be available before any network answer is.
 */

import * as React from 'react';
import { MMKV } from 'react-native-mmkv';

export type RecentFile = {
    sessionId: string;
    /** The same relative-to-the-working-tree path the viewer opens. */
    path: string;
    /** The basename, kept so the list does not re-split a path on every render. */
    name: string;
    at: number;
};

const STORAGE_KEY = 'recent-files-v1';
const LIMIT = 20;

let storage: MMKV | null = null;
function mmkv(): MMKV {
    if (!storage) {
        storage = new MMKV();
    }
    return storage;
}

function isRecentFile(value: unknown): value is RecentFile {
    const entry = value as Partial<RecentFile> | null;
    return !!entry
        && typeof entry.sessionId === 'string'
        && typeof entry.path === 'string'
        && typeof entry.name === 'string'
        && typeof entry.at === 'number';
}

function load(): RecentFile[] {
    try {
        const raw = mmkv().getString(STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed.filter(isRecentFile) : [];
    } catch {
        return [];
    }
}

let snapshot: RecentFile[] = load();
const listeners = new Set<() => void>();

function emit(next: RecentFile[]): void {
    snapshot = next;
    for (const listener of listeners) {
        listener();
    }
}

/** Records a file as opened, replacing any earlier entry for the same file. */
export function recordRecentFile(file: { sessionId: string; path: string }): void {
    const name = file.path.split('/').pop() || file.path;
    const next = [
        { sessionId: file.sessionId, path: file.path, name, at: Date.now() },
        ...snapshot.filter((entry) => !(entry.sessionId === file.sessionId && entry.path === file.path)),
    ].slice(0, LIMIT);
    try {
        mmkv().set(STORAGE_KEY, JSON.stringify(next));
    } catch {
        // A cache write that fails is not a reason to lose the entry for this run.
    }
    emit(next);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Stable until something is recorded, which is what `useSyncExternalStore` needs. */
function getSnapshot(): RecentFile[] {
    return snapshot;
}

export function useRecentFiles(): RecentFile[] {
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
