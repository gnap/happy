import * as React from 'react';
import { useWindowDimensions, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { FloatingOverlay } from '@/components/FloatingOverlay';

/**
 * The details behind an activity badge, as a bubble above it.
 *
 * Not a dialog: nothing here is being confirmed, so a bubble that appears where the badge is and
 * goes away when the pointer leaves or a finger lands elsewhere is the whole interaction. It is
 * dressed like the context-length bubble in the input bar (`FloatingOverlay` — rounded surface,
 * shadow, and a scrolling body with a cap), because that is what this App's popovers look like.
 *
 * Both things it shows are unbounded: a goal's condition is written by whoever armed it and can be
 * a paragraph, and a session can have any number of background tasks. Hence the body scrolls and
 * each description is clamped — a bubble that grows to fit its data is one that covers the thing it
 * was opened from.
 */

/** One item: the state it is in, and what it is. */
export type ActivityDetailLine = { status: string; text: string };

/** A group of items under a heading — the heading is the kind of work, as the CLI named it. */
export type ActivityDetailSection = { label: string; lines: ActivityDetailLine[] };

export const ActivityBubble = React.memo(function ActivityBubble({
    title,
    icon,
    sections,
}: {
    title: string;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    sections: ActivityDetailSection[];
}) {
    const styles = stylesheet;
    const { width } = useWindowDimensions();
    return (
        <View style={[styles.bubble, { width: Math.min(width - 32, 300) }]}>
            <FloatingOverlay maxHeight={320}>
                <View style={styles.header}>
                    {icon ? <Ionicons name={icon} size={13} color={styles.headerText.color} /> : null}
                    <Text style={styles.headerText}>{title}</Text>
                </View>
                {sections.map((section) => (
                    <View key={section.label} style={styles.section}>
                        <Text style={styles.sectionLabel}>{section.label}</Text>
                        {section.lines.map((line, index) => (
                            <View key={`${section.label}:${index}`} style={styles.line}>
                                <Text style={styles.status}>{line.status}</Text>
                                <Text style={styles.text}>{line.text}</Text>
                            </View>
                        ))}
                    </View>
                ))}
            </FloatingOverlay>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    bubble: {
        // Anchored by the caller: this is only the box itself.
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 6,
    },
    headerText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        ...Typography.default('semiBold'),
    },
    section: {
        paddingHorizontal: 12,
        paddingBottom: 10,
    },
    sectionLabel: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginBottom: 3,
        ...Typography.default('semiBold'),
    },
    line: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 6,
        marginBottom: 2,
    },
    status: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    text: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.text,
        ...Typography.default(),
    },
}));
