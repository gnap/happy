import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { sync } from '@/sync/sync';
import { useSession, useSessionMessages } from '@/sync/storage';
import type { LanSubagentSummary } from '@/sync/lan/types';
import { t } from '@/text';

/**
 * The sub-agents this session's machine has a stream for.
 *
 * A listing, read once when the screen opens: the streams themselves are read only when one is
 * opened, because a sub-agent's timeliness does not justify carrying it live alongside the main
 * conversation. The list is the machine's own log, so an older machine with no split shows the
 * empty state rather than an error.
 */
export default React.memo(() => {
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const session = useSession(sessionId!);
    const router = useRouter();
    const { theme } = useUnistyles();
    const { messages } = useSessionMessages(sessionId!);
    const [subagents, setSubagents] = React.useState<LanSubagentSummary[] | null>(null);
    const [loaded, setLoaded] = React.useState(false);
    /**
     * What the main stream already knows about each task call behind a stream.
     *
     * The daemon's listing carries the worker id and the tool call only; the description and
     * whether it is still running are in the Task card the person has already seen. Joining the
     * two here keeps the list readable without teaching the log about presentation.
     */
    const taskCalls = React.useMemo(() => {
        const byCall = new Map<string, { title?: string; state: 'running' | 'completed' | 'error' }>();
        for (const message of messages) {
            if (message.kind !== 'tool-call' || !message.tool.callId) {
                continue;
            }
            if (message.tool.name !== 'Task' && message.tool.name !== 'Agent') {
                continue;
            }
            const input = (message.tool.input ?? {}) as Record<string, unknown>;
            const description = typeof input.description === 'string' && input.description.trim().length > 0
                ? input.description.trim()
                : message.tool.description ?? undefined;
            byCall.set(message.tool.callId, {
                ...(description !== undefined ? { title: description } : {}),
                state: message.tool.state,
            });
        }
        return byCall;
    }, [messages]);

    React.useEffect(() => {
        let cancelled = false;
        setLoaded(false);
        void (async () => {
            const answer = await sync.listSessionSubagents(sessionId);
            if (cancelled) {
                return;
            }
            setSubagents(answer ?? []);
            setLoaded(true);
        })();
        return () => {
            cancelled = true;
        };
    }, [sessionId]);

    return (
        <>
            <Stack.Screen options={{ title: t('session.subagents') }} />
            <ItemList style={{ flex: 1 }}>
                {!loaded ? (
                    <View style={{ paddingTop: 40, alignItems: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : subagents !== null && subagents.length > 0 ? (
                    subagents.map((item) => {
                        const task = item.taskCall ? taskCalls.get(item.taskCall) : undefined;
                        const running = task?.state === 'running';
                        return (
                            <Item
                                key={item.subagent}
                                title={task?.title ?? item.taskCall ?? item.subagent}
                                subtitle={item.taskCall ?? undefined}
                                detail={String(item.entries)}
                                icon={(
                                    <Ionicons
                                        name="git-branch-outline"
                                        size={29}
                                        color={running ? '#FF9500' : theme.colors.textSecondary}
                                    />
                                )}
                                onPress={() => router.push(`/session/${sessionId}/agent/${item.subagent}`)}
                            />
                        );
                    })
                ) : (
                    <Item
                        title={t('session.noSubagents')}
                        subtitle={session?.metadata?.path}
                        icon={<Ionicons name="git-branch-outline" size={29} color={theme.colors.textSecondary} />}
                        disabled
                    />
                )}
            </ItemList>
        </>
    );
});
