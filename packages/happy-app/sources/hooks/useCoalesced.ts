import * as React from 'react';

/**
 * A value that reaches the screen at most once per interval.
 *
 * The session list's store data is rewritten by every push — several times a second — and each
 * commit of the list costs 100–140 ms (measured on a device; 179 items with avatars and swipe
 * actions). Committing on every write spent half the JS thread redrawing a summary that had
 * barely changed, and the UI felt frozen without any single operation being slow.
 *
 * The latest value is always kept, so the screen converges on it; only the moment is deferred.
 * A timer is used to apply the trailing update, but the effect re-checks on the next value too,
 * so a stalled timer cannot keep the list stale forever.
 */
export function useCoalesced<T>(value: T, intervalMs: number): T {
    const [rendered, setRendered] = React.useState(value);
    const lastCommitRef = React.useRef(0);
    const latestRef = React.useRef(value);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    latestRef.current = value;

    React.useEffect(() => {
        if (value === rendered) {
            return;
        }
        const elapsed = Date.now() - lastCommitRef.current;
        if (elapsed >= intervalMs) {
            lastCommitRef.current = Date.now();
            setRendered(value);
            return;
        }
        if (timerRef.current !== null) {
            return;
        }
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            lastCommitRef.current = Date.now();
            setRendered(latestRef.current);
        }, intervalMs - elapsed);
    }, [value, rendered, intervalMs]);

    React.useEffect(() => () => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
        }
    }, []);

    return rendered;
}
