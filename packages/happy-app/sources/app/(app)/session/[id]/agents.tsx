import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { sync } from '@/sync/sync';
import { useSession } from '@/sync/storage';
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
    const [subagents, setSubagents] = React.useState<LanSubagentSummary[] | null>(null);
    const [loaded, setLoaded] = React.useState(false);

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
                    subagents.map((item) => (
                        <Item
                            key={item.subagent}
                            title={item.taskCall ?? item.subagent}
                            subtitle={item.taskCall ? item.subagent : undefined}
                            detail={String(item.entries)}
                            icon={<Ionicons name="git-branch-outline" size={29} color={theme.colors.textSecondary} />}
                            onPress={() => router.push(`/session/${sessionId}/agent/${item.subagent}`)}
                        />
                    ))
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
