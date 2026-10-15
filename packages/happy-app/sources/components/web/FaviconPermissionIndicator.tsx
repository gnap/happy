import React from 'react';
import { Platform } from 'react-native';
import { channelDrivers, resolveSessionReach } from '@/sync/reachability';
import { storage } from '@/sync/storage';
import { updateFaviconWithNotification, resetFavicon } from '@/utils/web/faviconGenerator';

/**
 * Component that monitors all sessions and updates the favicon
 * when any online session has pending permissions
 */
export const FaviconPermissionIndicator = React.memo(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') {
        return null;
    }

    const hasOnlineSessionWithPermissions = storage((state) => {
        // Asked of the channels, not read off the session: whether a session is being reached is
        // not a property the session carries, and the server's own flag says a session the LAN is
        // serving is away.
        const drivers = channelDrivers(state, state.localSettings.channelPriority);
        return Object.values(state.sessions).some(session => {
            const isOnline = resolveSessionReach(session.id, session.metadata?.machineId, drivers).online;

            const hasPermissions = session.agentState?.requests &&
                Object.keys(session.agentState.requests).length > 0;

            return isOnline && hasPermissions;
        });
    });

    React.useLayoutEffect(() => {
        if (hasOnlineSessionWithPermissions) {
            updateFaviconWithNotification();
        } else {
            resetFavicon();
        }
    }, [hasOnlineSessionWithPermissions]);

    React.useLayoutEffect(() => {
        return () => {
            resetFavicon();
        };
    }, []);

    return null;
});

FaviconPermissionIndicator.displayName = 'FaviconPermissionIndicator';