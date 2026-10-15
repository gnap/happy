import * as React from 'react';
import { Session } from '@/sync/storageTypes';
import { useDaemonSockets, useLanSessionList, useRestartingSessions } from '@/sync/storage';
import { sessionIsRestarting } from '@/utils/sessionRestart';
import { t } from '@/text';

export type SessionState = 'disconnected' | 'restarting' | 'thinking' | 'waiting' | 'permission_required';

export interface SessionStatus {
    state: SessionState;
    isConnected: boolean;
    /**
     * Whether this session should be drawn as one that is alive.
     *
     * Not the same question as `isConnected`, which is about a connection and is false during a
     * restart because there is none. This one is about the *appearance*: dimming a session and
     * greying its avatar is how a stopped session reads, and a restart in flight must not read
     * that way — the reader has just asked for it and is waiting for it to come back.
     */
    isLive: boolean;
    statusText: string;
    shouldShowStatus: boolean;
    statusColor: string;
    statusDotColor: string;
    isPulsing?: boolean;
}

/**
 * Get the current state of a session based on presence and thinking status.
 * Uses centralized session state from storage.ts
 */
export function useSessionStatus(session: Session): SessionStatus {
    /**
     * What the daemon that owns this session last said about it.
     *
     * Only ever populated when the server could not answer — and that is exactly the case this
     * matters in: `session.presence` is the server's view, so a session being read and written over
     * the LAN right now reads as "last seen 20 minutes ago" the moment the server goes quiet, which
     * is a page that contradicts the messages arriving on it.
     */
    const daemonSessions = useLanSessionList();
    /**
     * Whether a channel is carrying this session right now.
     *
     * The authority on that is the channel itself, and this is the check that gives it: while the
     * App holds a live connection to the machine that owns this session, the session is reachable,
     * whatever the server last said. The server's view is only consulted when nothing is connected
     * — it is a report about the past, and a report about the past must not overwrite what is
     * happening now.
     */
    const daemonSockets = useDaemonSockets();
    const machineId = session.metadata?.machineId;
    const servedNow = machineId
        ? Object.entries(daemonSockets).some(([key, socket]) => key.startsWith(`${machineId}:`) && socket.phase === 'live')
        : false;
    // Optional at every step: the store is empty until a daemon has answered, and a status line is
    // not worth a crash in the one case it exists for.
    const isOnline = session.presence === "online" || servedNow || daemonSessions?.[session.id]?.isAlive === true;
    const hasPermissions = (session.agentState?.requests && Object.keys(session.agentState.requests).length > 0 ? true : false);
    const restarting = useRestartingSessions();

    const vibingMessage = React.useMemo(() => {
        return vibingMessages[Math.floor(Math.random() * vibingMessages.length)].toLowerCase() + '…';
    }, [isOnline, hasPermissions, session.thinking]);

    if (!isOnline) {
        /**
         * A restart this App asked for is not an offline session, and the two look identical from
         * here: the session stops reporting, and "not reporting" is what an ended session looks
         * like too. The difference is that this App knows it asked, and while a restart could
         * still be running, saying one is happening is the honest thing to say.
         *
         * Only ever consulted here, for a session that is not reporting itself. A session that
         * answers again is drawn from what it says, whatever this App remembers asking.
         */
        if (sessionIsRestarting(session.id, restarting)) {
            return {
                state: 'restarting',
                isConnected: false,
                isLive: true,
                statusText: t('status.restarting'),
                shouldShowStatus: true,
                // The same blue as a session that is working: a restart is something happening, and
                // the grey that means "stopped" is the one thing it must not be mistaken for.
                statusColor: '#007AFF',
                statusDotColor: '#007AFF',
                isPulsing: true
            };
        }
        return {
            state: 'disconnected',
            isConnected: false,
            isLive: false,
            statusText: t('status.lastSeen', { time: formatLastSeen(session.activeAt, false) }),
            shouldShowStatus: true,
            statusColor: '#999',
            statusDotColor: '#999'
        };
    }

    // Check if permission is required
    if (hasPermissions) {
        return {
            state: 'permission_required',
            isConnected: true,
            isLive: true,
            statusText: t('status.permissionRequired'),
            shouldShowStatus: true,
            statusColor: '#FF9500',
            statusDotColor: '#FF9500',
            isPulsing: true
        };
    }

    if (session.thinking === true) {
        return {
            state: 'thinking',
            isConnected: true,
            isLive: true,
            statusText: vibingMessage,
            shouldShowStatus: true,
            statusColor: '#007AFF',
            statusDotColor: '#007AFF',
            isPulsing: true
        };
    }

    return {
        state: 'waiting',
        isConnected: true,
        isLive: true,
        statusText: t('status.online'),
        shouldShowStatus: false,
        statusColor: '#34C759',
        statusDotColor: '#34C759'
    };
}

/**
 * Extracts a display name from a session's metadata path.
 * Returns the last segment of the path, or 'unknown' if no path is available.
 */
export function getSessionName(session: Session): string {
    if (session.metadata?.summary) {
        return session.metadata.summary.text;
    } else if (session.metadata) {
        // Sentinel path used by the new-session placeholder to indicate the session
        // is still being created by the CLI; metadata will be replaced on next fetch.
        if (session.metadata.path === '​creating​') {
            return t('status.creating');
        }
        const segments = session.metadata.path.split('/').filter(Boolean);
        const lastSegment = segments.pop();
        if (!lastSegment) {
            return t('status.unknown');
        }
        return lastSegment;
    }
    return t('status.unknown');
}

/**
 * Generates a deterministic avatar ID from machine ID and path.
 * This ensures the same machine + path combination always gets the same avatar.
 */
export function getSessionAvatarId(session: Session): string {
    if (session.metadata?.machineId && session.metadata?.path) {
        // Combine machine ID and path for a unique, deterministic avatar
        return `${session.metadata.machineId}:${session.metadata.path}`;
    }
    // Fallback to session ID if metadata is missing
    return session.id;
}

/**
 * Formats a path relative to home directory if possible.
 * If the path starts with the home directory, replaces it with ~
 * Otherwise returns the full path.
 */
export function formatPathRelativeToHome(path: string, homeDir?: string): string {
    if (!homeDir) return path;
    
    // Normalize paths to handle trailing slashes
    const normalizedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
    const normalizedPath = path;
    
    // Check if path starts with home directory
    if (normalizedPath.startsWith(normalizedHome)) {
        // Replace home directory with ~
        const relativePath = normalizedPath.slice(normalizedHome.length);
        // Add ~ and ensure there's a / after it if needed
        if (relativePath.startsWith('/')) {
            return '~' + relativePath;
        } else if (relativePath === '') {
            return '~';
        } else {
            return '~/' + relativePath;
        }
    }
    
    return path;
}

/**
 * Returns the session path for the subtitle.
 */
export function getSessionSubtitle(session: Session): string {
    if (session.metadata) {
        const branch = session.metadata.branchName ?? session.metadata.worktreeBranch;
        if (branch) {
            return `⎇ ${branch}`;
        }
        return formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir);
    }
    return t('status.unknown');
}

/**
 * Checks if a session is currently online based on the active flag.
 * A session is considered online if the active flag is true.
 */
export function isSessionOnline(session: Session): boolean {
    return session.active;
}

/**
 * Checks if a session should be shown in the active sessions group.
 * Uses the active flag directly.
 */
export function isSessionActive(session: Session): boolean {
    return session.active;
}

/**
 * Formats OS platform string into a more readable format
 */
export function formatOSPlatform(platform?: string): string {
    if (!platform) return '';

    const osMap: Record<string, string> = {
        'darwin': 'macOS',
        'win32': 'Windows',
        'linux': 'Linux',
        'android': 'Android',
        'ios': 'iOS',
        'aix': 'AIX',
        'freebsd': 'FreeBSD',
        'openbsd': 'OpenBSD',
        'sunos': 'SunOS'
    };

    return osMap[platform.toLowerCase()] || platform;
}

/**
 * Formats the last seen time of a session into a human-readable relative time.
 * @param activeAt - Timestamp when the session was last active
 * @param isActive - Whether the session is currently active
 * @returns Formatted string like "Active now", "5 minutes ago", "2 hours ago", or a date
 */
export function formatLastSeen(activeAt: number, isActive: boolean = false): string {
    if (isActive) {
        return t('status.activeNow');
    }

    const now = Date.now();
    const diffMs = now - activeAt;
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSeconds < 60) {
        return t('time.justNow');
    } else if (diffMinutes < 60) {
        return t('time.minutesAgo', { count: diffMinutes });
    } else if (diffHours < 24) {
        return t('time.hoursAgo', { count: diffHours });
    } else if (diffDays < 7) {
        return t('sessionHistory.daysAgo', { count: diffDays });
    } else {
        // Format as date
        const date = new Date(activeAt);
        const options: Intl.DateTimeFormatOptions = {
            month: 'short',
            day: 'numeric',
            year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
        };
        return date.toLocaleDateString(undefined, options);
    }
}

/** Unread A2A inbox messages (from agentState.a2aInbox.unreadCount synced by CLI). */
export function getSessionA2AUnreadCount(session: Session): number {
    const count = session.agentState?.a2aInbox?.unreadCount;
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
        return 0;
    }
    return Math.floor(count);
}

const vibingMessages = ["Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing", "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing", "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering", "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering", "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting", "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting", "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching", "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring", "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering", "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating", "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating", "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking", "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering", "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring", "Wibbling", "Wizarding", "Working", "Wrangling"];