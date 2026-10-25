/**
 * The React Native entry point for Vitest.
 *
 * RN's real index.js is Flow-typed, which Rollup cannot parse — the same reason `expo-sqlite` is
 * aliased below. Nothing under test touches the real interaction manager, and the one behavior
 * the code asks of it — "run this after the current interaction" — is synchronous here.
 */
export const InteractionManager = {
    runAfterInteractions: (callback: () => void) => {
        callback();
        return { cancel: () => undefined };
    },
};
