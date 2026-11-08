import { useEffect, useState } from 'react';

/**
 * Milliseconds until a moment, re-read once a second.
 *
 * Computed from the clock rather than decremented, so a suspended App, a slow frame or a missed
 * tick does not make the countdown drift — it is a claim about a moment, not about how many ticks
 * have happened. Negative means the moment has passed; the caller decides what to say then.
 */
export function useCountdown(deadline: number | null | undefined): number | null {
    const [remaining, setRemaining] = useState<number | null>(
        deadline === null || deadline === undefined ? null : deadline - Date.now(),
    );

    useEffect(() => {
        if (deadline === null || deadline === undefined) {
            setRemaining(null);
            return;
        }
        const update = () => setRemaining(deadline - Date.now());
        update();
        const interval = setInterval(update, 1000);
        return () => clearInterval(interval);
    }, [deadline]);

    return remaining;
}

/**
 * A countdown in the shortest unit that still says something: `45s`, `3m 12s`, `1h 05m`, `2d 4h`.
 *
 * Rounded up, so a countdown never reads zero while the moment it names is still ahead.
 */
export function formatCountdown(ms: number): string {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        const rest = seconds % 60;
        return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        const rest = minutes % 60;
        return rest === 0 ? `${hours}h` : `${hours}h ${String(rest).padStart(2, '0')}m`;
    }
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}
