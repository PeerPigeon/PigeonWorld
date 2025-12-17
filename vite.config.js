import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          'peerpigeon': ['peerpigeon'],
          'pigeonmatch': ['pigeonmatch']
        }
      }
    }
  },
  server: {
    port: 5173,
    host: true
  },
  optimizeDeps: {
    include: ['peerpigeon', 'pigeonmatch']
  }
});
