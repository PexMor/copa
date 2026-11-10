import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// ES module build: preact stays external (peer dependency of the host app).
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'copa-widget.es.js',
    },
    rollupOptions: {
      external: ['preact', 'preact/hooks', 'preact/jsx-runtime', 'preact/compat'],
    },
  },
});
