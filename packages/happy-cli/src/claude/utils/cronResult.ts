/**
 * The id Claude gives a schedule, read from the tool result that created it.
 *
 * `CronCreate` is answered with the job's own id (`Scheduled recurring job bcd6a541 …`), and that
 * id is what `CronDelete` names later. The tool call's id is only this stream's name for the
 * request: using it as the display key was why a delete never removed the schedule it cancelled —
 * the map held `call_…` and the delete carried the job's id.
 *
 * Best-effort on purpose: the result is prose, so a wording change loses the mapping, not the
 * feature. The Stop hook's `session_crons` stays the authoritative list.
 */
export function cronIdFromCreateResult(content: unknown): string | null {
    const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
            ? content.map((part) => {
                const value = part as { text?: unknown } | null;
                return typeof value?.text === 'string' ? value.text : '';
            }).join('\n')
            : '';
    const match = /Scheduled (?:recurring job|one-shot task) ([0-9a-z]+)/i.exec(text);
    return match ? match[1] : null;
}
