import * as React from 'react';
import { ToolViewProps } from './_all';
import { CountdownLine } from './CountdownLine';

/**
 * When the session will wake itself.
 *
 * The call returns the moment it is made, so the card's own elapsed time says nothing about what
 * the reader is waiting for; the delay was given as a duration and the deadline is that duration
 * measured from the call. A wake that is already due is history and shows nothing.
 */
export const ScheduleWakeupView = React.memo<ToolViewProps>(({ tool }) => {
    const delaySeconds = typeof tool.input?.delaySeconds === 'number' ? tool.input.delaySeconds : null;
    if (delaySeconds === null || delaySeconds < 0) {
        return null;
    }
    return <CountdownLine deadline={tool.createdAt + delaySeconds * 1000} hideWhenDue />;
});
