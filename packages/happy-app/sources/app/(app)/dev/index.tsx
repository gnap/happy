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
import { useDaemonSocketStatus, useLanSightings, useLocalSettingMutable, useRelayEndpoints, useRelaySightings, useSocketStatus } from '@/sync/storage';
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

export default function DevScreen() {
    const router = useRouter();
    const [debugMode, setDebugMode] = useLocalSettingMutable('debugMode');
    const [verboseLogging, setVerboseLogging] = React.useState(false);
    const socketStatus = useSocketStatus();
    const lanSocketStatus = useDaemonSocketStatus('lan');
    const relaySocketStatus = useDaemonSocketStatus('relay');
    const lanSightingCount = Object.keys(useLanSightings()).length;
    const [channelPriority] = useLocalSettingMutable('channelPriority');
    const rates = useMetricRates();
    const [relayUrl, setRelayUrl] = useLocalSettingMutable('relayUrl');
    const fetchPool = useFetchPoolStats();
    const relayRouteCount = Object.keys(useRelayEndpoints()).length;
    const relaySightingCount = Object.keys(useRelaySightings()).length;
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

    // Helper function to format time ago
    const formatTimeAgo = (timestamp: number | null): string => {
        if (!timestamp) return '';

        const now = Date.now();
        const diff = now - timestamp;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (seconds < 10) return 'Just now';
        if (seconds < 60) return `${seconds}s ago`;
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;

        return new Date(timestamp).toLocaleDateString();
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
                    title="LAN Discovery"
                    subtitle={lanSightingCount > 0
                        ? `${lanSightingCount} daemon${lanSightingCount === 1 ? '' : 's'} advertising on this network`
                        : 'No daemon advertising on this network'}
                    detail={String(lanSightingCount)}
                    rightElement={lanSightingCount > 0
                        ? <Ionicons name="checkmark-circle" size={22} color="#34C759" />
                        : <Ionicons name="close-circle" size={22} color="#8E8E93" />}
                    showChevron={false}
                />
                <Item
                    title="LAN Socket"
                    subtitle={lanSocketStatus
                        ? `${lanSocketStatus.baseUrl} · up ${formatTimeAgo(lanSocketStatus.connectedAt)}`
                        : 'Idle — opens when a session here can use it'}
                    detail={lanSocketStatus ? 'live' : 'idle'}
                    rightElement={lanSocketStatus
                        ? <Ionicons name="checkmark-circle" size={22} color="#34C759" />
                        : <Ionicons name="ellipse-outline" size={22} color="#8E8E93" />}
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
                <Item
                    title="Relay URL"
                    subtitle={relayUrl
                        ? 'Used to reach a machine with the server down, by deriving each machine\'s route from its key'
                        : 'Not set — with the server off there is no relay route to try'}
                    detail={relayUrl ?? 'unset'}
                    icon={<Ionicons name="link-outline" size={28} color="#AF52DE" />}
                    onPress={async () => {
                        const entered = await Modal.prompt('Relay URL', 'Base URL of the public relay, e.g. https://relay.example', {
                            defaultValue: relayUrl ?? '',
                            placeholder: 'https://relay.example',
                        });
                        if (entered === null) {
                            return; // cancelled
                        }
                        setRelayUrl(entered.trim() || null);
                        // Routes are derived once at startup, so ask for them again now rather than
                        // making the change wait for the next launch.
                        void sync.deriveRelayRoutes();
                    }}
                />
                <Item
                    title="Relay Routes"
                    subtitle={relayRouteCount === 0
                        ? 'No machine has published a relay route yet'
                        : `${relaySightingCount} of ${relayRouteCount} route${relayRouteCount === 1 ? '' : 's'} answering a probe`}
                    detail={`${relaySightingCount}/${relayRouteCount}`}
                    rightElement={relaySightingCount > 0
                        ? <Ionicons name="checkmark-circle" size={22} color="#34C759" />
                        : <Ionicons name="close-circle" size={22} color="#8E8E93" />}
                    showChevron={false}
                />
                <Item
                    title="Relay Socket"
                    subtitle={relaySocketStatus
                        ? `${relaySocketStatus.baseUrl} · up ${formatTimeAgo(relaySocketStatus.connectedAt)}`
                        : 'Idle — opens while the server is down or a session is pinned to the relay'}
                    detail={relaySocketStatus ? 'live' : 'idle'}
                    rightElement={relaySocketStatus
                        ? <Ionicons name="checkmark-circle" size={22} color="#34C759" />
                        : <Ionicons name="ellipse-outline" size={22} color="#8E8E93" />}
                    showChevron={false}
                />
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
