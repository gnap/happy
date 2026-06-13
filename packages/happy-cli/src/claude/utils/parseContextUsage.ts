/**
 * Parse the Claude `/context` command output into a structured context-usage payload.
 * The output looks like:
 *
 *   ## Context Usage
 *   **Model:** deepseek-v4-pro[1m]
 *   **Tokens:** 19.1k / 1m (2%)
 *   ...
 *   | Free space | 980.9k | 98.1% |
 */
export interface ParsedContextUsage {
    currentTokens: number;
    maxTokens: number;
    model: string;
    breakdown: {
        systemPrompt: number;
        systemTools: number;
        customAgents: number;
        skills: number;
        messages: number;
        freeSpace: number;
    };
}

function parseTokenNumber(raw: string): number {
    const cleaned = raw.replace(/,/g, '').trim();
    if (cleaned.endsWith('k') || cleaned.endsWith('K')) {
        return Math.round(parseFloat(cleaned.slice(0, -1)) * 1000);
    }
    if (cleaned.endsWith('m') || cleaned.endsWith('M')) {
        return Math.round(parseFloat(cleaned.slice(0, -1)) * 1000000);
    }
    return Math.round(parseFloat(cleaned));
}

export function parseContextUsageOutput(text: string): ParsedContextUsage | null {
    try {
        // Extract model line: **Model:** deepseek-v4-pro[1m]
        const modelMatch = text.match(/\*\*Model:\*\*\s*(.+)/);
        const model = modelMatch ? modelMatch[1].trim() : 'unknown';

        // Extract tokens line: **Tokens:** 19.1k / 1m (2%)
        const tokensMatch = text.match(/\*\*Tokens:\*\*\s*([\d.,]+[km]?)\s*\/\s*([\d.,]+[km]?)\s*\((\d+)%\)/i);
        if (!tokensMatch) return null;

        const currentTokens = parseTokenNumber(tokensMatch[1]);
        const maxTokens = parseTokenNumber(tokensMatch[2]);

        // Parse breakdown table rows
        const breakdown = {
            systemPrompt: 0,
            systemTools: 0,
            customAgents: 0,
            skills: 0,
            messages: 0,
            freeSpace: 0,
        };

        const tablePattern = /\|\s*(System prompt|System tools|Custom agents|Skills|Messages|Free space)\s*\|\s*([\d.,]+[km]?)\s*\|/gi;
        let match;
        while ((match = tablePattern.exec(text)) !== null) {
            const category = match[1].toLowerCase().replace(/\s+/g, '') as keyof typeof breakdown;
            const value = parseTokenNumber(match[2]);
            // Map "System prompt" -> systemPrompt, "Free space" -> freeSpace, etc.
            const keyMap: Record<string, keyof typeof breakdown> = {
                'systemprompt': 'systemPrompt',
                'systemtools': 'systemTools',
                'customagents': 'customAgents',
                'skills': 'skills',
                'messages': 'messages',
                'freespace': 'freeSpace',
            };
            const key = keyMap[category];
            if (key) breakdown[key] = value;
        }

        return { currentTokens, maxTokens, model, breakdown };
    } catch {
        return null;
    }
}

/**
 * Build a ClaudeTurnUsagePayload-compatible object from the parsed context data.
 * Replaces the API-level usage with the internal context counter values.
 */
export function buildContextUsagePayload(
    parsed: ParsedContextUsage,
): {
    currentTokens: number;
    maxTokens: number;
    pct: number;
    model: string;
    breakdown: ParsedContextUsage['breakdown'];
    fetchedAt: number;
} {
    return {
        currentTokens: parsed.currentTokens,
        maxTokens: parsed.maxTokens,
        pct: Math.round((parsed.currentTokens / parsed.maxTokens) * 100),
        model: parsed.model,
        breakdown: parsed.breakdown,
        fetchedAt: Date.now(),
    };
}
