import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';

const fixLibsodium = {
  name: 'fix-libsodium-sumo',
  resolveId(id: string, importer: string | undefined) {
    if (id === './libsodium-sumo.mjs' && importer?.includes('libsodium-wrappers-sumo')) {
      return path.resolve(
        __dirname,
        'node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js',
      );
    }
  },
};

export default defineConfig({
  plugins: [fixLibsodium, wasm(), topLevelAwait(), react()],
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
    sourcemap: true,
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
