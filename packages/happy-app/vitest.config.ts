import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    // React Native's build-time flag. Metro inlines it, so the source branches on it freely and
    // never guards for its absence — which in the node environment means every test that reaches
    // such a branch dies with `__DEV__ is not defined` instead of exercising it. Inlined here for
    // the same reason, rather than on `globalThis` at runtime.
    define: {
        __DEV__: 'true',
    },
    test: {
        globals: false,
        environment: 'node',
        include: ['sources/**/*.{spec,test}.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/**',
                'dist/**',
                '**/*.d.ts',
                '**/*.config.*',
                '**/mockData/**',
            ],
        },
    },
    resolve: {
        alias: {
            '@': resolve('./sources'),
            // expo-sqlite pulls in react-native, whose Flow-typed entry point Rollup cannot parse
            // — so importing anything that reaches `sessionCacheDB` failed at load time and the
            // tests never ran. Nothing under test opens a real database, so the native module is
            // kept out of the graph rather than dragging the React Native runtime in to satisfy it.
            'expo-sqlite': resolve('./sources/test-utils/expoSqliteStub.ts'),
        },
    },
})