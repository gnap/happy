import type { AgentState, Session } from '@/sync/storageTypes';

/** Latest /goal condition status mirrored from the CLI into agentState. */
export type ActiveGoal = NonNullable<AgentState['activeGoal']>;
export type GoalStatus = ActiveGoal['status'];

/**
 * Target while the goal is armed but not yet judged; flag once judged — green when met,
 * red when failed. Status is conveyed by glyph + color only, so a single icon reads the
 * same in the session row (icon only) and in the input status line (icon + condition).
 */
export const GOAL_STATUS_ICONS: Record<GoalStatus, { icon: 'locate-outline' | 'flag'; color: string }> = {
    pending: { icon: 'locate-outline', color: '#FF9500' },
    met: { icon: 'flag', color: '#34C759' },
    failed: { icon: 'flag', color: '#FF3B30' },
};

/** Current goal for a session, or null when it has none. */
export function getActiveGoal(session: Session): ActiveGoal | null {
    return session.agentState?.activeGoal ?? null;
}
