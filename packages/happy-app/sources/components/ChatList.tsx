import * as React from 'react';
import { useSession, useSessionMessages } from "@/sync/storage";
import { mergeAdjacentAgentTextMessages } from '@/sync/mergeAdjacentAgentTextMessages';
import { ActivityIndicator, FlatList, Platform, View } from 'react-native';
import { useCallback, useMemo } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { sync } from '@/sync/sync';

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages, hasOlderMessages, isLoadingOlder } = useSessionMessages(props.session.id);
    const displayMessages = useMemo(
        () => mergeAdjacentAgentTextMessages(messages as Message[]),
        [messages],
    );
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={displayMessages}
            hasOlderMessages={hasOlderMessages}
            isLoadingOlder={isLoadingOlder}
        />
    )
});

const ListHeader = React.memo((props: { isLoadingOlder: boolean }) => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return (
        <View style={{ alignItems: 'center', paddingBottom: 8 }}>
            {props.isLoadingOlder ? (
                <ActivityIndicator style={{ marginBottom: 8 }} />
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />
        </View>
    );
});

const ListFooter = React.memo((props: { sessionId: string }) => {
    const session = useSession(props.sessionId)!;
    return (
        <ChatFooter controlledByUser={session.agentState?.controlledByUser || false} />
    )
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    messages: Message[],
    hasOlderMessages: boolean,
    isLoadingOlder: boolean,
}) => {
    const keyExtractor = useCallback((item: any) => item.id, []);
    const renderItem = useCallback(({ item }: { item: any }) => (
        <MessageView message={item} metadata={props.metadata} sessionId={props.sessionId} />
    ), [props.metadata, props.sessionId]);

    const onEndReached = useCallback(() => {
        if (!props.hasOlderMessages || props.isLoadingOlder) {
            return;
        }
        void sync.loadOlderMessages(props.sessionId);
    }, [props.hasOlderMessages, props.isLoadingOlder, props.sessionId]);

    return (
        <FlatList
            data={props.messages}
            inverted={true}
            keyExtractor={keyExtractor}
            maintainVisibleContentPosition={{
                minIndexForVisible: 0,
                autoscrollToTopThreshold: 10,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
            renderItem={renderItem}
            ListHeaderComponent={<ListFooter sessionId={props.sessionId} />}
            ListFooterComponent={<ListHeader isLoadingOlder={props.isLoadingOlder} />}
            onEndReached={onEndReached}
            onEndReachedThreshold={0.25}
        />
    )
});