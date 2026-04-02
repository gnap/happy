/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management.
 * Uses stateless StreamableHTTP: each request gets a fresh McpServer + transport.
 * This is required by MCP SDK >=1.27 which rejects reuse of an already-connected transport.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { ApiSessionClient } from '@/api/apiSession';
import { logger } from '@/ui/logger';

function createMcpServer(handler: (title: string) => Promise<{ success: boolean; error?: string }>): McpServer {
    const mcp = new McpServer({
        name: 'Happy MCP',
        version: '1.0.0',
    });

    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
        },
    }, async (args) => {
        const response = await handler(args.title);
        logger.debug('[happyMCP] Response:', response);
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
        }
        return {
            content: [
                {
                    type: 'text',
                    text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                },
            ],
            isError: true,
        };
    });

    return mcp;
}

export async function startHappyServer(client: ApiSessionClient): Promise<{ url: string; toolNames: string[]; stop: () => void }> {
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId}`);

    const handler = async (title: string): Promise<{ success: boolean; error?: string }> => {
        logger.info('[happyMCP] change_title called title=%s', title);
        try {
            const sent = client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID(),
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

    const server = createServer(async (req, res) => {
        const mcp = createMcpServer(handler);
        try {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });
            await mcp.connect(transport);
            res.on('close', () => {
                transport.close();
                mcp.close();
            });
            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug('Error handling request:', error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            mcp.close();
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    logger.debug(`[happyMCP] server:ready sessionId=${client.sessionId} url=${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        toolNames: ['change_title'],
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            server.close();
        },
    };
}
