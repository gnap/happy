import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';

/**
 * A store addressed by id, where a write wakes only the subscribers of that id.
 *
 * The app's single zustand store wakes every subscriber on every write: one session's presence
 * update runs the selectors of every mounted list row, every chat screen, and everything else that
 * ever calls `storage(...)`. This is the smaller unit those subscribers are being migrated to — a
 * key, its value, and the listeners that asked for that key.
 *
 * Notifications are coalesced: writes mark keys dirty and the listeners run once on the next tick,
 * so a burst of writes for one session is one render, and a write for session A never reaches a
 * subscriber of session B.
 */
type Listener = () => void;

function nextTick(fn: () => void): void {
    // `setImmediate` is a different queue from timers and is not starved by rendering, which is why
    // it is preferred where it exists (React Native, Node). Web keeps the timer fallback.
    if (typeof setImmediate === 'function') {
        setImmediate(fn);
    } else {
        setTimeout(fn, 0);
    }
}

export class KeyedStore<T> {
    private values = new Map<string, T>();
    private versions = new Map<string, number>();
    private listeners = new Map<string, Set<Listener>>();
    private allListeners = new Set<Listener>();
    private dirty = new Set<string>();
    private scheduled = false;
    private cachedRecord: Record<string, T> | null = null;
    private cachedList: T[] | null = null;
    private allVersionCounter = 0;

    get(key: string): T | undefined {
        return this.values.get(key);
    }

    /**
     * The whole set as a record, memoised until the next write. Used by derivations that need to
     * see every entry at once — the session list, the channel answers — and by callers that pass
     * the set to code written against the old whole-map world.
     */
    snapshot(): Record<string, T> {
        if (!this.cachedRecord) {
            const record: Record<string, T> = {};
            this.values.forEach((value, key) => {
                record[key] = value;
            });
            this.cachedRecord = record;
        }
        return this.cachedRecord;
    }

    /** The whole set as a list, memoised alongside `snapshot`. */
    valuesList(): T[] {
        if (!this.cachedList) {
            this.cachedList = Array.from(this.values.values());
        }
        return this.cachedList;
    }

    /** Bumps on every write, like a key's version, but over the whole set. */
    allVersion(): number {
        return this.allVersionCounter;
    }

    /** Called once per flush, after the per-key listeners, if any key was written. */
    subscribeAll(listener: Listener): () => void {
        this.allListeners.add(listener);
        return () => {
            this.allListeners.delete(listener);
        };
    }

    /**
     * Monotonic per key. `useSyncExternalStore` needs a snapshot that changes exactly when the
     * value does, and a number is the cheapest such snapshot: it compares by value, so React sees
     * "unchanged" without touching the value itself.
     */
    version(key: string): number {
        return this.versions.get(key) ?? 0;
    }

    /** Write one key. An identical value is not a write: it does not bump the version. */
    set(key: string, value: T): void {
        if (this.values.get(key) === value) {
            return;
        }
        this.values.set(key, value);
        this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
        this.changed();
        this.markDirty(key);
    }

    delete(key: string): void {
        if (!this.values.delete(key)) {
            return;
        }
        this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
        this.changed();
        this.markDirty(key);
    }

    private changed(): void {
        this.cachedRecord = null;
        this.cachedList = null;
        this.allVersionCounter++;
    }

    /** Replace the whole set with the entries of `record`, keeping identities that did not move. */
    replaceAll(record: Record<string, T>): void {
        for (const key of Array.from(this.values.keys())) {
            if (!Object.prototype.hasOwnProperty.call(record, key)) {
                this.delete(key);
            }
        }
        for (const key of Object.keys(record)) {
            this.set(key, record[key]);
        }
    }

    subscribe(key: string, listener: Listener): () => void {
        let set = this.listeners.get(key);
        if (!set) {
            set = new Set();
            this.listeners.set(key, set);
        }
        set.add(listener);
        return () => {
            const current = this.listeners.get(key);
            if (!current) {
                return;
            }
            current.delete(listener);
            if (current.size === 0) {
                this.listeners.delete(key);
            }
        };
    }

    private markDirty(key: string): void {
        this.dirty.add(key);
        if (this.scheduled) {
            return;
        }
        this.scheduled = true;
        nextTick(() => this.flush());
    }

    private flush(): void {
        this.scheduled = false;
        if (this.dirty.size === 0) {
            return;
        }
        const keys = Array.from(this.dirty);
        this.dirty.clear();
        for (const key of keys) {
            const set = this.listeners.get(key);
            if (!set) {
                continue;
            }
            // Copy before iterating: a listener that unsubscribes (or subscribes) during the flush
            // must not change the set being walked.
            for (const listener of Array.from(set)) {
                listener();
            }
        }
        // The whole-set listeners go last: a derivation reading `snapshot()` must see every key
        // this flush wrote, and a per-key listener may itself write (which queues another flush).
        for (const listener of Array.from(this.allListeners)) {
            listener();
        }
    }
}

export function shallowEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) {
        return true;
    }
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
        return false;
    }
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) {
        return false;
    }
    for (const key of ak) {
        if (!Object.prototype.hasOwnProperty.call(b, key)
            || !Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
            return false;
        }
    }
    return true;
}

/**
 * Every value in the store, re-rendering once per flush.
 *
 * This is the old whole-map subscription, used by the few screens that genuinely need all entries
 * (the new-session wizard). It is deliberately not what a list row or a chat screen uses.
 */
export function useAllKeyedValues<T>(store: KeyedStore<T>): T[] {
    const subscribe = useCallback((listener: Listener) => store.subscribeAll(listener), [store]);
    const snapshot = useCallback(() => store.allVersion(), [store]);
    useSyncExternalStore(subscribe, snapshot, snapshot);
    return store.valuesList();
}

/**
 * A projection of the whole store, re-rendering only when the projection changes.
 *
 * For a subscriber that sits above the navigation tree and must not be woken by every write:
 * the projection is recomputed once per flush, but the component only renders when its result
 * differs. The projected value should therefore be cheap and comparable by `Object.is` — a string
 * key, a count, a flag — not an array or an object built fresh every time.
 */
export function useKeyedProjection<T, S>(
    store: KeyedStore<T>,
    project: (values: readonly T[]) => S,
): S {
    const projectRef = useRef(project);
    projectRef.current = project;
    const subscribe = useCallback((listener: Listener) => store.subscribeAll(listener), [store]);
    const cache = useMemo(() => ({ version: -1, value: undefined as S }), [store]);
    const snapshot = useCallback(() => {
        const version = store.allVersion();
        if (cache.version !== -1 && cache.version === version) {
            return cache.value;
        }
        cache.version = version;
        cache.value = projectRef.current(store.valuesList());
        return cache.value;
    }, [store, cache]);
    return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The value stored at `key`, re-rendering only when that key's value is replaced. */
export function useKeyedValue<T>(store: KeyedStore<T>, key: string): T | undefined {
    const subscribe = useCallback((listener: Listener) => store.subscribe(key, listener), [store, key]);
    const snapshot = useCallback(() => store.version(key), [store, key]);
    useSyncExternalStore(subscribe, snapshot, snapshot);
    return store.get(key);
}

/**
 * A projection of one key, re-rendering only when the projection changes.
 *
 * `useKeyedValue` re-renders whenever the stored object moves; a hook like `useSessionMessages`
 * selects eight fields out of it, and most writes replace only `messages`. The selector is
 * memoised against the value identity and its result compared with `equals`, which is the same
 * contract zustand's `useShallow` gave these hooks before the store was split.
 */
export function useKeyedSelector<T, S>(
    store: KeyedStore<T>,
    key: string,
    select: (value: T | undefined) => S,
    equals: (a: S, b: S) => boolean = Object.is,
): S {
    const selectRef = useRef(select);
    selectRef.current = select;
    const equalsRef = useRef(equals);
    equalsRef.current = equals;

    // One cache per (store, key): switching session must not answer with the previous session's
    // snapshot. `useMemo` is enough here — a changed key also changes the subscription, and the
    // first `getSnapshot` after the change sees `primed: false`.
    const cache = useMemo(
        () => ({ primed: false, value: undefined as T | undefined, selected: undefined as S }),
        [store, key],
    );

    const subscribe = useCallback((listener: Listener) => store.subscribe(key, listener), [store, key]);
    const snapshot = useCallback(() => {
        const value = store.get(key);
        if (cache.primed && cache.value === value) {
            return cache.selected;
        }
        const selected = selectRef.current(value);
        if (cache.primed && equalsRef.current(cache.selected, selected)) {
            cache.value = value;
            return cache.selected;
        }
        cache.primed = true;
        cache.value = value;
        cache.selected = selected;
        return selected;
    }, [store, key, cache]);

    return useSyncExternalStore(subscribe, snapshot, snapshot);
}
