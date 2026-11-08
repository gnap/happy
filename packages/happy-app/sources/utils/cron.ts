/**
 * When a five-field cron expression next fires.
 *
 * The CLI has its own copy of this for deciding when to wake a session; this one exists because
 * the card that *created* the schedule is in the App, and a countdown there must not wait for the
 * CLI to report that it fired. The two are deliberately small: fields, ranges, steps and lists —
 * the surface a model writes into `CronCreate`, not an industrial cron dialect.
 *
 * Day-of-month and day-of-week are ANDed rather than ORed. That is the CLI's reading too, and a
 * countdown that disagreed with the thing it counts down to would be worse than no countdown.
 */

const MINUTE_MS = 60_000;
/** A schedule with no match inside a year is treated as "never", not searched forever. */
const SEARCH_HORIZON_MS = 366 * 24 * 60 * MINUTE_MS;

/** Whether one cron field matches a value. Supports `*`, `n`, `a-b`, lists and `/step`. */
export function fieldMatches(field: string, value: number, min: number, max: number): boolean {
    for (const part of field.split(',')) {
        const [range, stepText] = part.split('/');
        const step = stepText === undefined ? 1 : Number.parseInt(stepText, 10);
        if (!Number.isFinite(step) || step <= 0) {
            continue;
        }
        let start = min;
        let end = max;
        if (range !== '*') {
            const [fromText, toText] = range.split('-');
            const from = Number.parseInt(fromText, 10);
            if (!Number.isFinite(from)) {
                continue;
            }
            start = from;
            end = toText === undefined ? from : Number.parseInt(toText, 10);
            if (!Number.isFinite(end)) {
                continue;
            }
        }
        if (value < start || value > end) {
            continue;
        }
        if ((value - start) % step === 0) {
            return true;
        }
    }
    return false;
}

/**
 * The first minute at or after `from` that matches, or null when none does within a year.
 *
 * Minute by minute, because the expression is minute-granular: the alternative is a calendar
 * arithmetic that has to get month lengths and daylight saving right, and an off-by-one there is
 * a countdown that lies. A year's worth of minutes is bounded work, and a caller that computes it
 * once per card does not notice it.
 */
export function nextCronFire(expression: string, from: number): number | null {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) {
        return null;
    }
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const start = new Date(from);
    start.setSeconds(0, 0);
    const horizon = from + SEARCH_HORIZON_MS;
    for (let at = start.getTime(); at <= horizon; at += MINUTE_MS) {
        const date = new Date(at);
        if (!fieldMatches(minute, date.getMinutes(), 0, 59)) continue;
        if (!fieldMatches(hour, date.getHours(), 0, 23)) continue;
        if (!fieldMatches(dayOfMonth, date.getDate(), 1, 31)) continue;
        if (!fieldMatches(month, date.getMonth() + 1, 1, 12)) continue;
        if (!fieldMatches(dayOfWeek, date.getDay(), 0, 6)) continue;
        return at;
    }
    return null;
}
