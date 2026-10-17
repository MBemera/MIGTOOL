import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  root: 'packages/app',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
  build: { outDir: '../../dist', emptyOutDir: true },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', fileParallelism: false },
} as any);
