import { useEffect, useRef, useState, useCallback } from 'react';
import { useLocalSetting, storage } from '@/sync/storage';
import { getToolCallFullContent } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { ToolCall } from '@/sync/typesMessage';
import { hasLazyResultMarker } from './toolResult';

export type LazyToolInputState = {
    /** Resolved input: full content once loaded, truncated input while loading / on error */
    resolvedInput: Record<string, unknown>;
    loading: boolean;
    error: string | null;
    retry: () => void;
};

function hasLazyResult(tool: ToolCall): boolean {
    return hasLazyResultMarker(tool.result);
}

/**
 * Hook for lazy-loading full tool content (input args and/or result) via RPC.
 *
 * When the CLI is started with HAPPY_LAZY_TOOL_CONTENT=1:
 * - Large input fields (streamContent, old_string, new_string, content) are truncated;
 *   tool.lazyContent is set to true.
 * - Large result fields (beforeFullFileContent, afterFullFileContent) are truncated;
 *   the lazy marker is set on the result payload for the App to fetch full content.
 *
 * A single RPC call fetches both full args and full result; each is written back into
 * the Zustand store and persisted to SQLite so subsequent opens skip the round-trip.
 */
export function useLazyToolInput(tool: ToolCall, sessionId?: string, messageId?: string): LazyToolInputState {
    const lazyEnabled = useLocalSetting('lazyLoadToolContent');
    const isLazyInput = tool.lazyContent === true;
    const isLazyResult = hasLazyResult(tool);
    const callId = tool.callId;
    const shouldFetch = (isLazyInput || isLazyResult) && lazyEnabled && !!sessionId && !!callId;

    const [loading, setLoading] = useState(shouldFetch);
    const [error, setError] = useState<string | null>(null);
    const fetchedRef = useRef(false);

    const fetch = useCallback(async () => {
        if (!shouldFetch) return;
        setLoading(true);
        setError(null);
        try {
            const rpcResult = await getToolCallFullContent(sessionId!, callId!);
            if (rpcResult.success && (rpcResult.args || rpcResult.result !== undefined)) {
                if (messageId) {
                    let didUpdate = false;
                    if (rpcResult.args) {
                        const updated = storage.getState().resolveToolCallLazyContent(sessionId!, messageId, rpcResult.args);
                        if (updated) didUpdate = true;
                    }
                    if (rpcResult.result !== undefined) {
                        const updated = storage.getState().resolveToolCallLazyResult(sessionId!, messageId, rpcResult.result);
                        if (updated) didUpdate = true;
                    }
                    if (didUpdate) {
                        void sync.saveSessionCache(sessionId!);
                    }
                }
                setError(null);
            } else {
                setError(rpcResult.error ?? 'Failed to load full content');
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, [shouldFetch, sessionId, callId, messageId]);

    useEffect(() => {
        if (shouldFetch && !fetchedRef.current) {
            fetchedRef.current = true;
            fetch();
        }
    }, [shouldFetch, fetch]);

    return {
        // Once the store is updated, tool.input / tool.result already have full content.
        resolvedInput: tool.input as Record<string, unknown>,
        loading,
        error,
        retry: fetch,
    };
}
