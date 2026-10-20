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

const windowFor = (ids: string[]) => ({
    messages: ids.map((id, i) => message(id, 1000 + i)),
    reducerStateJson: '{"schemaVersion":1}',
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

    it('round-trips the window a tap reads', () => {
        saveHotWindow('s1', windowFor(['a', 'b']));

        const loaded = loadHotWindow('s1');
        expect(loaded).not.toBeNull();
        expect(loaded!.messages.map((m) => m.id)).toEqual(['a', 'b']);
        expect(loaded!.reducerStateJson).toBe('{"schemaVersion":1}');
        expect(loaded!.lastSeq).toBe(42);
        expect(loaded!.oldestSeq).toBe(7);
        expect(loaded!.hasOlderMessages).toBe(true);
        expect(loaded!.bytes).toBeGreaterThan(0);
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
