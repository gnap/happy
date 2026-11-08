/**
 * Give the event loop one turn back.
 *
 * `setTimeout(0)` is a timer, and timers are exactly what is starved when the JS thread is busy:
 * measured on a device, a loop yielding with it stretched a 150-entry decrypt from ~7s of work to
 * 39s of wall time while the screen stayed frozen. `setImmediate` is a different queue — it runs
 * after the current task, before timers — so a busy loop still hands the loop back between
 * chunks. Falls back to a timer only where `setImmediate` does not exist.
 */
export function yieldTask(): Promise<void> {
    return new Promise((resolve) => {
        if (typeof setImmediate === 'function') {
            setImmediate(() => resolve());
        } else {
            setTimeout(resolve, 0);
        }
    });
}
