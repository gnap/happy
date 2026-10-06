import * as React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { sync } from '@/sync/sync';
import { useAllMachines } from '@/sync/storage';
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

type LogLine = {
    stage: string;
    text: string;
    ok: boolean;
};

const line = (stage: string, text: string, ok = true): LogLine => ({ stage, text, ok });

const LanDevScreen = React.memo(function LanDevScreen() {
    const { theme } = useUnistyles();
    const machines = useAllMachines();
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

            // ── Stage 1: discover ────────────────────────────────────────────────
            const discovered = await discoverMachines({ accountPublicKey });
            if (discovered.length === 0) {
                push(line('discover', 'no _happy._tcp machines found for this account', false));
                push(line('discover', 'is the daemon running with HAPPY_LAN_ENABLED=1, and the local network permission granted?', false));
                return;
            }
            for (const machine of discovered) {
                push(line('discover', `${machine.serviceName} -> ${machine.baseUrl}`));
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
            for (const session of sessions) {
                const history = await fetchHistory(target.baseUrl, token, session.happySessionId);
                if (!history) {
                    push(line('history', `${session.happySessionId}: no local history (404)`));
                    continue;
                }
                const decrypted = await decryptLanHistory(sync.encryption!, history);
                decryptedAny = true;
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

            push(line('done', 'LAN round trip complete'));
        } catch (error) {
            push(line('error', String(error), false));
        } finally {
            setRunning(false);
        }
    }, [accountPublicKey]);

    return (
        <ItemList>
            <ItemGroup
                title="LAN API"
                footer="Runs against the CLI daemon's read-only LAN API. It must be started with HAPPY_LAN_ENABLED=1."
            >
                <Item
                    title="Run LAN round trip"
                    subtitle="discover → authenticate → read history → decrypt"
                    icon={<Ionicons name="wifi-outline" size={28} color="#007AFF" />}
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
