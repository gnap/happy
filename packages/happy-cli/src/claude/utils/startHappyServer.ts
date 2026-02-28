/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management
 * and (when cursorContext is provided) spawn_subagent for Cursor.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { createId } from "@paralleldrive/cuid2";
import { createEnvelope, type SessionEnvelope } from "@slopus/happy-wire";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";
import { runSubagent } from "@/cursor/runSubagent";

export interface HappyServerCursorContext {
    getCurrentTurnId: () => string | null;
    sendSessionEnvelope: (envelope: SessionEnvelope) => void;
    workspacePath: string;
    getAbortSignal?: () => AbortSignal;
}

export interface StartHappyServerOptions {
    cursorContext?: HappyServerCursorContext;
}

export async function startHappyServer(client: ApiSessionClient, options?: StartHappyServerOptions) {
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId}`);

    // Handler that sends title updates via the client
    const handler = async (title: string) => {
        logger.info('[happyMCP] change_title called title=%s', title);
        try {
            // Send title as a summary message; await so we catch updateMetadata failure (e.g. socket disconnected)
            const sent = client.sendClaudeSessionMessage({
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

    const mcp = new McpServer({
        name: "Happy MCP",
        version: "1.0.0",
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

    const toolNames: string[] = ['change_title'];

    if (options?.cursorContext) {
        const ctx = options.cursorContext;
        mcp.registerTool('spawn_subagent', {
            description: 'Run a sub-agent to complete a subtask. The sub-agent\'s output is shown nested in this conversation. Use this when you want to delegate a focused task (e.g. research, refactor one module) and then use its result.',
            title: 'Spawn Sub-agent',
            inputSchema: {
                prompt: z.string().describe('The task or question to send to the sub-agent'),
                title: z.string().optional().describe('Optional short title for the sub-agent (e.g. "Find auth code")'),
            },
        }, async (args) => {
            const turnId = ctx.getCurrentTurnId();
            if (!turnId) {
                return {
                    content: [{ type: 'text', text: 'No active turn; cannot spawn sub-agent.' }],
                    isError: true,
                };
            }
            const subagentId = createId();
            const send = (ev: Parameters<typeof createEnvelope>[1]) => {
                ctx.sendSessionEnvelope(createEnvelope('agent', ev, { turn: turnId, subagent: subagentId }));
            };
            send({ t: 'start', ...(args.title ? { title: args.title } : {}) });
            logger.debug(`[happyMCP] spawn_subagent start subagentId=${subagentId.slice(0, 8)}... prompt length=${args.prompt.length}`);
            try {
                const result = await runSubagent({
                    cwd: ctx.workspacePath,
                    prompt: args.prompt,
                    signal: ctx.getAbortSignal?.(),
                    onEvent: (ev) => send(ev),
                });
                send({ t: 'stop' });
                if (result.success) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: result.summary
                                    ? `Sub-agent completed.\n\nSummary: ${result.summary}`
                                    : 'Sub-agent completed.',
                            },
                        ],
                        isError: false,
                    };
                }
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Sub-agent failed: ${result.error}${result.summary ? `\n\nOutput so far: ${result.summary}` : ''}`,
                        },
                    ],
                    isError: true,
                };
            } catch (err) {
                send({ t: 'stop' });
                const msg = err instanceof Error ? err.message : String(err);
                logger.debug('[happyMCP] spawn_subagent error:', err);
                return {
                    content: [{ type: 'text', text: `Sub-agent error: ${msg}` }],
                    isError: true,
                };
            }
        });
        toolNames.push('spawn_subagent');
    }

    const transport = new StreamableHTTPServerTransport({
        // NOTE: Returning session id here will result in claude
        // sdk spawn to fail with `Invalid Request: Server already initialized`
        sessionIdGenerator: undefined
    });
    await mcp.connect(transport);

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        try {
            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    logger.debug(`[happyMCP] server:ready sessionId=${client.sessionId} url=${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        toolNames,
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            mcp.close();
            server.close();
        }
    }
}
