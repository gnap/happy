import { beforeEach, describe, expect, it } from 'vitest';
import {
    clearAllHotWindows,
    clearHotWindow,
    loadHotWindow,
    overrideHotWindowStore,
    saveHotWindow,
    type HotWindowStore,
} from './hotWindow';
import type { Message } from '../typesMessage';

class MemoryStore implements HotWindowStore {
    readonly values = new Map<string, string>();
    getString(key: string): string | undefined { return this.values.get(key); }
    set(key: string, value: string): void { this.values.set(key, value); }
    delete(key: string): void { this.values.delete(key); }
    getAllKeys(): string[] { return [...this.values.keys()]; }
}

const message = (id: string, createdAt: number): Message => ({
    kind: 'user-text',
    id,
    localId: null,
    createdAt,
    text: id,
});

/** The shape this store keeps: one copy of the window — its state, or its messages. */
const windowFor = (ids: string[]) => ({
    reducerStateJson: `{"ids":${JSON.stringify(ids)}}`,
    messages: null,
    messageCount: ids.length,
    lastSeq: 42,
    oldestSeq: 7,
    hasOlderMessages: true,
});

describe('hot window', () => {
    let store: MemoryStore;

    beforeEach(() => {
        store = new MemoryStore();
        overrideHotWindowStore(store);
    });

    it('round-trips the state a tap reads from', () => {
        saveHotWindow('s1', windowFor(['a', 'b']));

        const loaded = loadHotWindow('s1');
        expect(loaded).not.toBeNull();
        expect(loaded!.reducerStateJson).toBe('{"ids":["a","b"]}');
        expect(loaded!.messageCount).toBe(2);
        expect(loaded!.lastSeq).toBe(42);
        expect(loaded!.oldestSeq).toBe(7);
        expect(loaded!.hasOlderMessages).toBe(true);
        expect(loaded!.bytes).toBeGreaterThan(0);
    });

    it('keeps the messages when there is no state to keep', () => {
        // The cache drops an oversized reducer state; the window then stores its messages instead
        // of both, so a tap still has something to read before the database answers.
        saveHotWindow('s1', {
            reducerStateJson: null,
            messages: [message('a', 1), message('b', 2)],
            messageCount: 2,
            lastSeq: 1,
            oldestSeq: 1,
            hasOlderMessages: false,
        });

        const loaded = loadHotWindow('s1');
        expect(loaded).not.toBeNull();
        expect(loaded!.reducerStateJson).toBeNull();
        expect(loaded!.messages?.map((m) => m.id)).toEqual(['a', 'b']);
        expect(loaded!.messageCount).toBe(2);
    });

    it('returns null for a session with no window', () => {
        expect(loadHotWindow('missing')).toBeNull();
    });

    it('ignores a window written by an incompatible shape', () => {
        store.set('hot-window:old', JSON.stringify({ v: 999, messages: [message('a', 1)] }));
        expect(loadHotWindow('old')).toBeNull();
    });

    it('keeps only the most recently written windows', () => {
        for (let i = 0; i < 9; i += 1) {
            saveHotWindow(`s${i}`, windowFor([`m${i}`]));
        }
        // The first one written is the one evicted; the newest eight stay.
        expect(loadHotWindow('s0')).toBeNull();
        for (let i = 1; i < 9; i += 1) {
            expect(loadHotWindow(`s${i}`)).not.toBeNull();
        }
        expect(store.getAllKeys().filter((key) => key.startsWith('hot-window:'))).toHaveLength(8);
    });

    it('keeps the windows inside a byte budget, not only a count', () => {
        // A long conversation's window is two to three hundred thousand characters, and eight of
        // those filled the webview's entire localStorage — after which every other write failed.
        // The count cap alone could not see that; the budget is what bounds the store.
        const heavy = (id: string) => ({
            ...windowFor([id]),
            reducerStateJson: JSON.stringify({ id, padding: 'x'.repeat(200_000) }),
        });
        for (let i = 0; i < 8; i += 1) {
            saveHotWindow(`s${i}`, heavy(`m${i}`));
        }

        const keys = store.getAllKeys().filter((key) => key.startsWith('hot-window:'));
        const total = keys.reduce((sum, key) => sum + (store.getString(key)?.length ?? 0), 0);
        expect(total).toBeLessThanOrEqual(1_000_000);
        // The oldest went first; the newest is still there, and even a fresh window that alone
        // exceeds the budget is kept rather than dropped.
        expect(loadHotWindow('s0')).toBeNull();
        expect(loadHotWindow('s7')).not.toBeNull();
    });

    it('clears one window and all of them', () => {
        saveHotWindow('s1', windowFor(['a']));
        saveHotWindow('s2', windowFor(['b']));

        clearHotWindow('s1');
        expect(loadHotWindow('s1')).toBeNull();
        expect(loadHotWindow('s2')).not.toBeNull();

        clearAllHotWindows();
        expect(loadHotWindow('s2')).toBeNull();
        expect(store.getAllKeys().filter((key) => key.startsWith('hot-window:'))).toEqual([]);
    });

    it('does nothing when storage is unavailable', () => {
        overrideHotWindowStore(null);
        expect(() => saveHotWindow('s1', windowFor(['a']))).not.toThrow();
        expect(loadHotWindow('s1')).toBeNull();
    });
});
