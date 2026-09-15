import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/client/index.js'],
  format: ['iife'],
  platform: 'browser',
  target: 'es2020',
  deps: { neverBundle: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'] },
  clean: false,
  suppressWarnings: [/MISSING_NAME_OPTION_FOR_IIFE_EXPORT/],
  dts: false,
  sourcemap: false,
  splitting: false,
  minify: false,
  outDir: 'lib',
  outExtensions() {
    return { js: '.js' };
  },
  banner: {
    js: `window.__ModuleLoader__.load({\n  id: 'dsh-fairy-visual',\n  factory: (require) => {\n    const module = { exports: {} };\n    return void 0, `,
  },
  footer: {
    js: `  },\n});`,
  },
  rollupOptions: {
    output: {
      entryFileNames: 'client.js',
      name: 'DSHFairyVisual',
    },
  },
});
