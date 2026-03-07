/**
 * Cursor IDE quota/billing info fetcher (monitor-only, no proxy).
 *
 * Reads auth from Cursor's state.vscdb (path from cursorQuotaPaths, respects
 * CURSOR_STATE_DB_PATH / CURSOR_USER_DATA_DIR for multiple environments),
 * then fetches usage from api2.cursor.sh/auth/usage-summary.
 *
 * Does not require Cursor to be a proxy provider; only used to display or
 * report Cursor account usage (plan / on-demand).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { CursorPlatform } from './cursorQuotaPaths';
import {
  getCursorStateDbPath,
  cursorStateDbExists,
} from './cursorQuotaPaths';
import { logger } from '@/ui/logger';
import axios from 'axios';

const CURSOR_API_BASE = 'https://api2.cursor.sh';

export interface CursorAuthData {
  accessToken: string | null;
  refreshToken: string | null;
  email: string | null;
  membershipType: string | null;
  subscriptionStatus: string | null;
  signUpType: string | null;
}

export interface CursorPlanUsage {
  enabled: boolean;
  used: number;
  limit: number;
  remaining: number;
  totalPercentUsed: number;
  autoPercentUsed: number;
  apiPercentUsed: number;
}

export interface CursorOnDemandUsage {
  enabled: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
}

export interface CursorQuotaInfo {
  email: string | null;
  membershipType: string | null;
  subscriptionStatus: string | null;
  billingCycleStart: string | null;
  billingCycleEnd: string | null;
  isUnlimited: boolean;
  planUsage: CursorPlanUsage | null;
  onDemandUsage: CursorOnDemandUsage | null;
}

/**
 * Read cursorAuth/* keys from Cursor's state.vscdb using sqlite3 CLI.
 * Returns null if file missing, sqlite3 not available, or no auth keys found.
 */
export function readCursorAuthFromStateDb(
  stateDbPath: string,
  _platform?: CursorPlatform,
): CursorAuthData | null {
  if (!existsSync(stateDbPath)) {
    return null;
  }

  try {
    // sqlite3 -json avoids delimiter issues in values; supported in sqlite3 3.8+
    const sql = "SELECT key, value FROM ItemTable WHERE key LIKE 'cursorAuth/%'";
    const result = spawnSync('sqlite3', ['-json', stateDbPath, sql], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    const out = (result.stdout ?? '').trim();
    if (!out) return null;

    const rows = JSON.parse(out) as Array<{ key: string; value: string }>;
    const data: CursorAuthData = {
      accessToken: null,
      refreshToken: null,
      email: null,
      membershipType: null,
      subscriptionStatus: null,
      signUpType: null,
    };
    for (const row of rows) {
      switch (row.key) {
        case 'cursorAuth/accessToken':
          data.accessToken = row.value;
          break;
        case 'cursorAuth/refreshToken':
          data.refreshToken = row.value;
          break;
        case 'cursorAuth/cachedEmail':
          data.email = row.value;
          break;
        case 'cursorAuth/stripeMembershipType':
          data.membershipType = row.value;
          break;
        case 'cursorAuth/stripeSubscriptionStatus':
          data.subscriptionStatus = row.value;
          break;
        case 'cursorAuth/cachedSignUpType':
          data.signUpType = row.value;
          break;
        default:
          break;
      }
    }
    if (!data.accessToken && !data.email) return null;
    return data;
  } catch (e) {
    logger.debug('[cursor-quota] readCursorAuthFromStateDb failed:', e);
    return null;
  }
}

/**
 * Fetch usage-summary from Cursor API. Returns null on non-200 or parse error.
 */
export async function fetchCursorUsageSummary(accessToken: string): Promise<CursorQuotaInfo | null> {
  const url = `${CURSOR_API_BASE}/auth/usage-summary`;
  try {
    const res = await axios.get<Record<string, unknown>>(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      timeout: 15_000,
      validateStatus: (s) => s === 200 || s === 401,
    });

    if (res.status === 401) return null;

    const json = res.data;
    const membershipType = (json.membershipType as string) ?? null;
    const isUnlimited = (json.isUnlimited as boolean) ?? false;
    const billingCycleStart = (json.billingCycleStart as string) ?? null;
    const billingCycleEnd = (json.billingCycleEnd as string) ?? null;

    let planUsage: CursorPlanUsage | null = null;
    let onDemandUsage: CursorOnDemandUsage | null = null;
    const individual = json.individualUsage as Record<string, unknown> | undefined;
    if (individual?.plan && typeof individual.plan === 'object') {
      const p = individual.plan as Record<string, unknown>;
      planUsage = {
        enabled: (p.enabled as boolean) ?? false,
        used: (p.used as number) ?? 0,
        limit: (p.limit as number) ?? 0,
        remaining: (p.remaining as number) ?? 0,
        totalPercentUsed: (p.totalPercentUsed as number) ?? 0,
        autoPercentUsed: (p.autoPercentUsed as number) ?? 0,
        apiPercentUsed: (p.apiPercentUsed as number) ?? 0,
      };
    }
    if (individual?.onDemand && typeof individual.onDemand === 'object') {
      const o = individual.onDemand as Record<string, unknown>;
      onDemandUsage = {
        enabled: (o.enabled as boolean) ?? false,
        used: (o.used as number) ?? 0,
        limit: (o.limit as number) ?? null,
        remaining: (o.remaining as number) ?? null,
      };
    }

    return {
      email: null,
      membershipType,
      subscriptionStatus: null,
      billingCycleStart,
      billingCycleEnd,
      isUnlimited,
      planUsage,
      onDemandUsage,
    };
  } catch (e) {
    logger.debug('[cursor-quota] fetchCursorUsageSummary failed:', e);
    return null;
  }
}

/**
 * Get Cursor quota info: resolve state.vscdb path (honouring env for multi-env),
 * read auth, then call usage-summary. On API/network failure returns partial
 * info from local auth only (email, membershipType, subscriptionStatus).
 */
export async function getCursorQuotaInfo(
  platform?: CursorPlatform,
  authFromDb?: CursorAuthData | null,
): Promise<{ info: CursorQuotaInfo; auth: CursorAuthData } | null> {
  const stateDbPath = getCursorStateDbPath(platform);
  if (!stateDbPath) return null;

  const auth = authFromDb ?? readCursorAuthFromStateDb(stateDbPath, platform);
  if (!auth || !auth.accessToken) {
    if (auth) {
      return {
        info: {
          email: auth.email,
          membershipType: auth.membershipType,
          subscriptionStatus: auth.subscriptionStatus,
          billingCycleStart: null,
          billingCycleEnd: null,
          isUnlimited: false,
          planUsage: null,
          onDemandUsage: null,
        },
        auth,
      };
    }
    return null;
  }

  const usage = await fetchCursorUsageSummary(auth.accessToken);
  if (usage) {
    return {
      info: { ...usage, email: auth.email, subscriptionStatus: auth.subscriptionStatus },
      auth,
    };
  }

  return {
    info: {
      email: auth.email,
      membershipType: auth.membershipType,
      subscriptionStatus: auth.subscriptionStatus,
      billingCycleStart: null,
      billingCycleEnd: null,
      isUnlimited: false,
      planUsage: null,
      onDemandUsage: null,
    },
    auth,
  };
}

/**
 * Whether Cursor state DB exists at the resolved path (for current or given platform).
 */
export function hasCursorStateDb(platform?: CursorPlatform): boolean {
  return cursorStateDbExists(platform);
}

/**
 * Build usage-report payload for Happy server (key: 'cursor-ide').
 * Server expects tokens.total and cost.total. We send plan usage as tokens and
 * on-demand usage as cost (Cursor API reports on-demand used count; we treat as cost cents for display).
 * Includes plan_requests_limit and on_demand_limit/remaining so the App can show used/limit as percentage.
 */
export function buildCursorUsageReportPayload(info: CursorQuotaInfo): {
  tokens: { total: number; [key: string]: number };
  cost: { total: number; [key: string]: number };
} {
  const planUsed = info.planUsage?.used ?? 0;
  const planRemaining = info.planUsage?.remaining ?? 0;
  const planLimit = info.planUsage?.limit ?? 0;
  const onDemandUsedCents = info.onDemandUsage?.used ?? 0;
  const onDemandLimit = info.onDemandUsage?.limit;
  const onDemandRemaining = info.onDemandUsage?.remaining;

  const tokens: { total: number; [key: string]: number } = {
    total: planUsed,
    plan_requests_used: planUsed,
    plan_requests_remaining: planRemaining,
    plan_requests_limit: planLimit,
  };

  const cost: { total: number; [key: string]: number } = {
    total: onDemandUsedCents,
    on_demand_cents: onDemandUsedCents,
  };
  if (onDemandLimit != null) cost.on_demand_limit = onDemandLimit;
  if (onDemandRemaining != null) cost.on_demand_remaining = onDemandRemaining;

  return { tokens, cost };
}
