import { describe, expect, it, vi } from 'vitest';
import { KeyedStore, shallowEqual } from './live';

/** Notifications are coalesced to the next tick, so a test must let that tick happen. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('KeyedStore', () => {
    it('does not treat the same value as a write', () => {
        const store = new KeyedStore<{ n: number }>();
        const value = { n: 1 };
        store.set('a', value);
        const before = store.version('a');

        store.set('a', value);

        expect(store.version('a')).toBe(before);
    });

    it('wakes only the subscribers of the key that changed', async () => {
        const store = new KeyedStore<number>();
        store.set('a', 1);
        store.set('b', 1);
        await tick();
        const a = vi.fn();
        const b = vi.fn();
        store.subscribe('a', a);
        store.subscribe('b', b);

        store.set('a', 2);
        await tick();

        expect(a).toHaveBeenCalledTimes(1);
        expect(b).not.toHaveBeenCalled();
    });

    it('coalesces a burst of writes into one notification', async () => {
        const store = new KeyedStore<number>();
        const listener = vi.fn();
        store.subscribe('a', listener);

        store.set('a', 1);
        store.set('a', 2);
        store.set('a', 3);
        expect(listener).not.toHaveBeenCalled();

        await tick();

        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.get('a')).toBe(3);
    });

    it('keeps identities that did not move when replacing the whole set', () => {
        const store = new KeyedStore<{ n: number }>();
        const kept = { n: 1 };
        const replaced = { n: 2 };
        store.set('kept', kept);
        store.set('replaced', replaced);

        const nextReplacement = { n: 3 };
        store.replaceAll({ kept, replaced: nextReplacement, added: { n: 4 } });

        expect(store.get('kept')).toBe(kept);
        expect(store.version('kept')).toBe(1);
        expect(store.get('replaced')).toBe(nextReplacement);
        expect(store.get('added')).toEqual({ n: 4 });
    });

    it('removes entries the new set no longer has, and tells their subscribers', async () => {
        const store = new KeyedStore<number>();
        store.set('gone', 1);
        const listener = vi.fn();
        store.subscribe('gone', listener);

        store.replaceAll({});

        await tick();

        expect(store.get('gone')).toBeUndefined();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('stops notifying a subscriber that unsubscribed during the flush', async () => {
        const store = new KeyedStore<number>();
        const second = vi.fn();
        const unsubscribeFirst = store.subscribe('a', () => unsubscribeFirst());
        store.subscribe('a', second);

        store.set('a', 1);
        await tick();

        expect(second).toHaveBeenCalledTimes(1);
    });
});

describe('shallowEqual', () => {
    it('compares one level, by value', () => {
        const shared = { nested: true };
        expect(shallowEqual({ a: 1, b: shared }, { a: 1, b: shared })).toBe(true);
        expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
        expect(shallowEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
        expect(shallowEqual(null, {})).toBe(false);
    });
});
