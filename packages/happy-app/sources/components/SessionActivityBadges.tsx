import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { GOAL_STATUS_ICONS, type GoalStatus } from '@/utils/goalUtils';
import { groupActivityTasks, type ActivityTask } from '@/utils/activityTasks';

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
 * How each kind of background work is drawn: a glyph and a colour, and the label its details panel
 * is titled with.
 *
 * Indexed by the CLI's own task type, so the badge a reader sees is the kind the CLI reported. A
 * type that is not listed here still gets a badge — with the generic glyph and its own raw name as
 * the title — because the CLI learns kinds of work on its own schedule and a count must never omit
 * something that is running.
 */
type KindStyle = { icon: React.ComponentProps<typeof Ionicons>['name']; color: string; label: () => string };

const KIND_STYLES: Record<string, KindStyle> = {
    subagent: { icon: 'people-outline', color: '#AF52DE', label: () => t('session.activityAgents') },
    monitor: { icon: 'pulse-outline', color: '#FF9500', label: () => t('session.activityMonitors') },
    shell: { icon: 'terminal-outline', color: '#8E8E93', label: () => t('session.activityShell') },
    workflow: { icon: 'git-branch-outline', color: '#007AFF', label: () => t('session.activityWorkflows') },
};

const FALLBACK_STYLE: Omit<KindStyle, 'label'> = { icon: 'ellipsis-horizontal-outline', color: '#8E8E93' };

/** The glyph for a kind, with the kind's own name standing in as its label when it is a new one. */
const styleFor = (type: string): KindStyle => KIND_STYLES[type] ?? { ...FALLBACK_STYLE, label: () => type };

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
    const groups = groupActivityTasks(tasks);
    const goalVisible = showGoal && goal !== null && goal !== undefined;
    if (!goalVisible && groups.length === 0) {
        return null;
    }
    return (
        <View style={styles.row}>
            {groups.map((group) => {
                const { icon, color, label } = styleFor(group.type);
                return (
                    <Pressable
                        key={group.type}
                        onLongPress={() => showDetails(label(), taskLines(group.tasks))}
                        delayLongPress={350}
                        hitSlop={6}
                        style={[styles.badge, compact && styles.badgeCompact, { backgroundColor: `${color}1F` }]}
                    >
                        <Ionicons name={icon} size={compact ? 10 : 12} color={color} />
                        <Text style={[styles.count, { color }]}>{group.tasks.length}</Text>
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
