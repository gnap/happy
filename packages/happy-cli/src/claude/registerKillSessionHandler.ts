import { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import { logger } from "@/lib";

interface KillSessionRequest {
    // No parameters needed
}

interface KillSessionResponse {
    success: boolean;
    message: string;
}


export function registerKillSessionHandler(
    rpcHandlerManager: RpcHandlerManager,
    killThisHappy: () => Promise<void>
) {
    rpcHandlerManager.registerHandler<KillSessionRequest, KillSessionResponse>('killSession', async () => {
        logger.debug('Kill session request received');

        // Await full cleanup so we only return success after session-end is sent and process is exiting.
        // Returning success before completion caused: first archive attempt didn't actually archive,
        // then socket closed so second attempt got "method not found".
        try {
            await killThisHappy();
            return {
                success: true,
                message: 'Killing happy-cli process'
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.debug('Kill session failed', { error: msg });
            return {
                success: false,
                message: msg
            };
        }
    });
}
