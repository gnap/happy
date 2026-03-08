import { useEffect, useRef, useState, useCallback } from 'react';
import { useLocalSetting, storage } from '@/sync/storage';
import { getToolCallFullContent } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { ToolCall } from '@/sync/typesMessage';

export type LazyToolInputState = {
    /** Resolved input: full content once loaded, truncated input while loading / on error */
    resolvedInput: Record<string, unknown>;
    loading: boolean;
    error: string | null;
    retry: () => void;
};

/**
 * Hook for lazy-loading full tool input content via RPC.
 *
 * When the CLI is started with HAPPY_LAZY_TOOL_CONTENT=1, large string fields
 * in Cursor tool inputs are truncated before being sent over the wire, and
 * tool.lazyContent is set to true.
 *
 * This hook fetches the full content from the CLI's on-disk cache via RPC when
 * the detail view opens, then writes the result back into the Zustand store and
 * persists it to SQLite so subsequent opens show the full diff without a network
 * round-trip.
 */
export function useLazyToolInput(tool: ToolCall, sessionId?: string, messageId?: string): LazyToolInputState {
    const lazyEnabled = useLocalSetting('lazyLoadToolContent');
    const isLazy = tool.lazyContent === true;
    const callId = tool.callId;
    const shouldFetch = isLazy && lazyEnabled && !!sessionId && !!callId;

    const [loading, setLoading] = useState(shouldFetch);
    const [error, setError] = useState<string | null>(null);
    const fetchedRef = useRef(false);

    const fetch = useCallback(async () => {
        if (!shouldFetch) return;
        setLoading(true);
        setError(null);
        try {
            const result = await getToolCallFullContent(sessionId!, callId!);
            if (result.success && result.args) {
                // Update the Zustand store + reducer state so the message no longer
                // carries lazyContent and shows full content everywhere.
                if (messageId) {
                    const updated = storage.getState().resolveToolCallLazyContent(sessionId!, messageId, result.args);
                    if (updated) {
                        // Persist the updated reducer state to SQLite in the background.
                        void sync.saveSessionCache(sessionId!);
                    }
                }
                setError(null);
            } else {
                setError(result.error ?? 'Failed to load full content');
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
        // Once the store is updated (lazyContent cleared), tool.input already has full
        // content — the hook just reflects the current tool state.
        resolvedInput: tool.input as Record<string, unknown>,
        loading,
        error,
        retry: fetch,
    };
}
