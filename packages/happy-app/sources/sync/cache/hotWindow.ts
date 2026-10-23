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
 * What is stored is the *window*, not the history: the reducer state trimmed to the newest sixty
 * messages, and the messages themselves materialised from it on load rather than written beside it.
 * Keeping more — or keeping both copies — would move the cost this exists to remove back onto the
 * synchronous path.
 */

import type { MMKV } from 'react-native-mmkv';
import type { Message } from '../typesMessage';
/**
 * Bump when the stored shape changes; an old window is ignored, and SQLite answers instead.
 *
 * 2 is the shape that keeps only the reducer state. The messages a screen draws are materialised
 * from it on load, instead of being written a second time beside it — see `materializeReducerMessages`.
 */
const HOT_WINDOW_VERSION = 2;
const KEY_PREFIX = 'hot-window:';
const INDEX_KEY = 'hot-window-index';
/**
 * How much of the synchronous store the hot windows may take, and how many sessions they may span.
 *
 * The count alone was not enough. It assumed a window was "tens of hundreds of kilobytes"; a long
 * conversation's window is two to three hundred, and eight of them plus the session list filled the
 * webview's whole localStorage budget — measured at 2.6M characters, which WebKit counts as UTF-16,
 * so 5.2MB against a 5MB quota. Once there, *every* write fails, including settings and drafts, and
 * one of those throws inside a store action and takes the screen with it.
 *
 * So the cache keeps a budget as well as a count: enough recent sessions to be instant, and never
 * the whole quota. Eviction is oldest-first; the window just written is never dropped.
 */
const MAX_HOT_SESSIONS = 8;
const MAX_HOT_BYTES = 1_000_000;

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

/**
 * The same synchronous store, for the other caches that want a first-frame copy.
 *
 * The session list is the other thing a cold start cannot afford to await: it is what the home
 * screen draws before anything else exists. Sharing the accessor keeps one place where MMKV is
 * resolved (and one place a test can substitute).
 */
export function getSyncStore(): HotWindowStore | null {
    return getStore();
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

/** When a window was last written, and how much of the budget it holds. */
type IndexEntry = { at: number; bytes: number };
type Index = Record<string, IndexEntry>;

export type HotWindow = {
    /**
     * The window as the reducer knows it — the preferred copy.
     *
     * It is what the next ingest needs, and the display messages are a projection of it; storing
     * the projection too is what made a window twice the size of its content.
     */
    reducerStateJson: string | null;
    /**
     * The messages, stored only when the reducer state was too large to keep.
     *
     * The cache drops an oversized state before saving (deserialising it would cost more than the
     * open it serves), and for a session full of tool output that is the common case. Then the
     * messages are the window — still one copy, not two.
     */
    messages: Message[] | null;
    /**
     * How many messages the window holds.
     *
     * Not used to hydrate, but to check the copy: a state or list that no longer produces the
     * window it was saved with (a partial write, a different shape) is a cache miss, not a
     * shorter window.
     */
    messageCount: number;
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
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }
        // An index written before the budget existed stored bare timestamps. Read them, so the
        // first save after an upgrade still knows what it can evict rather than starting over.
        const index: Index = {};
        for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === 'number') {
                // Its size was not recorded; read it once so the first save after the upgrade
                // accounts for what is already on disk instead of letting it sit outside the budget.
                index[sessionId] = { at: value, bytes: mmkv.getString(keyFor(sessionId))?.length ?? 0 };
            } else if (value && typeof value === 'object') {
                const entry = value as { at?: unknown; bytes?: unknown };
                index[sessionId] = { at: Number(entry.at) || 0, bytes: Number(entry.bytes) || 0 };
            }
        }
        return index;
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
        const hasState = typeof parsed?.reducerStateJson === 'string';
        const hasMessages = Array.isArray(parsed?.messages);
        if (parsed?.v !== HOT_WINDOW_VERSION || (!hasState && !hasMessages)) {
            return null;
        }
        return {
            reducerStateJson: hasState ? parsed.reducerStateJson : null,
            messages: hasMessages ? parsed.messages : null,
            messageCount: Number(parsed.messageCount) || 0,
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
    reducerStateJson: string | null;
    messages: Message[] | null;
    messageCount: number;
    lastSeq: number;
    oldestSeq: number;
    hasOlderMessages: boolean;
}): void {
    const mmkv = getStore();
    if (!mmkv) {
        return;
    }
    if (window.messageCount === 0) {
        clearHotWindow(sessionId);
        return;
    }
    const stored: StoredHotWindow = {
        v: HOT_WINDOW_VERSION,
        reducerStateJson: window.reducerStateJson,
        messages: window.messages,
        messageCount: window.messageCount,
        lastSeq: window.lastSeq,
        oldestSeq: window.oldestSeq,
        hasOlderMessages: window.hasOlderMessages,
        savedAt: Date.now(),
    };
    const json = JSON.stringify(stored);
    try {
        mmkv.set(keyFor(sessionId), json);
    } catch {
        // A failed hot write is not fatal: the archive below still has the messages, and the next
        // open pays the asynchronous path instead of the synchronous one.
        return;
    }

    const index = readIndex(mmkv);
    index[sessionId] = { at: stored.savedAt, bytes: json.length };
    const oldestFirst = Object.entries(index).sort(([, a], [, b]) => a.at - b.at);
    let count = oldestFirst.length;
    let bytes = oldestFirst.reduce((sum, [, entry]) => sum + entry.bytes, 0);
    for (const [id, entry] of oldestFirst) {
        if (count <= MAX_HOT_SESSIONS && bytes <= MAX_HOT_BYTES) {
            break;
        }
        // The window just written is the one being opened; it stays even if it is over budget on
        // its own, because evicting it would leave the session it was written for without one.
        if (id === sessionId) {
            continue;
        }
        delete index[id];
        count -= 1;
        bytes -= entry.bytes;
        try {
            mmkv.delete(keyFor(id));
        } catch {
            // ignore
        }
    }
    try {
        mmkv.set(INDEX_KEY, JSON.stringify(index));
    } catch {
        // The windows themselves are still there; the index only decides what to evict next time.
    }
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
