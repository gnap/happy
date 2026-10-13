import * as React from 'react';
import { Platform, Pressable, TouchableWithoutFeedback, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { GOAL_STATUS_ICONS, type GoalStatus } from '@/utils/goalUtils';
import { groupActivityTasks, type ActivityGroup, type ActivityTask } from '@/utils/activityTasks';
import { ActivityBubble, type ActivityDetailSection } from '@/components/ActivityBubble';

export type { ActivityTask } from '@/utils/activityTasks';

/**
 * What a session is currently doing besides answering: the work it started and has not finished,
 * and the goal it is aiming at.
 *
 * A session that has spawned a subagent, is watching a monitor or has backgrounded a command looks
 * exactly like one that stopped answering — the turn's result arrived, so the status line says it is
 * done, and what is keeping it open is invisible. A count is what fits here; what the number is
 * *made of* is the question someone actually has, so it is one bubble away.
 *
 * The goal keeps its own glyph and colour. It is the one thing here a reader recognises at a glance
 * — met, failed, still aiming — and a mark that means that is worth its twenty pixels.
 *
 * The gesture differs by platform because the hardware does: a long press on a phone, a hover on a
 * desktop, where hovering is what means "tell me about this" and holding a mouse button down means
 * nothing at all. The bubble closes the same way it opened — the pointer leaving, or a tap anywhere
 * else (the invisible backdrop the input bar's own bubble uses).
 *
 * Props rather than the session, because the same badges are drawn from two places that hold
 * different things: the session row has the session, the input bar has only what it was handed.
 */

/** The goal a session is aiming at, as mirrored into `agentState.activeGoal`. */
export type ActivityGoal = { condition: string; status: GoalStatus; reason?: string; iterations?: number };

/**
 * What each kind of background work is *called*, for the bubble's headings.
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

const taskSections = (groups: ActivityGroup[]): ActivityDetailSection[] =>
    groups.map((group) => ({
        label: KIND_LABELS[group.type]?.() ?? group.type,
        lines: group.tasks.map((task) => ({ status: task.status, text: task.description || task.type })),
    }));

const goalSections = (goal: ActivityGoal): ActivityDetailSection[] => [{
    label: t('session.activityGoals'),
    lines: [{
        status: goal.status,
        text: [goal.condition, goal.reason, goal.iterations !== undefined ? String(goal.iterations) : null]
            .filter((part): part is string => typeof part === 'string' && part.length > 0)
            .join('\n'),
    }],
}];

/** A pointer that rests on a badge for this long opens its bubble; a phone long-presses instead. */
const HOVER_DWELL_MS = 450;
/** Grace after the pointer leaves, so crossing the gap to the bubble does not close it. */
const HOVER_LEAVE_MS = 200;

type OpenBubble = 'tasks' | 'goal' | null;

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
    const [open, setOpen] = React.useState<OpenBubble>(null);
    const dwellTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const leaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const clear = React.useCallback((timer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
        if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
        }
    }, []);
    React.useEffect(() => () => {
        clear(dwellTimer);
        clear(leaveTimer);
    }, [clear]);

    const groups = groupActivityTasks(tasks);
    const running = groups.reduce((total, group) => total + group.tasks.length, 0);
    const active = goal ?? null;
    const onWeb = Platform.OS === 'web';

    const enter = React.useCallback((which: Exclude<OpenBubble, null>) => {
        clear(leaveTimer);
        if (!onWeb) {
            return;
        }
        clear(dwellTimer);
        dwellTimer.current = setTimeout(() => {
            dwellTimer.current = null;
            setOpen(which);
        }, HOVER_DWELL_MS);
    }, [clear, onWeb]);
    const leave = React.useCallback(() => {
        clear(dwellTimer);
        if (!onWeb) {
            return;
        }
        clear(leaveTimer);
        leaveTimer.current = setTimeout(() => {
            leaveTimer.current = null;
            setOpen(null);
        }, HOVER_LEAVE_MS);
    }, [clear, onWeb]);
    const toggle = React.useCallback((which: Exclude<OpenBubble, null>) => {
        clear(dwellTimer);
        clear(leaveTimer);
        setOpen((current) => (current === which ? null : which));
    }, [clear]);

    if (running === 0 && !active) {
        return null;
    }

    /**
     * What a badge does on each platform.
     *
     * A phone long-presses and does *not* answer a tap: in the session list a tap belongs to the row,
     * and a badge that swallowed it would open a bubble where the user expected a conversation. A
     * desktop hovers, and a click toggles, because that is what a mouse expects to be able to do.
     */
    const gesture = (which: Exclude<OpenBubble, null>) => ({
        onLongPress: () => toggle(which),
        delayLongPress: 350,
        ...(onWeb
            ? { onPress: () => toggle(which), onMouseEnter: () => enter(which), onMouseLeave: leave }
            : {}),
    });

    return (
        <View style={styles.row}>
            {running > 0 ? (
                <Pressable {...gesture('tasks')} hitSlop={6} style={[styles.badge, compact && styles.badgeCompact]}>
                    <Ionicons name="sync-outline" size={compact ? 10 : 12} color={theme.colors.textSecondary} />
                    <Text style={styles.count}>{running}</Text>
                </Pressable>
            ) : null}
            {active ? (
                <Pressable {...gesture('goal')} hitSlop={6} style={styles.goal}>
                    <Ionicons
                        name={GOAL_STATUS_ICONS[active.status].icon}
                        size={compact ? 13 : 15}
                        color={GOAL_STATUS_ICONS[active.status].color}
                    />
                </Pressable>
            ) : null}
            {open !== null ? (
                <>
                    {/* Anything outside the bubble closes it. The input bar's own bubble does this too:
                        on the web a pointer leaving is the dismissal, and a finger needs a target. */}
                    {!onWeb ? (
                        <TouchableWithoutFeedback onPress={() => setOpen(null)}>
                            <View style={styles.backdrop} />
                        </TouchableWithoutFeedback>
                    ) : null}
                    <View
                        style={styles.anchor}
                        {...(onWeb ? { onMouseEnter: () => clear(leaveTimer), onMouseLeave: leave } : {})}
                    >
                        <ActivityBubble
                            title={open === 'goal' ? t('session.activityGoals') : t('session.backgroundTasks')}
                            icon={open === 'goal' ? GOAL_STATUS_ICONS[(active as ActivityGoal).status].icon : 'sync-outline'}
                            sections={open === 'goal' && active ? goalSections(active) : taskSections(groups)}
                        />
                    </View>
                </>
            ) : null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
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
    goal: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 1,
    },
    count: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    backdrop: {
        position: 'absolute',
        top: -500,
        left: -200,
        right: -200,
        bottom: -500,
        zIndex: 1000,
    },
    anchor: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        zIndex: 1001,
        paddingBottom: 4,
    },
}));
