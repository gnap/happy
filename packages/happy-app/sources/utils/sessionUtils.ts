import * as React from 'react';
import { Session } from '@/sync/storageTypes';
import { useResolvedPermissionIds, useSessionOnline, useSessionRuntimeEntry } from '@/sync/storage';
import { sessionIsRestarting } from '@/utils/sessionRestart';
import { sessionRuntimeDisplay, type SessionRuntimeDisplay } from '@/utils/sessionRuntimeStatus';
import { t } from '@/text';

export type SessionState = 'disconnected' | 'restarting' | 'applying' | 'blocked' | 'thinking' | 'waiting' | 'permission_required';

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
    // Whether anything is reaching it, and over which channel — asked once, of every channel this
    // device has, rather than worked out here from the particular channel state this file happened
    // to know about. The server's view is consulted only when nothing nearer can answer: it is a
    // report about the past, and a report about the past must not overwrite what is happening now.
    const isOnline = useSessionOnline(session.id, session.metadata?.machineId);
    // The server's list of unanswered requests, minus the ones the message stream has seen
    // answered. The two disagree while the server cannot acknowledge the removal — exactly the
    // window in which this row would otherwise keep saying "permission required" after the user
    // has answered. Where the log has not been loaded the set is empty and this reads as before.
    const resolvedPermissions = useResolvedPermissionIds(session.id);
    // What the owning machine says it is doing with this session's lifecycle: a restart or an
    // archive on its way, or one it gave up on. The machine is the only party that knows a want
    // it accepted has not been realized — the session's own socket can stay up through a restart,
    // and an archived session has no socket at all to ask.
    const runtimeDisplay = sessionRuntimeDisplay(useSessionRuntimeEntry(session.id));
    const requests = session.agentState?.requests;
    const hasPermissions = requests
        ? Object.keys(requests).some(id => !resolvedPermissions.has(id))
        : false;

    const vibingMessage = React.useMemo(() => {
        return vibingMessages[Math.floor(Math.random() * vibingMessages.length)].toLowerCase() + '…';
    }, [isOnline, hasPermissions, session.thinking]);

    /**
     * A restart in flight, which the machine announces as a change to this session's state and
     * calls off when the new process is up.
     *
     * Asked before anything else, and deliberately not only for a session that looks offline: a
     * restart does not stop the App reaching the session — the socket it holds is the machine's,
     * and stays up across the swap — so "is anything reaching it" stays true the whole way through
     * and this would never be reached. Nothing else can see the swap, which is why the machine says
     * it, and why it is believed rather than inferred.
     */
    if (sessionIsRestarting(session)) {
        return {
            state: 'restarting',
            isConnected: isOnline,
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

    /**
     * A want the machine accepted and has not realized.
     *
     * Drawn before the connectivity answer because it is a stronger statement about the same
     * session: a restart makes the session unreadable for a moment, and an archive is *supposed*
     * to end its connection, so neither should read as "last seen". A blocked want is drawn even
     * when nothing is reaching the session, but not as alive: the machine is not working on it
     * any more, and dimming it is what says so.
     */
    if (runtimeDisplay !== undefined) {
        const blocked = runtimeDisplay.kind === 'blocked';
        return {
            state: blocked ? 'blocked' : 'applying',
            isConnected: isOnline,
            isLive: blocked ? isOnline : true,
            statusText: sessionRuntimeStatusText(runtimeDisplay),
            shouldShowStatus: true,
            statusColor: blocked ? '#FF3B30' : '#007AFF',
            statusDotColor: blocked ? '#FF3B30' : '#007AFF',
            isPulsing: !blocked
        };
    }

    if (!isOnline) {
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
 * The words a machine's runtime statement is drawn with, for the row and the details page alike.
 *
 * A blocked want names what failed rather than saying "stuck": "could not start" tells the reader
 * which action to retry, where "reconciliation blocked" would only tell them the daemon has a
 * vocabulary. A newer machine may name a lifecycle this build does not know, and the general
 * wording is the honest answer there — never "start" or "archive" guessed from a word we lack.
 */
export function sessionRuntimeStatusText(display: SessionRuntimeDisplay): string {
    if (display.kind === 'blocked') {
        if (display.desired === 'archived') return t('status.couldNotArchive');
        if (display.desired === 'running') return t('status.couldNotStart');
        return t('status.couldNotApply');
    }
    if (display.desired === 'archived') return t('status.archiving');
    if (display.desired === 'running') return t('status.restarting');
    return t('status.applying');
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