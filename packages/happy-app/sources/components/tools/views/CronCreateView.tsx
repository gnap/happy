import * as React from 'react';
import { ToolViewProps } from './_all';
import { CountdownLine } from './CountdownLine';
import { nextCronFire } from '@/utils/cron';

/**
 * How long until this schedule fires.
 *
 * A recurring schedule keeps moving: when the moment it names passes, the card asks for the next
 * one instead of counting a deadline that has gone by. A one-shot that is already past is history
 * and shows nothing — its moment either fired or never will, and neither is a countdown.
 */
export const CronCreateView = React.memo<ToolViewProps>(({ tool }) => {
    const schedule = typeof tool.input?.cron === 'string' ? tool.input.cron : null;
    const recurring = tool.input?.recurring === true;
    const [deadline, setDeadline] = React.useState<number | null>(null);

    React.useEffect(() => {
        if (!schedule) {
            setDeadline(null);
            return;
        }
        if (!recurring) {
            // A one-shot names one moment, and it is relative to when the schedule was created —
            // not to now. Searching from now would find next year's same date once this year's has
            // passed, which is a countdown to something that will never happen.
            const first = nextCronFire(schedule, tool.createdAt);
            setDeadline(first !== null && first > Date.now() ? first : null);
            return;
        }
        const compute = () => nextCronFire(schedule, Date.now() + 1000);
        setDeadline(compute());
        // The view owns this cadence, not the countdown: only a recurring schedule has another
        // moment to move to, and only the schedule knows when it is.
        const interval = setInterval(() => {
            setDeadline((current) => (current !== null && Date.now() < current ? current : compute()));
        }, 1000);
        return () => clearInterval(interval);
    }, [schedule, recurring, tool.createdAt]);

    if (!schedule || deadline === null) {
        return null;
    }
    return <CountdownLine deadline={deadline} hideWhenDue={!recurring} />;
});
