/**
 * Converts Claude stream-json output (from `claude -p --output-format stream-json --verbose`)
 * into the app's Message[] format consumable by computeMessageClusters().
 *
 * Usage: npx tsx e2e/fixtures/convert-stream.ts < input.jsonl > output.json
 */

import type { Message, ToolCallMessage, UserTextMessage, AgentTextMessage } from '../../sources/sync/typesMessage';
import type { ToolCall } from '../../sources/sync/typesMessage';

interface StreamEvent {
    type: string;
    subtype?: string;
    message?: {
        id?: string;
        role?: string;
        content?: Array<{
            type: string;
            text?: string;
            id?: string;
            name?: string;
            input?: Record<string, unknown>;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
            thinking?: string;
        }>;
    };
    parent_tool_use_id?: string | null;
    timestamp?: string;
}

interface ParsedToolCall {
    id: string;
    name: string;
    input: Record<string, unknown>;
    createdAt: number;
    state: ToolCall['state'];
    children: Message[];
}

async function main() {
    const chunks: string[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const raw = chunks.join('');

    const lines = raw.trim().split('\n').filter((l) => l.trim());
    const events: StreamEvent[] = lines.map((l) => JSON.parse(l));

    const toolCalls = new Map<string, ParsedToolCall>();
    const userTexts: UserTextMessage[] = [];
    const agentTexts: AgentTextMessage[] = [];
    const messages: Message[] = [];
    let lastTimestamp = Date.now();
    let msgCounter = 0;

    for (const event of events) {
        if (event.type === 'system') continue;
        if (event.type === 'result') continue;

        const msg = event.message;
        if (!msg?.content) continue;

        // Parse timestamp for message ordering
        if (event.timestamp) {
            lastTimestamp = new Date(event.timestamp).getTime();
        }

        for (const block of msg.content) {
            if (block.type === 'tool_use') {
                const tcId = `tool-${block.id || ++msgCounter}`;
                const tc: ParsedToolCall = {
                    id: tcId,
                    name: block.name || '',
                    input: block.input || {},
                    createdAt: lastTimestamp,
                    state: 'running',
                    children: [],
                };
                toolCalls.set(block.id || tcId, tc);
            } else if (block.type === 'tool_result') {
                // Update the corresponding tool call state
                const tc = toolCalls.get(block.tool_use_id || '');
                if (tc) {
                    tc.state = 'completed';
                    // If TaskCreate, try to extract task ID from result
                    if (tc.name === 'TaskCreate' && typeof block.content === 'string') {
                        const match = block.content.match(/Task #(\d+) created/);
                        if (match) {
                            tc.input = { ...tc.input, taskId: match[1] };
                        }
                    }
                }
            } else if (block.type === 'text' || block.type === 'thinking') {
                // Agent text message
                const text = block.text || block.thinking || '';
                if (text.trim()) {
                    const atMsg: AgentTextMessage = {
                        kind: 'agent-text',
                        id: `agent-${++msgCounter}`,
                        localId: null,
                        createdAt: lastTimestamp,
                        text,
                        isThinking: block.type === 'thinking',
                    };
                    agentTexts.push(atMsg);
                }
            }
        }
    }

    // Convert parsed tool calls to ToolCallMessage[]
    for (const tc of toolCalls.values()) {
        const msg: ToolCallMessage = {
            kind: 'tool-call',
            id: tc.id,
            localId: null,
            createdAt: tc.createdAt,
            tool: {
                name: tc.name,
                state: tc.state,
                input: tc.input,
                createdAt: tc.createdAt,
                startedAt: tc.state === 'running' ? tc.createdAt : null,
                completedAt: tc.state === 'completed' ? tc.createdAt + 1000 : null,
                description: null,
            },
            children: tc.children,
            meta: undefined,
        };
        messages.push(msg);
    }

    // Sort by createdAt to maintain temporal ordering
    const allMessages: Message[] = [
        ...userTexts,
        ...agentTexts,
        ...messages,
    ].sort((a, b) => a.createdAt - b.createdAt);

    console.log(JSON.stringify(allMessages, null, 2));
}

main().catch((err) => {
    console.error('Conversion failed:', err);
    process.exit(1);
});
