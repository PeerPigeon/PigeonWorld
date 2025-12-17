import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  resolve: {
    alias: {
      'pigeonmatch': path.resolve(__dirname, 'node_modules/pigeonmatch/dist/pigeonmatch.es.js'),
      'peerpigeon': path.resolve(__dirname, 'node_modules/peerpigeon/index.js')
    }
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          'peerpigeon': ['peerpigeon']
        }
      }
    }
  },
  server: {
    port: 5173,
    host: true
  },
  optimizeDeps: {
    include: ['peerpigeon', 'pigeonmatch'],
    esbuildOptions: {
      target: 'esnext'
    }
  }
});
