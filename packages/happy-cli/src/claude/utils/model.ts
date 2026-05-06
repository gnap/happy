const NON_API_CLAUDE_MODEL_CODES = new Set([
    'adaptiveUsage',
    'default',
    'auto',
]);

/**
 * App model selectors can include UI modes that are not valid Claude Code
 * --model values. Returning undefined lets Claude Code use its configured
 * default, including ANTHROPIC_MODEL from a custom provider profile.
 */
export function normalizeClaudeModelForSdk(model: string | null | undefined): string | undefined {
    const trimmed = typeof model === 'string' ? model.trim() : '';
    if (!trimmed) return undefined;
    if (NON_API_CLAUDE_MODEL_CODES.has(trimmed)) return undefined;
    return trimmed;
}
