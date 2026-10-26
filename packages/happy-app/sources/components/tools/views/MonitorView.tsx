import * as React from 'react';
import { ToolViewProps } from './_all';
import { CountdownLine } from './CountdownLine';

/**
 * How long a watch still has.
 *
 * A monitor is the one background task with a deadline the App is told about: the tool's own
 * `timeout_ms`, measured from the call that started it. `persistent` means there is no deadline at
 * all — the watch runs until something stops it — and then there is nothing to count.
 */
export const MonitorView = React.memo<ToolViewProps>(({ tool }) => {
    if (tool.input?.persistent === true) {
        return null;
    }
    const timeoutMs = typeof tool.input?.timeout_ms === 'number' ? tool.input.timeout_ms : null;
    if (timeoutMs === null || timeoutMs <= 0) {
        return null;
    }
    return <CountdownLine deadline={tool.createdAt + timeoutMs} hideWhenDue />;
});
