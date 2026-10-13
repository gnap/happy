import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { GOAL_STATUS_ICONS, type GoalStatus } from '@/utils/goalUtils';
import { ACTIVITY_KINDS, groupActivityTasks, type ActivityKind, type ActivityTask } from '@/utils/activityTasks';

export type { ActivityTask } from '@/utils/activityTasks';

/**
 * What a session is currently doing besides answering: the work it started and has not finished.
 *
 * These are the things that make a session look busy when nothing is being said — a subagent it
 * spawned, a monitor it is watching, a shell command it backgrounded — plus the goal it is aiming
 * at. They are shown as counts because the number is the question ("how much is still running?"),
 * and the details behind them are one long press away rather than on screen, because a row has no
 * space for them and a status line has less.
 *
 * Props rather than the session, because the same badges are drawn from two places that hold
 * different things: the session row has the session, the input bar has only what it was handed.
 */

/** The goal a session is aiming at, as mirrored into `agentState.activeGoal`. */
export type ActivityGoal = { condition: string; status: GoalStatus; reason?: string; iterations?: number };

/**
 * The three kinds of background work, and the glyph and colour each is drawn with.
 *
 * `type` comes from the CLI's own task summary, which distinguishes a subagent from a monitor from
 * a plain background command; anything else it learns to run falls in with the commands rather than
 * being hidden, because "something is still running" is the fact that matters.
 */
const KIND_STYLE: Record<ActivityKind, { icon: 'people-outline' | 'pulse-outline' | 'terminal-outline'; color: string; label: () => string }> = {
    agents: { icon: 'people-outline', color: '#AF52DE', label: () => t('session.activityAgents') },
    monitors: { icon: 'pulse-outline', color: '#FF9500', label: () => t('session.activityMonitors') },
    tasks: { icon: 'terminal-outline', color: '#8E8E93', label: () => t('session.backgroundTasks') },
};

/** One line per item, for the details panel. Status is the protocol's own word. */
function taskLines(tasks: ActivityTask[]): string {
    return tasks.map((task) => `• ${task.status} · ${task.description || task.type}`).join('\n');
}

function goalLines(goal: ActivityGoal): string {
    const lines = [`• ${goal.condition}`, `  ${goal.status}`];
    if (goal.reason) {
        lines.push(`  ${goal.reason}`);
    }
    if (goal.iterations !== undefined) {
        lines.push(`  ${goal.iterations}`);
    }
    return lines.join('\n');
}

/** Shows the details of one kind. Long press only: a tap in a list should scroll or open, not ask. */
function showDetails(title: string, body: string): void {
    if (body.length === 0) {
        return;
    }
    Modal.alert(title, body, [{ text: t('common.ok'), style: 'cancel' }]);
}

export const SessionActivityBadges = React.memo(function SessionActivityBadges({
    tasks,
    goal,
    /**
     * Whether the goal belongs in this group. The input bar draws it separately with its condition
     * in full, which is more useful there than a count of one.
     */
    showGoal = true,
    /** Row-sized rather than input-bar-sized. */
    compact = false,
}: {
    tasks?: ActivityTask[] | null;
    goal?: ActivityGoal | null;
    showGoal?: boolean;
    compact?: boolean;
}) {
    const styles = stylesheet;
    const byKind = groupActivityTasks(tasks);
    const goalVisible = showGoal && goal !== null && goal !== undefined;
    if (!goalVisible && ACTIVITY_KINDS.every((kind) => byKind[kind].length === 0)) {
        return null;
    }
    return (
        <View style={styles.row}>
            {ACTIVITY_KINDS.map((kind) => {
                const items = byKind[kind];
                if (items.length === 0) {
                    return null;
                }
                const { icon, color, label } = KIND_STYLE[kind];
                return (
                    <Pressable
                        key={kind}
                        onLongPress={() => showDetails(label(), taskLines(items))}
                        delayLongPress={350}
                        hitSlop={6}
                        style={[styles.badge, compact && styles.badgeCompact, { backgroundColor: `${color}1F` }]}
                    >
                        <Ionicons name={icon} size={compact ? 10 : 12} color={color} />
                        <Text style={[styles.count, { color }]}>{items.length}</Text>
                    </Pressable>
                );
            })}
            {goalVisible ? (
                <Pressable
                    onLongPress={() => showDetails(t('session.activityGoals'), goalLines(goal as ActivityGoal))}
                    delayLongPress={350}
                    hitSlop={6}
                    style={[styles.badge, compact && styles.badgeCompact, { backgroundColor: `${GOAL_STATUS_ICONS[(goal as ActivityGoal).status].color}1F` }]}
                >
                    <Ionicons
                        name={GOAL_STATUS_ICONS[(goal as ActivityGoal).status].icon}
                        size={compact ? 12 : 14}
                        color={GOAL_STATUS_ICONS[(goal as ActivityGoal).status].color}
                    />
                </Pressable>
            ) : null}
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
    },
    badgeCompact: {
        paddingHorizontal: 4,
        paddingVertical: 0,
        gap: 2,
    },
    count: {
        fontSize: 11,
        ...Typography.default('semiBold'),
    },
}));
