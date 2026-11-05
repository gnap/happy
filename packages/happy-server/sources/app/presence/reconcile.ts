import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { sessionPresenceStartupReconciledCounter } from "@/app/monitoring/metrics2";

/**
 * A fresh server has no presence, and the database's `active` flags were written by the process
 * that died with the previous server. Leave them and every session reads online until the
 * ten-minute sweep, including ones whose CLI is long gone.
 *
 * Clearing them is the honest baseline: a session that is still running reconnects and its next
 * snapshot restores `active` with a fresh timestamp. None of this is safe with more than one
 * server node — another node's live sessions would be marked offline here — so multi-node is
 * explicitly refused until presence is shared through Redis rather than held in process memory.
 */
export async function reconcileSessionPresenceOnStartup(): Promise<void> {
    if (process.env.HAPPY_MULTI_NODE === '1') {
        log({ module: 'presence' }, 'Startup presence reconciliation skipped for multi-node deployment');
        return;
    }
    try {
        const result = await db.session.updateMany({
            where: { active: true },
            data: { active: false },
        });
        if (result.count > 0) {
            sessionPresenceStartupReconciledCounter.inc(result.count);
            log({ module: 'presence' }, `Startup reconciliation marked ${result.count} session(s) inactive`);
        }
    } catch (error) {
        log({ module: 'presence', level: 'error' }, `Startup presence reconciliation failed: ${error}`);
    }
}
