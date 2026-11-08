import * as React from 'react';
import { StatusDot } from './StatusDot';
import { useSessionChannel } from '@/hooks/useSessionChannel';
import { CHANNEL_ICONS } from '@/sync/machinePresence';

/** The session's status dot drawn as its channel glyph, so list rows read like the session page. */
export const SessionStatusDot = React.memo(({ sessionId, color, isPulsing }: {
    sessionId: string;
    color: string;
    isPulsing?: boolean;
}) => {
    const { channel } = useSessionChannel(sessionId);
    return <StatusDot color={color} isPulsing={isPulsing} size={10} icon={CHANNEL_ICONS[channel]} />;
});
