import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { GOAL_STATUS_ICONS, type GoalStatus } from '@/utils/goalUtils';
import { groupActivityTasks, type ActivityGroup, type ActivityTask } from '@/utils/activityTasks';

export type { ActivityTask } from '@/utils/activityTasks';

/**
 * What a session is currently doing besides answering: the work it started and has not finished.
 *
 * A session that has spawned a subagent, is watching a monitor or has backgrounded a command looks
 * exactly like one that stopped answering — the turn's result arrived, so the status line says it is
 * done, and what is keeping it open is invisible. One number says how much is running; what that
 * number is *made of* is the question someone actually has, so the breakdown is one gesture away
 * rather than on the badge, which has room for a number and nothing else.
 *
 * The gesture differs by platform because the hardware does: a long press on a phone, a hover on a
 * desktop, where hovering is what means "tell me about this" and holding a mouse button down means
 * nothing at all.
 *
 * Props rather than the session, because the same badges are drawn from two places that hold
 * different things: the session row has the session, the input bar has only what it was handed.
 */

/** The goal a session is aiming at, as mirrored into `agentState.activeGoal`. */
export type ActivityGoal = { condition: string; status: GoalStatus; reason?: string; iterations?: number };

/**
 * What each kind of background work is *called*, for the breakdown.
 *
 * Indexed by the CLI's own task type. A type that is not listed still gets its own heading — named
 * with the CLI's own word for it — because the CLI learns kinds of work on its own schedule and a
 * count must never leave out something that is running.
 */
const KIND_LABELS: Record<string, () => string> = {
    subagent: () => t('session.activityAgents'),
    monitor: () => t('session.activityMonitors'),
    shell: () => t('session.activityShell'),
    workflow: () => t('session.activityWorkflows'),
};

/** One line per item. Status is the protocol's own word. */
function taskLines(tasks: ActivityTask[]): string {
    return tasks.map((task) => `  • ${task.status} · ${task.description || task.type}`).join('\n');
}

/**
 * The details panel: the goal if there is one, then every kind that is running, each as a heading
 * with its own lines under it.
 *
 * The badge is one number because a row has room for one; what that number is made of is exactly
 * what someone opening the panel is asking, so the breakdown belongs here rather than on the badge.
 */
function breakdown(groups: ActivityGroup[], goal: ActivityGoal | null): string {
    const sections = groups.map((group) => [KIND_LABELS[group.type]?.() ?? group.type, taskLines(group.tasks)].join('\n'));
    if (goal) {
        sections.unshift([t('session.activityGoals'), goalLines(goal)].join('\n'));
    }
    return sections.join('\n\n');
}

function goalLines(goal: ActivityGoal): string {
    const lines = [`  • ${goal.status} · ${goal.condition}`];
    if (goal.reason) {
        lines.push(`    ${goal.reason}`);
    }
    if (goal.iterations !== undefined) {
        lines.push(`    ${goal.iterations}`);
    }
    return lines.join('\n');
}

function showDetails(title: string, body: string): void {
    if (body.length === 0) {
        return;
    }
    Modal.alert(title, body, [{ text: t('common.ok'), style: 'cancel' }]);
}

/**
 * How long a pointer must rest on a badge before the details appear.
 *
 * Non-zero on purpose: a panel that opens while the pointer is crossing a list is a panel nobody
 * asked for, and the delay is what separates "resting here" from "passing through".
 */
const HOVER_DWELL_MS = 500;

/** The gesture that opens a badge's details, on this platform. */
function useDetailsGesture(show: () => void): React.ComponentProps<typeof Pressable> {
    const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancel = React.useCallback(() => {
        if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
        }
    }, []);
    React.useEffect(() => cancel, [cancel]);
    const open = React.useCallback(() => {
        cancel();
        show();
    }, [cancel, show]);

    if (Platform.OS !== 'web') {
        return { onLongPress: open, delayLongPress: 350 };
    }
    return {
        onLongPress: open,
        onHoverIn: () => {
            cancel();
            timer.current = setTimeout(() => {
                timer.current = null;
                show();
            }, HOVER_DWELL_MS);
        },
        onHoverOut: cancel,
    };
}

export const SessionActivityBadges = React.memo(function SessionActivityBadges({
    tasks,
    goal,
    /** Row-sized rather than input-bar-sized. */
    compact = false,
}: {
    tasks?: ActivityTask[] | null;
    goal?: ActivityGoal | null;
    compact?: boolean;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const groups = groupActivityTasks(tasks);
    const running = groups.reduce((total, group) => total + group.tasks.length, 0);
    const active = goal ?? null;
    // The goal is one of the things in flight — the session is working toward it — so it counts,
    // and the panel says what it is. Its own glyph and colour are kept for the case where it is the
    // only thing in flight: a met goal must still read as met at a glance.
    const total = running + (active ? 1 : 0);
    const gesture = useDetailsGesture(() => showDetails(t('session.backgroundTasks'), breakdown(groups, active)));
    if (total === 0) {
        return null;
    }
    const onlyGoal = running === 0 && active !== null;
    const glyph = onlyGoal ? GOAL_STATUS_ICONS[active.status] : null;
    return (
        <View style={styles.row}>
            <Pressable
                {...gesture}
                hitSlop={6}
                style={[styles.badge, compact && styles.badgeCompact, glyph ? { backgroundColor: `${glyph.color}1F` } : null]}
            >
                <Ionicons
                    name={glyph ? glyph.icon : 'sync-outline'}
                    size={glyph ? (compact ? 12 : 14) : compact ? 10 : 12}
                    color={glyph ? glyph.color : theme.colors.textSecondary}
                />
                <Text style={[styles.count, glyph ? { color: glyph.color } : null]}>{total}</Text>
            </Pressable>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    badge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 5,
        paddingVertical: 1,
        borderRadius: 7,
        backgroundColor: `${theme.colors.textSecondary}1F`,
    },
    badgeCompact: {
        paddingHorizontal: 4,
        paddingVertical: 0,
        gap: 2,
    },
    count: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
}));
