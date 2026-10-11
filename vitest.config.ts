import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/{unit,integration,escape}/**/*.test.ts'],
    testTimeout: 60_000,
    environment: 'node',
  },
});
