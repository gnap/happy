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
    killThisHappy: () => Promise<void>,
    onKillRequested?: () => void
) {
    rpcHandlerManager.registerHandler<KillSessionRequest, KillSessionResponse>('killSession', async () => {
        logger.debug('Kill session request received');

        // Schedule cleanup one tick later so the RPC ack is flushed to the socket
        // before process.exit is called. Awaiting cleanup directly caused a timeout
        // because cleanup ends with process.exit(0) before the ack could be sent.
        // The cleanup function calls flush()+close() before exit, so session-end and
        // any other queued messages are still delivered correctly.
        setImmediate(() => {
            onKillRequested?.();
            void killThisHappy();
        });

        return {
            success: true,
            message: 'Killing happy-cli process'
        };
    });
}
