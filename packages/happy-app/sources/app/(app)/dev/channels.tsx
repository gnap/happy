import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { useLocalSettingMutable } from '@/sync/storage';
import { DEFAULT_CHANNEL_PRIORITY, normalizeChannelPriority } from '@/sync/lan/channelOrder';
import type { SessionChannel } from '@/sync/lan/types';

const CHANNEL_INFO: Record<SessionChannel, { title: string; subtitle: string; icon: string }> = {
    lan: { title: 'LAN', subtitle: 'Direct to the daemon on the local network (mDNS)', icon: 'wifi-outline' },
    relay: { title: 'Relay', subtitle: 'Public relay, works without happy-server', icon: 'swap-horizontal-outline' },
    server: { title: 'Server', subtitle: 'happy-server', icon: 'cloud-outline' },
};

const ALL_CHANNELS: SessionChannel[] = ['lan', 'relay', 'server'];

export default React.memo(function ChannelPriorityScreen() {
    const [stored, setStored] = useLocalSettingMutable('channelPriority');
    const enabled = normalizeChannelPriority(stored);
    const disabled = ALL_CHANNELS.filter((c) => !enabled.includes(c));

    const move = (channel: SessionChannel, delta: -1 | 1) => {
        const next = [...enabled];
        const from = next.indexOf(channel);
        const to = from + delta;
        if (to < 0 || to >= next.length) return;
        next.splice(from, 1);
        next.splice(to, 0, channel);
        setStored(next);
    };

    const toggle = (channel: SessionChannel, on: boolean) => {
        if (on) {
            setStored([...enabled, channel]);
        } else if (enabled.length > 1) {
            setStored(enabled.filter((c) => c !== channel));
        }
    };

    const arrows = (channel: SessionChannel, index: number) => (
        <View style={styles.controls}>
            <Pressable hitSlop={8} disabled={index === 0} onPress={() => move(channel, -1)} style={index === 0 ? styles.dim : undefined}>
                <Ionicons name="chevron-up" size={22} color="#007AFF" />
            </Pressable>
            <Pressable hitSlop={8} disabled={index === enabled.length - 1} onPress={() => move(channel, 1)} style={index === enabled.length - 1 ? styles.dim : undefined}>
                <Ionicons name="chevron-down" size={22} color="#007AFF" />
            </Pressable>
            <Switch value onValueChange={(on) => toggle(channel, on)} disabled={enabled.length === 1} />
        </View>
    );

    return (
        <ItemList>
            <ItemGroup
                title="Enabled, in priority order"
                footer="The first channel that is reachable wins. A session pinned to a channel in its info page ignores this list. At least one channel stays on."
            >
                {enabled.map((channel, index) => (
                    <Item
                        key={channel}
                        title={`${index + 1}. ${CHANNEL_INFO[channel].title}`}
                        subtitle={CHANNEL_INFO[channel].subtitle}
                        icon={<Ionicons name={CHANNEL_INFO[channel].icon as any} size={28} color="#007AFF" />}
                        rightElement={arrows(channel, index)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>
            {disabled.length > 0 && (
                <ItemGroup title="Disabled">
                    {disabled.map((channel) => (
                        <Item
                            key={channel}
                            title={CHANNEL_INFO[channel].title}
                            subtitle={CHANNEL_INFO[channel].subtitle}
                            icon={<Ionicons name={CHANNEL_INFO[channel].icon as any} size={28} color="#8E8E93" />}
                            rightElement={<Switch value={false} onValueChange={(on) => toggle(channel, on)} />}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            )}
            <ItemGroup>
                <Item
                    title="Reset to default"
                    subtitle={DEFAULT_CHANNEL_PRIORITY.join(' › ')}
                    onPress={() => setStored([...DEFAULT_CHANNEL_PRIORITY])}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});

const styles = StyleSheet.create({
    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    dim: {
        opacity: 0.3,
    },
});
