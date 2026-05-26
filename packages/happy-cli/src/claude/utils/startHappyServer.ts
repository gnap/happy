/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management
 * and (when cursorContext is provided) spawn_subagent for Cursor.
 *
 * spawn_subagent uses MCP Tasks (experimental) so the SDK handles polling
 * server-side: cursor-agent sees a single blocking tool call that resolves
 * when the sub-agent finishes, removing the need for manual get_subagent polling.
*/

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from "@modelcontextprotocol/sdk/experimental/tasks";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { createId } from "@paralleldrive/cuid2";
import { createEnvelope, type SessionEnvelope } from "@slopus/happy-wire";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import type { UserMessage } from "@/api/types";
import { randomUUID } from "node:crypto";
import { SubagentManager } from "@/cursor/subagentManager";
import { extractA2aText, extractA2aTitle } from "@/a2a/parse";
import { buildA2AInboxNotificationWithPreview, getA2AUnreadCount, listA2AInboxMessages } from "@/a2a/inbox";
import { getDaemonA2aMessageUri } from "@/daemon/controlClient";

export interface HappyServerCursorContext {
    getCurrentTurnId: () => string | null;
    sendSessionEnvelope: (envelope: SessionEnvelope) => void;
    workspacePath: string;
    getAbortSignal?: () => AbortSignal;
}

export interface StartHappyServerOptions {
    cursorContext?: HappyServerCursorContext;
    onA2aMessage?: (message: UserMessage) => Promise<void> | void;
    useDaemonA2ARoute?: boolean;
    /** When false, inbox mark MCP tools reject (consume+mark must happen in the active A2A turn). */
    isA2AInboxTurnActive?: () => boolean;
    /** Optional debug snapshot when inbox MCP is blocked (e.g. scope stack describe()). */
    describeInboxMcpScope?: () => string;
}

/** Resolves the live session client (e.g. after offline→online swap). MCP must not capture a one-shot reference. */
export type GetSessionClient = () => ApiSessionClient;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
        return null;
    }

    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return raw;
    }
}

export async function startHappyServer(getSession: GetSessionClient, options?: StartHappyServerOptions) {
    logger.debug(`[happyMCP] server:start sessionId=${getSession().sessionId}`);

    // Handler that sends title updates via the client
    const handler = async (title: string) => {
        logger.info('[happyMCP] change_title called title=%s', title);
        try {
            // Send title as a summary message; await so we catch updateMetadata failure (e.g. socket disconnected)
            const sent = getSession().sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });
            if (sent && typeof (sent as Promise<unknown>).then === 'function') {
                await (sent as Promise<void>);
            }
            logger.info('[happyMCP] change_title success title=%s', title);
            return { success: true };
        } catch (error) {
            logger.info('[happyMCP] change_title rejected error=%s', String(error));
            return { success: false, error: String(error) };
        }
    };

    //
    // Create the MCP server
    //

    const taskStore = new InMemoryTaskStore();
    const taskMessageQueue = new InMemoryTaskMessageQueue();

    const mcp = new McpServer({
        name: 'Happy MCP',
        version: "1.0.1",
    }, {
        taskStore,
        taskMessageQueue,
        capabilities: {
            tasks: {
                requests: { tools: { call: {} } },
            },
        },
    });

    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
        },
    }, async (args) => {
        const response = await handler(args.title);
        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully changed chat title to: "${args.title}"`,
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    const startedByDaemon = options?.useDaemonA2ARoute === true;
    let embeddedA2aUrl = '';
    mcp.registerTool('get_a2a_message_uri', {
        description: 'Get the local HTTP URI that accepts POSTed A2A-compatible messages for this session.',
        title: 'Get A2A Message URI',
        inputSchema: {},
    }, async () => {
        const url = startedByDaemon
            ? (await getDaemonA2aMessageUri(getSession().sessionId) ?? '')
            : embeddedA2aUrl;
        return {
            content: [{ type: 'text', text: url }],
            isError: false,
        };
    });

    const ctx = options?.cursorContext;

    const requireA2AInboxTurn = (action: string) => {
        if (options?.isA2AInboxTurnActive?.()) {
            return null;
        }
        const scopes = options?.describeInboxMcpScope?.() ?? 'unknown';
        logger.debug(
            `[happyMCP] inbox-mcp-blocked action=${action} sessionId=${getSession().sessionId} scopes=${scopes}`,
        );
        return {
            content: [{ type: 'text' as const, text: `${action} is only available during an active A2A inbox turn.` }],
            isError: true,
        };
    };

    mcp.registerTool('list_a2a_messages', {
        description: 'List messages in the A2A inbox. Call at the start of each A2A inbox turn with unreadOnly=true before read/mark.',
        title: 'List Inbox Messages',
        inputSchema: {
            unreadOnly: z.boolean().optional().describe('Only return unread messages'),
            limit: z.number().int().positive().max(100).optional().describe('Maximum number of messages to return'),
        },
    }, async (args) => {
        const blocked = requireA2AInboxTurn('List inbox messages');
        if (blocked) return blocked;
        const inbox = getSession().getA2AInbox();
        const messages = listA2AInboxMessages(inbox, {
            unreadOnly: args.unreadOnly,
            limit: args.limit,
        });
        return {
            content: [{ type: 'text', text: JSON.stringify({
                unreadCount: getA2AUnreadCount(inbox),
                messages,
            }, null, 2) }],
            isError: false,
        };
    });

    mcp.registerTool('read_a2a_message', {
        description: 'Read a single inbox message by id without changing its read state. Call during the A2A inbox turn for each unread id you will handle.',
        title: 'Read Inbox Message',
        inputSchema: {
            id: z.string().describe('A2A inbox message id'),
        },
    }, async (args) => {
        const blocked = requireA2AInboxTurn('Read inbox message');
        if (blocked) return blocked;
        const message = getSession().getA2AInbox().messages.find((item) => item.id === args.id);
        if (!message) {
            return { content: [{ type: 'text', text: `A2A message ${args.id} not found.` }], isError: true };
        }
        return {
            content: [{ type: 'text', text: JSON.stringify(message, null, 2) }],
            isError: false,
        };
    });

    mcp.registerTool('mark_a2a_message_read', {
        description: 'Mark a single inbox message as read in this A2A inbox turn, after read_a2a_message.',
        title: 'Mark Inbox Message Read',
        inputSchema: {
            id: z.string().describe('A2A inbox message id'),
        },
    }, async (args) => {
        const blocked = requireA2AInboxTurn('Mark inbox message read');
        if (blocked) return blocked;
        getSession().markA2AMessageRead(args.id);
        const message = getSession().getA2AInbox().messages.find((item) => item.id === args.id);
        return {
            content: [{ type: 'text', text: JSON.stringify({
                id: args.id,
                readAt: message?.readAt ?? null,
            }, null, 2) }],
            isError: false,
        };
    });

    mcp.registerTool('mark_a2a_messages_read', {
        description: 'Mark multiple inbox messages as read in this A2A inbox turn after you have read and handled them.',
        title: 'Mark Inbox Messages Read',
        inputSchema: {
            ids: z.array(z.string()).min(1).describe('A2A inbox message ids'),
        },
    }, async (args) => {
        const blocked = requireA2AInboxTurn('Mark inbox messages read');
        if (blocked) return blocked;
        getSession().markA2AMessagesRead(args.ids);
        const inbox = getSession().getA2AInbox();
        const updated = inbox.messages.filter((item) => args.ids.includes(item.id));
        return {
            content: [{ type: 'text', text: JSON.stringify({
                ids: args.ids,
                updated,
            }, null, 2) }],
            isError: false,
        };
    });

    const toolNames: string[] = ['change_title', 'get_a2a_message_uri', 'list_a2a_messages', 'read_a2a_message', 'mark_a2a_message_read', 'mark_a2a_messages_read'];

    let subagentManager: SubagentManager | null = null;

    if (options?.cursorContext) {
        const ctx = options.cursorContext;

        // Map subagent id → MCP task id so onTurnDone can complete the task.
        const pendingSpawnTasks = new Map<string, string>();

        subagentManager = new SubagentManager({
            cwd: ctx.workspacePath,
            onChildEvent: (agentId, ev) => {
                const turnId = ctx.getCurrentTurnId();
                if (!turnId) return;
                ctx.sendSessionEnvelope(createEnvelope('agent', ev, { turn: turnId, subagent: agentId }));
            },
            onTurnDone: (info) => {
                const turnId = ctx.getCurrentTurnId();
                if (!turnId) return;
                if (info.status !== 'running') {
                    ctx.sendSessionEnvelope(createEnvelope('agent', { t: 'tool-call-end', call: info.id }, { turn: turnId }));
                }

                const taskId = pendingSpawnTasks.get(info.id);
                if (taskId) {
                    const status = info.error ? 'failed' : 'completed';
                    const result = info.error
                        ? { content: [{ type: 'text' as const, text: `Error: ${info.error}` }], isError: true }
                        : { content: [{ type: 'text' as const, text: info.summary || 'Task completed.' }], isError: false };
                    taskStore.storeTaskResult(taskId, status, result).catch(e => {
                        logger.debug(`[happyMCP] storeTaskResult error: ${e}`);
                    });
                    pendingSpawnTasks.delete(info.id);
                }

                logger.debug(`[happyMCP] subagent turn done id=${info.id.slice(0, 8)} status=${info.status} summary=${(info.summary ?? '').slice(0, 80)}`);
            },
        });

        // ── spawn_subagent (task-augmented) ─────────────────────────────
        // Uses MCP Tasks so the SDK polls server-side; cursor-agent sees
        // a single blocking tool call that resolves when the sub-agent finishes.
        mcp.experimental.tasks.registerToolTask('spawn_subagent', {
            title: 'Spawn Sub-agent',
            description: 'Run a sub-agent to complete a subtask. Returns immediately with {id, status}. '
                + 'You MUST then call get_subagent(id) to poll until status is idle/completed/error, then reply to the user with the summary. '
                + 'Do not leave the user without a reply: after spawning, call get_subagent(id) (retry every few seconds if status is "running") until you get a result, then answer the user. '
                + 'If the result is returned directly (without needing to poll), use it immediately.',
            inputSchema: {
                prompt: z.string().describe('The task or question to send to the sub-agent'),
                title: z.string().optional().describe('Optional short title for the sub-agent (e.g. "Find auth code")'),
            },
            execution: { taskSupport: 'optional' },
        }, {
            createTask: async (args: { prompt: string; title?: string }, extra: any) => {
                const turnId = ctx.getCurrentTurnId();
                if (!turnId) throw new Error('No active turn; cannot spawn sub-agent.');

                const task = await extra.taskStore.createTask({});
                const id = createId();
                const title = args.title || 'Sub-agent';

                ctx.sendSessionEnvelope(createEnvelope('agent', {
                    t: 'tool-call-start',
                    call: id,
                    name: 'Task',
                    title,
                    description: args.prompt.slice(0, 200),
                    args: { prompt: args.prompt },
                }, { turn: turnId }));

                pendingSpawnTasks.set(id, task.taskId);
                subagentManager!.spawn(id, args.prompt, title);
                logger.debug(`[happyMCP] spawn_subagent (task) id=${id.slice(0, 8)} taskId=${task.taskId.slice(0, 8)}`);

                return { task };
            },
            getTask: async (_args: any, extra: any) => {
                return await extra.taskStore.getTask(extra.taskId);
            },
            getTaskResult: async (_args: any, extra: any) => {
                return await extra.taskStore.getTaskResult(extra.taskId);
            },
        });
        toolNames.push('spawn_subagent');

        // ── message_subagent ────────────────────────────────────────────
        mcp.registerTool('message_subagent', {
            description: 'Send a follow-up message to an existing sub-agent for multi-turn conversation. '
                + 'Only works when the sub-agent is idle (finished its previous turn). Returns immediately.',
            title: 'Message Sub-agent',
            inputSchema: {
                id: z.string().describe('The sub-agent ID returned by spawn_subagent'),
                message: z.string().describe('The follow-up message to send'),
            },
        }, async (args) => {
            const turnId = ctx.getCurrentTurnId();
            if (!turnId) {
                return { content: [{ type: 'text', text: 'No active turn.' }], isError: true };
            }
            const result = subagentManager!.message(args.id, args.message);
            if (!result.ok) {
                return { content: [{ type: 'text', text: result.error }], isError: true };
            }
            const info = result.info;

            // Do not send another tool-call-start: same call id would create a second Task message and break sidechain (children would stay on the first message, so toolbox disappears).
            logger.debug(`[happyMCP] message_subagent id=${args.id.slice(0, 8)} turn=${info.turnCount}`);
            return {
                content: [{ type: 'text', text: JSON.stringify({ id: info.id, status: info.status, turnCount: info.turnCount }) }],
                isError: false,
            };
        });
        toolNames.push('message_subagent');

        // ── get_subagent ────────────────────────────────────────────────
        mcp.registerTool('get_subagent', {
            description: 'Get the status and result of sub-agent(s). Call this after spawn_subagent(id) to poll for the result. '
                + 'When status is idle or completed, use the summary field to reply to the user. If status is running, call again after a short wait. '
                + 'If id is omitted, returns all sub-agents.',
            title: 'Get Sub-agent Status',
            inputSchema: {
                id: z.string().optional().describe('Sub-agent ID. Omit to list all sub-agents.'),
            },
        }, async (args) => {
            const agents = subagentManager!.get(args.id);
            if (args.id && agents.length === 0) {
                return { content: [{ type: 'text', text: `Sub-agent ${args.id} not found.` }], isError: true };
            }
            return {
                content: [{ type: 'text', text: JSON.stringify({ agents }) }],
                isError: false,
            };
        });
        toolNames.push('get_subagent');

        // ── stop_subagent ───────────────────────────────────────────────
        mcp.registerTool('stop_subagent', {
            description: 'Stop a running sub-agent. Use this to cancel a sub-agent that is no longer needed.',
            title: 'Stop Sub-agent',
            inputSchema: {
                id: z.string().describe('The sub-agent ID to stop'),
            },
        }, async (args) => {
            const turnId = ctx.getCurrentTurnId();
            const result = subagentManager!.stop(args.id);
            if (!result.ok) {
                return { content: [{ type: 'text', text: result.error }], isError: true };
            }
            if (turnId) {
                ctx.sendSessionEnvelope(createEnvelope('agent', { t: 'tool-call-end', call: args.id }, { turn: turnId }));
            }
            logger.debug(`[happyMCP] stop_subagent id=${args.id.slice(0, 8)}`);
            return {
                content: [{ type: 'text', text: JSON.stringify({ id: result.info.id, status: result.info.status }) }],
                isError: false,
            };
        });
        toolNames.push('stop_subagent');
    }

    const transport = new StreamableHTTPServerTransport({
        // NOTE: Returning session id here will result in claude
        // sdk spawn to fail with `Invalid Request: Server already initialized`
        sessionIdGenerator: undefined
    });
    await mcp.connect(transport);

    let a2aServer: ReturnType<typeof createServer> | null = null;
    if (!startedByDaemon) {
        //
        // Create the local HTTP A2A server.
        //
        a2aServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', 'content-type');
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

            if (req.method === 'OPTIONS') {
                res.writeHead(204).end();
                return;
            }

            if (req.method !== 'POST' || req.url !== '/a2a/message') {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
                return;
            }

            try {
                const body = await readJsonBody(req);
                const text = extractA2aText(body);
                const title = extractA2aTitle(body);
                if (!text) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing message text' }));
                    return;
                }

                if (!options?.onA2aMessage) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'A2A message handler not configured' }));
                    return;
                }

                getSession().recordA2AMessage({
                    id: randomUUID(),
                    title,
                    text,
                    createdAt: Date.now(),
                });

                await options.onA2aMessage({
                    role: 'user',
                    content: { type: 'text', text: buildA2AInboxNotificationWithPreview(getSession().getA2AInbox()) },
                    meta: { origin: 'a2a', a2aTrigger: true },
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: message }));
            }
        });

        embeddedA2aUrl = await new Promise<string>((resolve, reject) => {
            a2aServer!.listen(0, '127.0.0.1', () => {
                const addr = a2aServer!.address();
                if (addr && typeof addr === 'object') {
                    resolve(`http://127.0.0.1:${addr.port}/a2a/message`);
                    return;
                }
                reject(new Error('Failed to get A2A server address'));
            });
            a2aServer!.on('error', reject);
        });

        logger.debug(`[happyMCP] a2a:server ready sessionId=${getSession().sessionId} url=${embeddedA2aUrl}`);
    } else {
        logger.debug(`[happyMCP] a2a:using-daemon-route sessionId=${getSession().sessionId}`);
    }

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        const closeSocket = () => {
            if (!req.socket.destroyed) {
                req.socket.destroy();
            }
        };
        res.once('finish', closeSocket);
        res.once('close', closeSocket);
        try {
            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        }
    });
    server.keepAliveTimeout = 2_000;
    server.headersTimeout = 5_000;

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    logger.debug(`[happyMCP] server:ready sessionId=${getSession().sessionId} url=${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        a2aUrl: embeddedA2aUrl,
        toolNames,
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${getSession().sessionId}`);
            subagentManager?.dispose();
            mcp.close();
            server.close();
            a2aServer?.close();
        }
    }
}
