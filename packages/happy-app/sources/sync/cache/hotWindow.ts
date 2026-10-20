/**
 * The part of a session's cache that must be readable without awaiting anything.
 *
 * Opening a conversation is the one interaction where the database has no time to be slow: the
 * screen has nothing to draw until it has the newest messages, and SQLite — even when healthy —
 * is an asynchronous native call whose result waits behind whatever else the JS thread is doing.
 * Measured on a device, the same read was 50ms with a free thread and six seconds while the thread
 * was busy; nothing about the file changed between them.
 *
 * So the newest window lives here as well, in MMKV, whose read is a synchronous memory-mapped
 * lookup: `loadHotWindow` returns before the first `await`, and the app paints the conversation it
 * already had. SQLite remains the archive — the older rows, the paging source, the copy that
 * survives a hot-window miss — this is only the part a tap is waiting for.
 *
 * What is stored is the *window*, not the history: sixty messages and the reducer state trimmed to
 * them. Keeping more would move the cost this exists to remove back onto the synchronous path.
 */

import type { MMKV } from 'react-native-mmkv';
import type { Message } from '../typesMessage';

/** Bump when the stored shape changes; an old window is ignored, and SQLite answers instead. */
const HOT_WINDOW_VERSION = 1;
const KEY_PREFIX = 'hot-window:';
const INDEX_KEY = 'hot-window-index';
/**
 * How many sessions keep a hot window.
 *
 * One window is tens to hundreds of kilobytes, and the point is that the sessions a person has
 * opened recently are instant. Unbounded, this becomes a second, synchronous copy of the cache;
 * the least recently used are dropped and the next open falls back to SQLite.
 */
const MAX_HOT_SESSIONS = 8;

/** The slice of MMKV this file uses. Narrow so a test can stand in for it. */
export type HotWindowStore = Pick<MMKV, 'getString' | 'set' | 'delete' | 'getAllKeys'>;

/**
 * Resolved lazily, and injectable.
 *
 * `react-native-mmkv` is a native module: importing it at module scope makes every consumer of the
 * cache depend on a JSI runtime at import time — tests included — and one environment where it is
 * absent turns the whole cache into a module that cannot be loaded. The lookup is deferred to the
 * first read, and a test can hand in an in-memory store instead.
 */
let store: HotWindowStore | null | undefined;
let injected: HotWindowStore | null | undefined;

export function overrideHotWindowStore(override: HotWindowStore | null): void {
    injected = override;
}

function getStore(): HotWindowStore | null {
    if (injected !== undefined) {
        return injected;
    }
    if (store !== undefined) {
        return store;
    }
    try {
        // Metro resolves this at build time; the require stays inside the try so an environment
        // without the native module (a unit test, a web build) degrades to "no hot window".
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { MMKV: MMKVClass } = require('react-native-mmkv') as { MMKV: new () => HotWindowStore };
        store = new MMKVClass();
    } catch {
        store = null;
    }
    return store;
}

type Index = Record<string, number>;

export type HotWindow = {
    messages: Message[];
    reducerStateJson: string;
    lastSeq: number;
    oldestSeq: number;
    hasOlderMessages: boolean;
    /** Bytes of the stored JSON, for the log line. */
    bytes: number;
};

type StoredHotWindow = Omit<HotWindow, 'bytes'> & {
    v: number;
    savedAt: number;
};

function readIndex(mmkv: HotWindowStore): Index {
    const raw = mmkv.getString(INDEX_KEY);
    if (!raw) {
        return {};
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' ? parsed as Index : {};
    } catch {
        return {};
    }
}

function keyFor(sessionId: string): string {
    return `${KEY_PREFIX}${sessionId}`;
}

/** The window for a session, or null when there is none (or it predates this shape). */
export function loadHotWindow(sessionId: string): HotWindow | null {
    const mmkv = getStore();
    if (!mmkv) {
        return null;
    }
    let raw: string | undefined;
    try {
        raw = mmkv.getString(keyFor(sessionId));
    } catch {
        return null;
    }
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw) as StoredHotWindow;
        if (parsed?.v !== HOT_WINDOW_VERSION || !Array.isArray(parsed.messages)) {
            return null;
        }
        return {
            messages: parsed.messages,
            reducerStateJson: typeof parsed.reducerStateJson === 'string' ? parsed.reducerStateJson : '{}',
            lastSeq: Number(parsed.lastSeq) || 0,
            oldestSeq: Number(parsed.oldestSeq) || 0,
            hasOlderMessages: parsed.hasOlderMessages === true,
            bytes: raw.length,
        };
    } catch {
        return null;
    }
}

/** Replaces the window for a session and keeps the index to the most recently written ones. */
export function saveHotWindow(sessionId: string, window: {
    messages: Message[];
    reducerStateJson: string;
    lastSeq: number;
    oldestSeq: number;
    hasOlderMessages: boolean;
}): void {
    const mmkv = getStore();
    if (!mmkv) {
        return;
    }
    if (window.messages.length === 0) {
        clearHotWindow(sessionId);
        return;
    }
    const stored: StoredHotWindow = {
        v: HOT_WINDOW_VERSION,
        messages: window.messages,
        reducerStateJson: window.reducerStateJson,
        lastSeq: window.lastSeq,
        oldestSeq: window.oldestSeq,
        hasOlderMessages: window.hasOlderMessages,
        savedAt: Date.now(),
    };
    try {
        mmkv.set(keyFor(sessionId), JSON.stringify(stored));
    } catch {
        // A failed hot write is not fatal: the archive below still has the messages, and the next
        // open pays the asynchronous path instead of the synchronous one.
        return;
    }

    const index = readIndex(mmkv);
    index[sessionId] = stored.savedAt;
    const oldest = Object.entries(index)
        .sort(([, a], [, b]) => a - b)
        .slice(0, Math.max(0, Object.keys(index).length - MAX_HOT_SESSIONS));
    for (const [id] of oldest) {
        delete index[id];
        try {
            mmkv.delete(keyFor(id));
        } catch {
            // ignore
        }
    }
    mmkv.set(INDEX_KEY, JSON.stringify(index));
}

export function clearHotWindow(sessionId: string): void {
    const mmkv = getStore();
    if (!mmkv) {
        return;
    }
    try {
        mmkv.delete(keyFor(sessionId));
    } catch {
        // ignore
    }
    const index = readIndex(mmkv);
    if (sessionId in index) {
        delete index[sessionId];
        mmkv.set(INDEX_KEY, JSON.stringify(index));
    }
}

/** Drop every hot window — logout, or a full cache rebuild. */
export function clearAllHotWindows(): void {
    const mmkv = getStore();
    if (!mmkv) {
        return;
    }
    const index = readIndex(mmkv);
    for (const id of Object.keys(index)) {
        try {
            mmkv.delete(keyFor(id));
        } catch {
            // ignore
        }
    }
    for (const key of mmkv.getAllKeys()) {
        if (key.startsWith(KEY_PREFIX)) {
            try {
                mmkv.delete(key);
            } catch {
                // ignore
            }
        }
    }
    try {
        mmkv.delete(INDEX_KEY);
    } catch {
        // ignore
    }
}
