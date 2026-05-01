import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';

const fixLibsodium = {
  name: 'fix-libsodium-sumo',
  // libsodium-wrappers-sumo's ESM build imports `./libsodium-sumo.mjs` via a
  // relative path, but the file actually lives in a SEPARATE package
  // (libsodium-sumo). Without this resolver, Vite either fails to bundle or
  // ships a broken module that throws `_sodium_init is not a function` at
  // runtime, which breaks wallet signing.
  resolveId(id: string, importer: string | undefined) {
    if (id === './libsodium-sumo.mjs' && importer?.includes('libsodium-wrappers-sumo')) {
      return path.resolve(
        __dirname,
        'node_modules/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs',
      );
    }
  },
};

export default defineConfig({
  plugins: [
    fixLibsodium,
    // MeshSDK + libsodium-wrappers-sumo expect Node globals (process, Buffer,
    // stream, etc.) at runtime. Without this plugin the bundle throws
    // `ReferenceError: process is not defined` and the SPA never mounts.
    nodePolyfills({
      globals: { process: true, Buffer: true, global: true },
      protocolImports: true,
    }),
    wasm(),
    topLevelAwait(),
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  optimizeDeps: {
    exclude: ['@meshsdk/core', '@meshsdk/react'],
  },
  build: {
    outDir: 'dist',
    // Sourcemaps disabled in prod — the polyfilled MeshSDK bundle exceeds
    // Node's default heap when generating maps. Enable locally with
    // `vite build --sourcemap` if you need them for debugging.
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          mesh: ['@meshsdk/react', '@meshsdk/core'],
        },
      },
    },
  },
});
