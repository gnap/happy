/**
 * Whether the pre-v2 lifecycle names are still served.
 *
 * The switch is what makes the removal a configuration flip and a rollback instead of a code
 * revert. While it is true the old surfaces behave exactly as they always have:
 *
 * - machine RPC `killSession`
 * - the original LAN `POST /lan/sessions/:id/archive` (always delete semantics)
 * - control server `POST /archive-session` (the `happy daemon archive-session` road)
 *
 * With it false they disappear as if this build predated them — an unknown method, a 404 — while
 * the canonical `deleteSession` / `archiveSession` and `/lan/v2/...` routes are untouched.
 *
 * It defaults to true. The gate for flipping it (and only later deleting the code) is in
 * `docs/plans/backward-compatible-removals.md`: a full release window with no alias traffic from
 * a current client, and no server-relayed alias call at all in that window.
 */
export function legacyLifecycleEnabled(): boolean {
    const raw = (process.env.HAPPY_LEGACY_LIFECYCLE ?? '').trim().toLowerCase();
    return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}
