import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import { metrics, ratesSince, type MetricRates } from '@/sync/metrics';
import type { DaemonConnectionState } from '@/sync/lan/daemonConnections';
import { useDaemonSockets, useLanSightings, useLocalSettingMutable, useRelayDirectory, useRelayHubConnected, useRelayUnknownTags, useSocketStatus } from '@/sync/storage';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { getServerUrl, setServerUrl, validateServerUrl } from '@/sync/serverConfig';
import { Switch } from '@/components/Switch';
import { useUnistyles } from 'react-native-unistyles';
import { setLastViewedVersion, getLatestVersion } from '@/changelog';

/** One decimal for small rates, none for large: enough to tell "idle" from "working". */
function formatRate(rate: number | undefined): string {
    if (rate === undefined) return '·';
    return rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);
}

/**
 * The channel's state for whatever session is open, sampled like the rest.
 *
 * The point is to answer "why is this conversation missing messages" without guessing: whether the
 * window covers the session, where the reader has read to, and where pushes have carried it.
 */
function useChannelDiagnostics(): ReturnType<typeof sync.channelDiagnostics> {
    const [state, setState] = React.useState<ReturnType<typeof sync.channelDiagnostics>>(null);
    React.useEffect(() => {
        const sample = () => setState(sync.channelDiagnostics(sync.currentVisibleSessionId));
        sample();
        const timer = setInterval(sample, 1_000);
        return () => clearInterval(timer);
    }, []);
    return state;
}

/**
 * The fetch pool, sampled with the same beat as the counters. Fetches that never release are what
 * stop a session refreshing after a suspension, and they are invisible from the outside: this is
 * what makes them show up as a number rather than as "the app is being weird".
 */
function useFetchPoolStats(): { inFlight: number; queued: number; oldestMs: number } | null {
    const [stats, setStats] = React.useState<{ inFlight: number; queued: number; oldestMs: number } | null>(null);
    React.useEffect(() => {
        const sample = () => setStats(sync.fetchSlotStats());
        sample();
        const timer = setInterval(sample, 1_000);
        return () => clearInterval(timer);
    }, []);
    return stats;
}

/**
 * Samples the sync counters once a second and reports per-second rates.
 *
 * Rates rather than totals: a total says how long the App has been running, a rate says what it is
 * doing now — which is the question a device that gets warm raises.
 */
function useMetricRates(): MetricRates | null {
    const [rates, setRates] = React.useState<MetricRates | null>(null);
    React.useEffect(() => {
        let previous = { ...metrics };
        let at = Date.now();
        const timer = setInterval(() => {
            const now = Date.now();
            setRates(ratesSince(previous, metrics, now - at));
            previous = { ...metrics };
            at = now;
        }, 1_000);
        return () => clearInterval(timer);
    }, []);
    return rates;
}

/** How long ago, for a timestamp that may be missing. */
function formatTimeAgo(timestamp: number | null | undefined): string {
    if (!timestamp) {
        return '';
    }
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 10) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return days < 7 ? `${days}d ago` : new Date(timestamp).toLocaleDateString();
}

/** The same indicator for every channel's connection state, so the rows can be compared. */
const PhaseIndicator = React.memo(function PhaseIndicator({ phase }: { phase: DaemonConnectionState['phase'] }) {
    const { theme } = useUnistyles();
    switch (phase) {
        case 'live':
            return <Ionicons name="checkmark-circle" size={22} color="#34C759" />;
        case 'opening':
            return <ActivityIndicator size="small" color={theme.colors.textSecondary} />;
        case 'retrying':
            return <Ionicons name="close-circle" size={22} color="#FF9500" />;
        default:
            return <Ionicons name="ellipse-outline" size={22} color="#8E8E93" />;
    }
});

/** What a set of connections amounts to, for a row that speaks for the whole route. */
function aggregatePhase(connections: DaemonConnectionState[]): DaemonConnectionState['phase'] {
    if (connections.some((state) => state.phase === 'live')) return 'live';
    if (connections.some((state) => state.phase === 'opening')) return 'opening';
    if (connections.some((state) => state.phase === 'retrying')) return 'retrying';
    return 'idle';
}

/** What a connection is doing, in words short enough for a row. */
function describePhase(state: DaemonConnectionState): string {
    switch (state.phase) {
        case 'live':
            return `up ${formatTimeAgo(state.connectedAt)}`;
        case 'retrying':
            return `dropped ${state.attempt ?? 0}×`;
        default:
            return state.phase;
    }
}

/** The relay itself: one connection, and what it is holding. */
const RelayRow = React.memo(function RelayRow({
    enabled,
    connected,
    address,
    machines,
    sessions,
}: {
    enabled: boolean;
    connected: boolean;
    address: string;
    machines: number;
    sessions: number;
}) {
    // Three situations that used to look identical — not switched on, not yet reached, reachable —
    // and telling them apart is the difference between a setting and a fault.
    const subtitle = !enabled
        ? 'Switched off in Channel Priority'
        : connected
            ? `${address} · ${machines} machine${machines === 1 ? '' : 's'} · ${sessions} session${sessions === 1 ? '' : 's'}`
            : `Connecting to ${address}…`;
    return (
        <Item
            title="Relay"
            subtitle={subtitle}
            detail={!enabled ? 'off' : connected ? 'connected' : 'idle'}
            rightElement={!enabled
                ? <Ionicons name="remove-circle" size={22} color="#8E8E93" />
                : <PhaseIndicator phase={connected ? 'live' : 'opening'} />}
            showChevron={false}
        />
    );
});

/** A tag the relay holds that no key on this device matches. */
const RelayUnknownRow = React.memo(function RelayUnknownRow({ tag }: { tag: string }) {
    return (
        <Item
            title={`Relay · ${tag.slice(0, 8)}`}
            subtitle="Held by the relay, but this device has no key for it"
            detail="no key"
            rightElement={<Ionicons name="help-circle" size={22} color="#FF9500" />}
            showChevron={false}
        />
    );
});

export default function DevScreen() {
    const router = useRouter();
    const [debugMode, setDebugMode] = useLocalSettingMutable('debugMode');
    const [verboseLogging, setVerboseLogging] = React.useState(false);
    const socketStatus = useSocketStatus();
    const daemonSockets = useDaemonSockets();
    const lanSightingCount = Object.keys(useLanSightings()).length;
    const lanConnections = Object.values(daemonSockets).filter((state) => state.route === 'lan');
    const lanConnectedCount = lanConnections.filter((state) => state.phase === 'live').length;
    const lanPhase = aggregatePhase(lanConnections);
    const [channelPriority] = useLocalSettingMutable('channelPriority');
    const rates = useMetricRates();
    const fetchPool = useFetchPoolStats();
    const diagnostics = useChannelDiagnostics();
    const relayDirectory = useRelayDirectory();
    const relayUnknownTags = useRelayUnknownTags();
    const relayHubConnected = useRelayHubConnected();
    const relayEnabled = channelPriority.includes('relay');
    const anonymousId = sync.encryption!.anonID;
    const { theme } = useUnistyles();

    const handleEditServerUrl = async () => {
        const currentUrl = getServerUrl();

        const newUrl = await Modal.prompt(
            'Edit API Endpoint',
            'Enter the server URL:',
            {
                defaultValue: currentUrl,
                confirmText: 'Save'
            }
        );

        if (newUrl && newUrl !== currentUrl) {
            const validation = validateServerUrl(newUrl);
            if (validation.valid) {
                setServerUrl(newUrl);
                Modal.alert('Success', 'Server URL updated. Please restart the app for changes to take effect.');
            } else {
                Modal.alert('Invalid URL', validation.error || 'Please enter a valid URL');
            }
        }
    };

    const handleClearCache = async () => {
        const confirmed = await Modal.confirm(
            'Clear Cache',
            'Are you sure you want to clear all cached data?',
            { confirmText: 'Clear', destructive: true }
        );
        if (confirmed) {
            console.log('Cache cleared');
            Modal.alert('Success', 'Cache has been cleared');
        }
    };

    // Helper function to get socket status subtitle
    const getSocketStatusSubtitle = (): string => {
        const { status, lastConnectedAt, lastDisconnectedAt } = socketStatus;

        if (status === 'connected' && lastConnectedAt) {
            return `Connected ${formatTimeAgo(lastConnectedAt)}`;
        } else if ((status === 'disconnected' || status === 'error') && lastDisconnectedAt) {
            return `Last connected ${formatTimeAgo(lastDisconnectedAt)}`;
        } else if (status === 'connecting') {
            return 'Connecting to server...';
        }

        return 'No connection info';
    };

    // Socket status indicator component
    const SocketStatusIndicator = () => {
        switch (socketStatus.status) {
            case 'connected':
                return <Ionicons name="checkmark-circle" size={22} color="#34C759" />;
            case 'connecting':
                return <ActivityIndicator size="small" color={theme.colors.textSecondary} />;
            case 'error':
                return <Ionicons name="close-circle" size={22} color="#FF3B30" />;
            case 'disconnected':
                return <Ionicons name="close-circle" size={22} color="#FF9500" />;
            default:
                return <Ionicons name="help-circle" size={22} color="#8E8E93" />;
        }
    };

    const relayMachineCount = Object.keys(relayDirectory).length + relayUnknownTags.length;
    const relaySessionCount = Object.values(relayDirectory).reduce((total, entry) => total + entry.sessions.length, 0);

    return (
        <ItemList>
            {/* App Information */}
            <ItemGroup title="App Information">
                <Item
                    title="Version"
                    detail={Constants.expoConfig?.version || '1.0.0'}
                />
                <Item
                    title="Build Number"
                    detail={Application.nativeBuildVersion || 'N/A'}
                />
                <Item
                    title="SDK Version"
                    detail={Constants.expoConfig?.sdkVersion || 'Unknown'}
                />
                <Item
                    title="Platform"
                    detail={`${Constants.platform?.ios ? 'iOS' : 'Android'} ${Constants.systemVersion || ''}`}
                />
                <Item
                    title="Anonymous ID"
                    detail={anonymousId}
                />
            </ItemGroup>

            {/* Debug Options */}
            <ItemGroup title="Debug Options">
                <Item
                    title="Debug Mode"
                    rightElement={
                        <Switch
                            value={debugMode}
                            onValueChange={setDebugMode}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title="Verbose Logging"
                    subtitle="Log all network requests and responses"
                    rightElement={
                        <Switch
                            value={verboseLogging}
                            onValueChange={setVerboseLogging}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title="View Logs"
                    icon={<Ionicons name="document-text-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/logs')}
                />
            </ItemGroup>

            {/* Component Demos */}
            <ItemGroup title="Component Demos">
                <Item
                    title="Device Info"
                    subtitle="Safe area insets and device parameters"
                    icon={<Ionicons name="phone-portrait-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/device-info')}
                />
                <Item
                    title="List Components"
                    subtitle="Demo of Item, ItemGroup, and ItemList"
                    icon={<Ionicons name="list-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/list-demo')}
                />
                <Item
                    title="Typography"
                    subtitle="All typography styles"
                    icon={<Ionicons name="text-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/typography')}
                />
                <Item
                    title="Colors"
                    subtitle="Color palette and themes"
                    icon={<Ionicons name="color-palette-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/colors')}
                />
                <Item
                    title="Message Demos"
                    subtitle="Various message types and components"
                    icon={<Ionicons name="chatbubbles-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/messages-demo')}
                />
                <Item
                    title="Inverted List Test"
                    subtitle="Test inverted FlatList with keyboard"
                    icon={<Ionicons name="swap-vertical-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/inverted-list')}
                />
                <Item
                    title="Tool Views"
                    subtitle="Tool call visualization components"
                    icon={<Ionicons name="construct-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/tools2')}
                />
                <Item
                    title="Shimmer View"
                    subtitle="Shimmer loading effects with masks"
                    icon={<Ionicons name="sparkles-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/shimmer-demo')}
                />
                <Item
                    title="Multi Text Input"
                    subtitle="Auto-growing multiline text input"
                    icon={<Ionicons name="create-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/multi-text-input')}
                />
                <Item
                    title="Input Styles"
                    subtitle="10+ different input field style variants"
                    icon={<Ionicons name="color-palette-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/input-styles')}
                />
                <Item
                    title="Modal System"
                    subtitle="Alert, confirm, and custom modals"
                    icon={<Ionicons name="albums-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/modal-demo')}
                />
                <Item
                    title="Unit Tests"
                    subtitle="Run tests in the app environment"
                    icon={<Ionicons name="flask-outline" size={28} color="#34C759" />}
                    onPress={() => router.push('/dev/tests')}
                />
                <Item
                    title="Timeline Clustering"
                    subtitle="Debug task timeline clustering logic"
                    icon={<Ionicons name="git-branch-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/timeline-demo')}
                />
                <Item
                    title="Unistyles Demo"
                    subtitle="React Native Unistyles features and capabilities"
                    icon={<Ionicons name="brush-outline" size={28} color="#FF6B6B" />}
                    onPress={() => router.push('/dev/unistyles-demo')}
                />
                <Item
                    title="QR Code Test"
                    subtitle="Test QR code generation with different parameters"
                    icon={<Ionicons name="qr-code-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/qr-test')}
                />
            </ItemGroup>

            {/* Test Features */}
            <ItemGroup title="Test Features" footer="These actions may affect app stability">
                <Item
                    title="Claude OAuth Test"
                    subtitle="Test Claude authentication flow"
                    icon={<Ionicons name="key-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/settings/connect/claude')}
                />
                <Item
                    title="Test Crash"
                    subtitle="Trigger a test crash"
                    destructive={true}
                    icon={<Ionicons name="warning-outline" size={28} color="#FF3B30" />}
                    onPress={async () => {
                        const confirmed = await Modal.confirm(
                            'Test Crash',
                            'This will crash the app. Continue?',
                            { confirmText: 'Crash', destructive: true }
                        );
                        if (confirmed) {
                            throw new Error('Test crash triggered from dev menu');
                        }
                    }}
                />
                <Item
                    title="Clear Cache"
                    subtitle="Remove all cached data"
                    icon={<Ionicons name="trash-outline" size={28} color="#FF9500" />}
                    onPress={handleClearCache}
                />
                <Item
                    title="Reset Changelog"
                    subtitle="Show 'What's New' banner again"
                    icon={<Ionicons name="sparkles-outline" size={28} color="#007AFF" />}
                    onPress={() => {
                        // Set to latest - 1 so it shows as unread
                        // (setting to 0 triggers first-install logic that auto-marks as read)
                        const latest = getLatestVersion();
                        setLastViewedVersion(Math.max(0, latest - 1));
                        Modal.alert('Done', 'Changelog reset. Restart app to see the banner.');
                    }}
                />
                <Item
                    title="Reset App State"
                    subtitle="Clear all user data and preferences"
                    destructive={true}
                    icon={<Ionicons name="refresh-outline" size={28} color="#FF3B30" />}
                    onPress={async () => {
                        const confirmed = await Modal.confirm(
                            'Reset App',
                            'This will delete all data. Are you sure?',
                            { confirmText: 'Reset', destructive: true }
                        );
                        if (confirmed) {
                            console.log('App state reset');
                        }
                    }}
                />
            </ItemGroup>

            {/* System */}
            <ItemGroup title="System">
                <Item
                    title="Purchases"
                    subtitle="View subscriptions and entitlements"
                    icon={<Ionicons name="card-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/purchases')}
                />
                <Item
                    title="Expo Constants"
                    subtitle="View expoConfig, manifests, and system constants"
                    icon={<Ionicons name="information-circle-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/expo-constants')}
                />
            </ItemGroup>

            {/* Load: what the sync engine is doing right now, which is what a warm device is
                usually asking about. Counters, not a profiler — small enough to leave on. */}
            <ItemGroup title="Load">
                <Item
                    title="Store writes"
                    subtitle={`${formatRate(rates?.storeWrites)} writes/s · ${formatRate(rates?.messagesApplied)} messages/s applied`}
                    showChevron={false}
                />
                <Item
                    title="Daemon channel"
                    subtitle={`${formatRate(rates?.socketFrames)} socket frames/s · ${formatRate(rates?.entriesDecrypted)} entries/s decrypted`}
                    showChevron={false}
                />
                <Item
                    title="Message cache"
                    subtitle={rates
                        ? `${formatRate(rates.cacheSaves)} saves/s · ${(rates.cacheBytes / 1024).toFixed(1)} KB/s of state serialised`
                        : 'sampling…'}
                    showChevron={false}
                />
                <Item
                    title="Open session channel"
                    subtitle={diagnostics
                        ? `${diagnostics.channel} · window ${diagnostics.window} · ${diagnostics.hasOlder ? 'older available' : 'complete'}`
                        : 'No session is open'}
                    detail={diagnostics
                        ? `head ${diagnostics.logHead ?? '—'} · read ${diagnostics.readTo ?? '—'} · pushed ${diagnostics.pushedTo ?? '—'}`
                        : undefined}
                    showChevron={false}
                />
                <Item
                    title="Fetch pool"
                    subtitle={fetchPool
                        ? `${fetchPool.inFlight}/5 in flight · ${fetchPool.queued} queued${fetchPool.oldestMs > 5_000 ? ` · oldest held ${(fetchPool.oldestMs / 1000).toFixed(0)}s` : ''}`
                        : 'sampling…'}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Network */}
            <ItemGroup
                title="Network"
                footer="Reachability and use are different things: a daemon can be advertising while no session is using it — the socket only opens for a session whose machine is on this network and whose CLI declared it can serve one. So an idle socket is not a broken one."
            >
                <Item
                    title="API Endpoint"
                    detail={getServerUrl()}
                    onPress={handleEditServerUrl}
                />
                <Item
                    title="Server Socket"
                    subtitle={getSocketStatusSubtitle()}
                    detail={socketStatus.status}
                    rightElement={<SocketStatusIndicator />}
                    showChevron={false}
                />
                <Item
                    title="LAN"
                    subtitle={lanSightingCount === 0
                        ? 'No daemon advertising on this network'
                        : `${lanSightingCount} advertising · ${lanConnectedCount} connected`}
                    detail={lanPhase}
                    rightElement={<PhaseIndicator phase={lanSightingCount === 0 ? 'idle' : lanPhase} />}
                    showChevron={false}
                />
                <Item
                    title="LAN Round Trip"
                    subtitle="Discover a local daemon, authenticate, read and decrypt history"
                    icon={<Ionicons name="wifi-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/lan')}
                />
                <Item
                    title="Channel Priority"
                    subtitle="Enable, disable and reorder LAN / Relay / Server"
                    detail={channelPriority.map((c) => c === 'lan' ? 'LAN' : c === 'relay' ? 'Relay' : 'Server').join(' › ')}
                    icon={<Ionicons name="git-branch-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/channels')}
                />
                <RelayRow
                    enabled={relayEnabled}
                    connected={relayHubConnected}
                    address={sync.relayAddress()}
                    machines={relayMachineCount}
                    sessions={relaySessionCount}
                />
                {relayUnknownTags.map((tag) => (
                    <RelayUnknownRow key={tag} tag={tag} />
                ))}
                <Item
                    title="Relay Round Trip"
                    subtitle="Through the public relay: authenticate, list sessions, read and decrypt history"
                    icon={<Ionicons name="swap-horizontal" size={28} color="#AF52DE" />}
                    onPress={() => router.push('/dev/lan?route=relay')}
                />
            </ItemGroup>
        </ItemList>
    );
}
