import * as React from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { MessageView } from '@/components/MessageView';
import { useSession } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { createReducer, reducer, type ReducerState } from '@/sync/reducer/reducer';
import type { Message } from '@/sync/typesMessage';
import { t } from '@/text';

/**
 * One sub-agent's own message stream.
 *
 * Read from the machine's log with the sub-agent filter, not carved out of the session window:
 * the page has its own anchors, so older history is walked here without changing what the main
 * conversation holds. It is deliberately not live — a sub-agent's timeliness does not justify a
 * socket — and the page is read when the screen opens.
 *
 * The page is reduced locally with the same reducer the chat uses, so tool calls, thinking and
 * text render exactly as they do in the main stream; only the source of the messages differs.
 */
export default React.memo(() => {
    const { id: sessionId, subagentId } = useLocalSearchParams<{ id: string; subagentId: string }>();
    const session = useSession(sessionId);
    const { theme } = useUnistyles();
    const [messages, setMessages] = React.useState<Message[]>([]);
    const [loaded, setLoaded] = React.useState(false);
    const [loadingOlder, setLoadingOlder] = React.useState(false);
    const [hasOlder, setHasOlder] = React.useState(false);
    const reducerRef = React.useRef<ReducerState | null>(null);
    const byId = React.useRef(new Map<string, Message>());
    const olderRef = React.useRef<string | null>(null);

    const apply = React.useCallback((read: NonNullable<Awaited<ReturnType<typeof sync.readSubagentPage>>>) => {
        reducerRef.current ??= createReducer();
        const result = reducer(reducerRef.current, read.messages, null);
        for (const message of result.messages) {
            byId.current.set(message.id, message);
        }
        // Newest first: the list is inverted, the same way the chat draws its window.
        setMessages([...byId.current.values()].sort((a, b) => b.createdAt - a.createdAt));
        olderRef.current = read.older;
        setHasOlder(read.hasOlder);
    }, []);

    React.useEffect(() => {
        let cancelled = false;
        reducerRef.current = createReducer();
        byId.current.clear();
        olderRef.current = null;
        setMessages([]);
        setHasOlder(false);
        setLoaded(false);
        void (async () => {
            const read = await sync.readSubagentPage(sessionId, subagentId, { kind: 'tail' });
            if (cancelled) {
                return;
            }
            if (read) {
                apply(read);
            }
            setLoaded(true);
        })();
        return () => {
            cancelled = true;
        };
    }, [sessionId, subagentId, apply]);

    const loadOlder = React.useCallback(async () => {
        if (!hasOlder || loadingOlder || olderRef.current === null) {
            return;
        }
        setLoadingOlder(true);
        try {
            const read = await sync.readSubagentPage(sessionId, subagentId, { kind: 'older', before: olderRef.current });
            if (read) {
                apply(read);
            }
        } finally {
            setLoadingOlder(false);
        }
    }, [apply, hasOlder, loadingOlder, sessionId, subagentId]);

    return (
        <>
            <Stack.Screen options={{ title: t('session.subagentStream') }} />
            {!loaded ? (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : messages.length === 0 ? (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
                    <Text style={{ color: theme.colors.textSecondary }}>{t('session.noSubagents')}</Text>
                </View>
            ) : (
                <FlatList
                    data={messages}
                    inverted
                    keyExtractor={(message) => message.id}
                    renderItem={({ item }) => (
                        <MessageView message={item} metadata={session?.metadata ?? null} sessionId={sessionId} />
                    )}
                    onEndReached={() => {
                        void loadOlder();
                    }}
                    onEndReachedThreshold={0.4}
                    ListFooterComponent={loadingOlder ? (
                        <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        </View>
                    ) : null}
                />
            )}
        </>
    );
});
