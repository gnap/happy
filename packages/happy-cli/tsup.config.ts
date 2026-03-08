import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    lib: 'src/lib.ts',
    'codex/happyMcpStdioBridge': 'src/codex/happyMcpStdioBridge.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  clean: true,
  sourcemap: false,
  outDir: 'dist',
  outExtension({ format }) {
    return {
      js: format === 'esm' ? '.mjs' : '.cjs',
      dts: format === 'esm' ? '.d.mts' : '.d.cts',
    }
  },
})
