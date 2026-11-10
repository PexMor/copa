import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Self-contained bundle for <script> tags: includes preact, exposes global `Copa`.
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/iife.ts',
      name: 'Copa',
      formats: ['iife'],
      fileName: () => 'copa-widget.iife.js',
    },
  },
});
