import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __COPA_BUILD__: JSON.stringify({ version: '0.0.0-test', commit: 'test', built: '1970-01-01T00:00:00Z' }),
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
