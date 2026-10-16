import * as React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { sync } from '@/sync/sync';
import { useLocalSearchParams } from 'expo-router';
import { Pressable } from 'react-native';
import { useAllMachines, storage, useLocalSettingMutable, useMachinePresenceMap, useMachineBadgeInputs, useLanEndpoints, useLanSightings, useDaemonSockets } from '@/sync/storage';
import { DEFAULT_CHANNEL_PRIORITY, normalizeChannelPriority } from '@/sync/lan/channelOrder';
import { candidateInputsFor, orderedCandidates } from '@/sync/channels/candidates';
import { candidateKey } from '@/sync/channels/health';
import type { DaemonRoute } from '@/sync/lan/types';
import { discoverMachines, accountFingerprintOf } from '@/sync/lan/discovery';
import { authenticate, fetchIdentity, fetchSessions, fetchHistory } from '@/sync/lan/client';
import { decryptLanHistory } from '@/sync/lan/history';

/**
 * Exercises the whole LAN path against a real daemon: browse `_happy._tcp`, authenticate with
 * the machine key, read a session's history and decrypt it.
 *
 * Deliberately reports every stage separately rather than one pass/fail, because the failure
 * modes are in different places — a browse that finds nothing, a machine key that has not been
 * fetched yet, a rejected proof and a key that will not unwrap all need different fixes. The
 * daemon must be running with HAPPY_LAN_ENABLED=1.
 */

/**
 * The order the App tries channels in — first at the top of the page, because it is the setting that
 * decides everything below it: which channel a session is read over, which one a machine is counted
 * as reachable on, and which glyph the badges draw.
 */
const ChannelPriorityGroup = React.memo(function ChannelPriorityGroup() {
    const [stored, setStored] = useLocalSettingMutable('channelPriority');
    const priority = normalizeChannelPriority(stored ?? DEFAULT_CHANNEL_PRIORITY);
    const move = (index: number, by: number) => {
        const next = [...priority];
        const target = index + by;
        if (target < 0 || target >= next.length) return;
        [next[index], next[target]] = [next[target], next[index]];
        setStored(next);
    };
    return (
        <ItemGroup title="Channel priority (first wins)" footer="The order every decision above the drivers' own state is made in.">
            {priority.map((channel, index) => (
                <Item
                    key={channel}
                    title={`${index + 1}. ${channel}`}
                    subtitle={index === 0 ? 'preferred' : channel === 'server' ? 'reaches every machine the server knows' : undefined}
                    showChevron={false}
                    rightElement={
                        <View style={{ flexDirection: 'row', gap: 12 }}>
                            <Pressable onPress={() => move(index, -1)} hitSlop={8}>
                                <Ionicons name="chevron-up" size={20} color={index === 0 ? '#888' : '#007AFF'} />
                            </Pressable>
                            <Pressable onPress={() => move(index, 1)} hitSlop={8}>
                                <Ionicons name="chevron-down" size={20} color={index === priority.length - 1 ? '#888' : '#007AFF'} />
                            </Pressable>
                        </View>
                    }
                />
            ))}
        </ItemGroup>
    );
});

/**
 * What the App believes about every machine, and why.
 *
 * The states are the ones the decisions are made from — presence, per-channel reach and capability,
 * the ordered candidates with what each address has done, and the sockets actually held — because a
 * badge that says "LAN" is the end of a chain, and the chain is what has to be visible when it is
 * wrong.
 */
const ChannelStateGroup = React.memo(function ChannelStateGroup({ machines }: { machines: { id: string; metadata?: { host?: string } | null }[] }) {
    const presence = useMachinePresenceMap();
    const badgeInputs = useMachineBadgeInputs();
    const endpoints = useLanEndpoints();
    const sightings = useLanSightings();
    const sockets = useDaemonSockets();
    const health = storage((state) => state.candidateHealth);

    return (
        <ItemGroup title="What the App believes" footer="presence · per-channel reach (r) and capability (c) · candidates with phase · sockets held">
            {machines.map((machine) => {
                const id = machine.id;
                const inputs = badgeInputs(id);
                const candidates = orderedCandidates(id, candidateInputsFor({ ...storage.getState(), candidateHealth: health }, id, {
                    now: Date.now(),
                    routes: ['lan', 'relay'],
                }));
                const held = Object.entries(sockets).filter(([key]) => key.startsWith(`${id}:`));
                const published = endpoints[id]?.baseUrls ?? [];
                const seen = sightings[id] ? 'yes' : 'no';
                return (
                    <Item
                        key={`state-${id}`}
                        title={`${machine.metadata?.host ?? id.slice(0, 8)} — ${presence[id] ?? 'offline'}`}
                        subtitle={[
                            `lan:${inputs.reach.lan ? 'r' : '-'}${inputs.capability.lan ? 'c' : '-'}`,
                            `relay:${inputs.reach.relay ? 'r' : '-'}${inputs.capability.relay ? 'c' : '-'}`,
                            `server:${inputs.reach.server ? 'r' : '-'}`,
                            `seen:${seen}`,
                            `pub:${published.length}`,
                            held.length > 0 ? `sock:${held.map(([k, v]) => `${k.split(':')[1]}=${v.phase}`).join(',')}` : 'sock:none',
                        ].join(' · ')}
                        detail={candidates.length === 0 ? 'no candidates' : candidates.map((candidate) => {
                            const state = health[candidateKey(candidate.machineId, candidate.route, candidate.baseUrl)];
                            const phase = state?.phase ?? 'unknown';
                            const retry = state?.retryAt ? ` retry:${Math.max(0, Math.round((state.retryAt - Date.now()) / 1000))}s` : '';
                            return `${candidate.route}/${candidate.source} ${candidate.baseUrl} ${phase}${retry}`;
                        }).join('\n')}
                        showChevron={false}
                    />
                );
            })}
        </ItemGroup>
    );
});

type LogLine = {
    stage: string;
    text: string;
    ok: boolean;
};

const line = (stage: string, text: string, ok = true): LogLine => ({ stage, text, ok });

const LanDevScreen = React.memo(function LanDevScreen() {
    const { theme } = useUnistyles();
    const machines = useAllMachines();
    const params = useLocalSearchParams<{ route?: string }>();
    const route: DaemonRoute = params.route === 'relay' ? 'relay' : 'lan';
    const [running, setRunning] = React.useState(false);
    const [lines, setLines] = React.useState<LogLine[]>([]);

    // The account content public key — the same one every session key is wrapped to, and the
    // input the daemon's account fingerprint is derived from.
    const accountPublicKey = sync.encryption?.contentDataKey;

    const run = React.useCallback(async () => {
        if (!accountPublicKey) {
            setLines([line('setup', 'sync.encryption is not ready — is the app signed in?', false)]);
            return;
        }

        setRunning(true);
        const log: LogLine[] = [];
        const push = (l: LogLine) => {
            log.push(l);
            setLines([...log]);
        };

        try {
            const fingerprint = await accountFingerprintOf(accountPublicKey);
            push(line('account', `fingerprint ${fingerprint}`));

            // ── Stage 1: find the daemon ─────────────────────────────────────────
            // LAN browses mDNS; the relay takes the routes machines published. Everything after
            // this point is the same protocol, which is the point of the relay being a peer route.
            let discovered: { machineId: string; baseUrl: string; serviceName: string }[];
            if (route === 'relay') {
                discovered = Object.values(storage.getState().relayEndpoints).map((endpoint) => ({
                    machineId: endpoint.machineId,
                    baseUrl: endpoint.baseUrl,
                    serviceName: `machine ${endpoint.machineId.slice(0, 8)}`,
                }));
                if (discovered.length === 0) {
                    push(line('discover', 'no machine has published a relay route (set HAPPY_RELAY_URL on the daemon)', false));
                    return;
                }
                // What the relay itself says it is holding, rather than a probe: a machine that
                // dialled in is there, and one that did not is not — there is nothing to interpret.
                const directory = storage.getState().relayDirectory;
                for (const machine of discovered) {
                    const entry = directory[machine.machineId];
                    push(line('discover', `${machine.serviceName} -> ${machine.baseUrl} (${entry ? `relay holds it, ${entry.sessions.length} session(s)` : 'the relay is not holding it'})`, !!entry));
                }
            } else {
                discovered = await discoverMachines({ accountPublicKey });
                if (discovered.length === 0) {
                    push(line('discover', 'no _happy._tcp machines found for this account', false));
                    push(line('discover', 'is the daemon running with HAPPY_LAN_ENABLED=1, and the local network permission granted?', false));
                    return;
                }
                for (const machine of discovered) {
                    push(line('discover', `${machine.serviceName} -> ${machine.baseUrl}`));
                }
            }

            // ── Stage 2: authenticate ────────────────────────────────────────────
            const target = discovered[0];
            const machineKey = sync.getMachineKey(target.machineId);
            if (!machineKey) {
                push(line('auth', `no machine key for ${target.machineId} — machine records not fetched yet`, false));
                return;
            }

            const { token } = await authenticate(target.baseUrl, machineKey);
            push(line('auth', `authenticated against ${target.baseUrl}`));

            const identity = await fetchIdentity(target.baseUrl, token);
            push(line('auth', `identity: ${identity.hostname} (${identity.platform}), machine ${identity.machineId}`));

            // ── Stage 3: list sessions ───────────────────────────────────────────
            const sessions = await fetchSessions(target.baseUrl, token);
            push(line('sessions', `${sessions.length} session(s) reported by the daemon`));

            // ── Stage 4: fetch and decrypt history ───────────────────────────────
            let decryptedAny = false;
            const seenHistory = new Set<string>();
            for (const session of sessions) {
                const history = await fetchHistory(target.baseUrl, token, session.happySessionId);
                if (!history) {
                    push(line('history', `${session.happySessionId}: no local history (404)`));
                    continue;
                }
                const decrypted = await decryptLanHistory(sync.encryption!, history);
                decryptedAny = true;
                seenHistory.add(session.happySessionId);
                push(line(
                    'history',
                    `${session.happySessionId}: ${decrypted.decryptedCount}/${decrypted.entries.length} decrypted, tag ${decrypted.tag}`
                ));
                const preview = decrypted.entries.find((entry) => entry.content !== null);
                if (preview) {
                    const ev = (preview.content as any)?.content?.ev;
                    const label = ev?.t ?? (preview.content as any)?.content?.type ?? '?';
                    push(line('history', `  first [${preview.dir}] ${label}`));
                }
            }
            if (!decryptedAny) {
                push(line('history', 'no session had local history on that machine', false));
            }

            // ── Stage 5: feed it through the app's real path ─────────────────────
            // The stages above use the LAN client directly. This one goes through the same
            // `Sync.fetchSessionFromDaemon` a channel switch would use, so what it exercises is the
            // production path — normalization, dedup against the store, and the reducer — rather
            // than a parallel implementation that could pass while the real one is broken.
            const mergeTarget = sessions.find((s) => seenHistory.has(s.happySessionId));
            if (mergeTarget) {
                const read = await sync.fetchSessionFromDaemon(mergeTarget.happySessionId, route);
                if (!read) {
                    push(line('merge', 'fetchSessionFromDaemon found nothing to read', false));
                } else {
                    const stored = storage.getState().sessionMessages[mergeTarget.happySessionId]?.messages.length ?? 0;
                    push(line(
                        'merge',
                        `${read.messages.length} normalized, ${read.decryptedCount}/${read.total} decrypted → store now holds ${stored} message(s)`
                    ));
                }
            }

            push(line('done', `${route === 'relay' ? 'Relay' : 'LAN'} round trip complete`));
        } catch (error) {
            push(line('error', String(error), false));
        } finally {
            setRunning(false);
        }
    }, [accountPublicKey]);

    return (
        <ItemList>
            <ChannelPriorityGroup />
            <ChannelStateGroup machines={machines} />
            <ItemGroup
                title={route === 'relay' ? 'Relay API' : 'LAN API'}
                footer={route === 'relay'
                    ? "Runs the same daemon API through the public relay. The daemon must be started with HAPPY_RELAY_URL."
                    : "Runs against the CLI daemon's read-only LAN API. It must be started with HAPPY_LAN_ENABLED=1."}
            >
                <Item
                    title={route === 'relay' ? 'Run relay round trip' : 'Run LAN round trip'}
                    subtitle={route === 'relay' ? 'cached route → authenticate → read history → decrypt' : 'discover → authenticate → read history → decrypt'}
                    icon={<Ionicons name={route === 'relay' ? 'swap-horizontal' : 'wifi-outline'} size={28} color={route === 'relay' ? '#AF52DE' : '#007AFF'} />}
                    onPress={run}
                    showChevron={false}
                    rightElement={running ? <ActivityIndicator size="small" /> : undefined}
                />
                <Item
                    title="Account fingerprint"
                    detail={sync.encryption ? 'computed on run' : 'encryption not ready'}
                    showChevron={false}
                />
                <Item
                    title="Known machines"
                    detail={`${machines.length}`}
                    showChevron={false}
                />
            </ItemGroup>

            {lines.length > 0 && (
                <ItemGroup title="Log">
                    <View style={styles.log}>
                        {lines.map((l, index) => (
                            <View key={index} style={styles.logRow}>
                                <Ionicons
                                    name={l.ok ? 'checkmark-circle-outline' : 'alert-circle-outline'}
                                    size={14}
                                    color={l.ok ? '#34C759' : '#FF3B30'}
                                    style={styles.logIcon}
                                />
                                <Text style={[styles.logText, { color: theme.colors.text }]} selectable>
                                    <Text style={styles.logStage}>{l.stage} </Text>
                                    {l.text}
                                </Text>
                            </View>
                        ))}
                    </View>
                </ItemGroup>
            )}
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    log: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 6,
    },
    logRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    logIcon: {
        marginTop: 2,
        marginRight: 6,
    },
    logText: {
        flex: 1,
        fontSize: 12,
        fontFamily: 'Menlo',
    },
    logStage: {
        fontWeight: '700',
    },
}));

export default LanDevScreen;
