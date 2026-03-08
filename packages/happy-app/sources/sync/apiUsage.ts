import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';

export interface UsageDataPoint {
    timestamp: number;
    tokens: Record<string, number>;
    cost: Record<string, number>;
    reportCount: number;
}

export interface UsageQueryParams {
    sessionId?: string;
    startTime?: number; // Unix timestamp in seconds
    endTime?: number;   // Unix timestamp in seconds
    groupBy?: 'hour' | 'day';
}

export interface UsageResponse {
    usage: UsageDataPoint[];
}

/**
 * Query usage data from the server
 */
export async function queryUsage(
    credentials: AuthCredentials,
    params: UsageQueryParams = {}
): Promise<UsageResponse> {
    const API_ENDPOINT = getServerUrl();
    
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/usage/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(params)
        });

        if (!response.ok) {
            if (response.status === 404 && params.sessionId) {
                throw new Error('Session not found');
            }
            throw new Error(`Failed to query usage: ${response.status}`);
        }

        const data = await response.json() as UsageResponse;
        return data;
    });
}

/**
 * Helper function to get usage for a specific time period
 */
export async function getUsageForPeriod(
    credentials: AuthCredentials,
    period: 'today' | '7days' | '30days',
    sessionId?: string
): Promise<UsageResponse> {
    const now = Math.floor(Date.now() / 1000);
    const oneDaySeconds = 24 * 60 * 60;
    
    let startTime: number;
    let groupBy: 'hour' | 'day';
    
    switch (period) {
        case 'today':
            // Start of today (local timezone)
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            startTime = Math.floor(today.getTime() / 1000);
            groupBy = 'hour';
            break;
        case '7days':
            startTime = now - (7 * oneDaySeconds);
            groupBy = 'day';
            break;
        case '30days':
            startTime = now - (30 * oneDaySeconds);
            groupBy = 'day';
            break;
    }
    
    return queryUsage(credentials, {
        sessionId,
        startTime,
        endTime: now,
        groupBy
    });
}

/** Source of usage (by report key: claude-session vs cursor-ide). Inferred from token/cost key names. */
export type UsageSource = 'claude' | 'cursor' | 'other';

/** Display info for a usage key (token or cost key from server). */
export interface UsageKeyDisplay {
    labelKey: string;
    source: UsageSource;
}

/** Known token/cost keys and their display label key + source for usage breakdown UI. */
const USAGE_KEY_DISPLAY: Record<string, UsageKeyDisplay> = {
    // Claude (claude-session)
    total: { labelKey: 'usage.keyTotal', source: 'other' },
    input: { labelKey: 'usage.keyClaudeInput', source: 'claude' },
    output: { labelKey: 'usage.keyClaudeOutput', source: 'claude' },
    cache_creation: { labelKey: 'usage.keyClaudeCacheCreation', source: 'claude' },
    cache_read: { labelKey: 'usage.keyClaudeCacheRead', source: 'claude' },
    // Cursor plan (cursor-ide) — plan_limit is reference value, not rendered as a bar
    plan_used: { labelKey: 'usage.keyCursorPlanUsed', source: 'cursor' },
    plan_limit: { labelKey: 'usage.keyCursorPlanLimit', source: 'cursor' },
    // Cursor on-demand — on_demand_limit_cents is reference value, not rendered as a bar
    on_demand_used_cents: { labelKey: 'usage.keyCursorOnDemandUsed', source: 'cursor' },
    on_demand_limit_cents: { labelKey: 'usage.keyCursorOnDemandLimit', source: 'cursor' },
};

/**
 * Keys that are reference/denominator values only — used to compute bar scale but
 * not rendered as their own bar row in the usage breakdown.
 */
export const USAGE_LIMIT_KEYS = new Set(['plan_limit', 'on_demand_limit_cents']);

/**
 * Get display label key and source for a usage breakdown key (token or cost key).
 * Used by UsagePanel to show "Claude input", "Cursor plan (used)" etc.
 */
export function getUsageKeyDisplay(key: string): UsageKeyDisplay {
    return USAGE_KEY_DISPLAY[key] ?? { labelKey: 'usage.keyUnknown', source: 'other' };
}

/**
 * Group token/cost entries by source for display (Claude vs Cursor sections).
 */
export function groupUsageBySource(byKey: Record<string, number>): { source: UsageSource; entries: [string, number][] }[] {
    const bySource: Record<UsageSource, [string, number][]> = {
        claude: [],
        cursor: [],
        other: [],
    };
    for (const [k, v] of Object.entries(byKey)) {
        if (typeof v !== 'number') continue;
        const { source } = getUsageKeyDisplay(k);
        bySource[source].push([k, v]);
    }
    for (const arr of Object.values(bySource)) {
        arr.sort(([, a], [, b]) => b - a);
    }
    const result: { source: UsageSource; entries: [string, number][] }[] = [];
    if (bySource.claude.length > 0) result.push({ source: 'claude', entries: bySource.claude });
    if (bySource.cursor.length > 0) result.push({ source: 'cursor', entries: bySource.cursor });
    if (bySource.other.length > 0) result.push({ source: 'other', entries: bySource.other });
    return result;
}

/**
 * Calculate total tokens and cost from usage data
 */
export function calculateTotals(usage: UsageDataPoint[]): {
    totalTokens: number;
    totalCost: number;
    tokensByModel: Record<string, number>;
    costByModel: Record<string, number>;
} {
    const result = {
        totalTokens: 0,
        totalCost: 0,
        tokensByModel: {} as Record<string, number>,
        costByModel: {} as Record<string, number>
    };
    
    for (const dataPoint of usage) {
        // Sum tokens
        for (const [model, tokens] of Object.entries(dataPoint.tokens)) {
            if (typeof tokens === 'number') {
                result.totalTokens += tokens;
                result.tokensByModel[model] = (result.tokensByModel[model] || 0) + tokens;
            }
        }
        
        // Sum costs
        for (const [model, cost] of Object.entries(dataPoint.cost)) {
            if (typeof cost === 'number') {
                result.totalCost += cost;
                result.costByModel[model] = (result.costByModel[model] || 0) + cost;
            }
        }
    }
    
    return result;
}