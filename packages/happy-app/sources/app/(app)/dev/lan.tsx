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
import { useAllMachines, storage, useMachineBadgeInputs, useLanSightings, useLanEndpoints, useDaemonSockets, useChannelLinks, useRelayDirectory } from '@/sync/storage';
import type { SessionChannel } from '@/sync/lan/types';
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
 * One channel: what it is doing, what it is connected to, and — at the bottom — what it is set to.
 *
 * The three belong together because they are the same subject: a channel's settings decide its
 * connections and its connections are its liveness. Splitting them into page-wide sections made the
 * reader hold a machine in their head while scrolling to another part of the page to find its
 * address.
 */
export const ChannelBlock = React.memo(function ChannelBlock({ channel, liveness, children }: { channel: SessionChannel; liveness?: React.ReactNode; children?: React.ReactNode }) {
    const { theme } = useUnistyles();
    const machines = useAllMachines();
    const links = useChannelLinks();
    const badgeInputs = useMachineBadgeInputs();
    const sockets = useDaemonSockets();
    const health = storage((state) => state.candidateHealth);
    const sightings = useLanSightings();
    const directory = useRelayDirectory();
    const endpoints = useLanEndpoints();

    const [open, setOpen] = React.useState(false);
    const link = links.find((entry) => entry.channel === channel);
    const ids = machines.map((machine) => machine.id);
    const reaching = ids.filter((id) => badgeInputs(id).reach[channel]).length;
    const capable = channel === 'server' ? ids.length : ids.filter((id) => badgeInputs(id).capability[channel as 'lan' | 'relay']).length;
    const extra = channel === 'lan' ? `${Object.keys(sightings).length} advertising`
        : channel === 'relay' ? `${Object.keys(directory).length} held`
            : `${ids.length} known`;

    // When a published address was recorded, which is what says *who* wrote it: the server's copy of
    // a machine's blob is written when that machine last reported, while the machine's own log
    // arrives as it changes. An address hours old is the server's; a fresh one came over the LAN.
    const published = channel !== 'lan' ? [] : Object.entries(endpoints).flatMap(([id, entry]) => {
        const age = entry?.at ? `${Math.max(0, Math.round((Date.now() - entry.at) / 1000))}s ago` : 'no timestamp';
        return (entry?.baseUrls ?? []).map((baseUrl) => `${age}  ${baseUrl}`);
    });

    const rows = machines.flatMap((machine) => {
        const id = machine.id;
        const held = Object.entries(sockets).filter(([key]) => key === `${id}:${channel}`);
        const candidates = orderedCandidates(id, candidateInputsFor(storage.getState(), id, { now: Date.now(), routes: [channel as 'lan' | 'relay'] }))
            .filter((candidate) => candidate.route === channel);
        if (held.length === 0 && candidates.length === 0) {
            return [];
        }
        // One line per address, not one per fact about it: the socket this App holds and the
        // candidate that names it are the same address, and printing both says nothing twice.
        const byAddress = new Map<string, { socket?: string; candidate?: string }>();
        for (const [, socket] of held) {
            if (socket.baseUrl) {
                // `opening` is one attempt in flight; `retrying` is the backoff between them, and the
                // countdown is what says whether it is getting anywhere. Without them the panel showed
                // a state and not whether it was stuck in it.
                const retry = socket.retryAt ? ` retry ${Math.max(0, Math.round((socket.retryAt - Date.now()) / 1000))}s` : '';
                const attempt = socket.attempt && socket.attempt > 1 ? ` try ${socket.attempt}` : '';
                // What the App holds over the relay is a *stream* in the hub's one connection; over
                // the LAN it is a socket to that machine. Naming both "socket" is what made the relay
                // block read like one connection per machine.
                const noun = channel === 'relay' ? 'stream' : 'socket';
                byAddress.set(socket.baseUrl, { ...byAddress.get(socket.baseUrl), socket: `${noun} ${socket.phase}${attempt}${retry}` });
            }
        }
        for (const candidate of candidates) {
            const state = health[candidateKey(candidate.machineId, candidate.route, candidate.baseUrl)];
            const retry = state?.retryAt ? ` retry ${Math.max(0, Math.round((state.retryAt - Date.now()) / 1000))}s` : '';
            const seen = byAddress.get(candidate.baseUrl) ?? {};
            // The socket's own phase is the truth when there is one; the candidate adds where the
            // address came from and what it has done.
            byAddress.set(candidate.baseUrl, { ...seen, candidate: `${candidate.source} ${seen.socket ? '' : `${state?.phase ?? 'unknown'}${retry}`}`.trim() });
        }
        if (byAddress.size === 0) {
            return [];
        }
        return [
            { kind: 'name' as const, key: `n-${id}`, text: `${machine.metadata?.host ?? id.slice(0, 8)}${byAddress.size > 1 ? `  ·  ${byAddress.size} addresses` : ''}` },
            ...[...byAddress.entries()].map(([baseUrl, facts]) => ({
                kind: 'fact' as const,
                key: `f-${id}-${baseUrl}`,
                text: `${[facts.socket ? `socket ${facts.socket}` : '', facts.candidate ?? ''].filter(Boolean).join(' · ')}  ${baseUrl}`,
            })),
        ];
    });

    return (
        <ItemGroup footer={channel === 'server'
            ? 'One connection for every machine: the server is this device\'s own socket, not a route per machine, which is why there are no per-machine connections here.'
            : undefined}>
            {/* The row is the whole channel until it is opened: the link, and how many machines it is
                reaching. Everything else is one tap away, because a page of open details is what made
                this unreadable. */}
            <Item
                title={channel.toUpperCase()}
                subtitle={link?.state ?? 'absent'}
                icon={<Ionicons name={channel === 'lan' ? 'wifi-outline' : channel === 'relay' ? 'swap-horizontal' : 'globe-outline'} size={24} color={link?.state === 'connected' ? '#34C759' : '#8E8E93'} />}
                onPress={() => setOpen((was) => !was)}
                rightElement={<Text style={{ fontSize: 13, color: theme.colors.text }}>{`${reaching}/${ids.length} reaching`}</Text>}
            />
            {open && <>
            {published.map((text, index) => <Item key={`pub-${index}`} title="Published address" subtitle={text} showChevron={false} />)}
            {liveness}
            <Item title="Capable of carrying it" detail={`${capable} of ${ids.length} machines`} showChevron={false} />
            <Item
                title={channel === 'lan' ? 'Advertising here' : channel === 'relay' ? 'Machines the relay holds' : 'Machines the server knows'}
                subtitle={channel === 'relay' ? `One connection to the relay; each machine above is a stream on it` : undefined}
                detail={channel === 'relay' ? `${extra}  ·  ${rows.filter((row) => row.kind === 'name').length} streams` : extra}
                showChevron={false}
            />
            {rows.length > 0 && (
                    // Compact on purpose: a machine and what it has are a few short lines, indented
                    // under its name, rather than one full-height row per fact — which is what made
                    // the expanded block a wall of the same address repeated.
                    <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
                        {rows.map((row) => row.kind === 'name'
                            ? <Text key={row.key} style={{ fontSize: 12, fontWeight: '600', color: theme.colors.text, marginTop: 8 }}>{row.text}</Text>
                            : (
                                <View key={row.key} style={{ paddingLeft: 12 }}>
                                    {/* The address is what a person reads here, so it gets a line of its
                                        own and is never truncated — squeezing it into a fixed column is
                                        what turned it into `http://19…`. */}
                                    <Text style={{ fontSize: 11, color: theme.colors.text }}>
                                        {`${row.text.split('  ')[0]}  ${row.text.split('  ')[1] ?? ''}`}
                                    </Text>
                                    <Text style={{ fontSize: 10, color: theme.colors.textSecondary }}>{row.text.split('  ').slice(2).join('  ')}</Text>
                                </View>
                            ))}
                    </View>
                )}
            {children}
            </>}
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
