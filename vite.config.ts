import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // JUnit next to the coverage report: the CI pulls both out of the
    // container from the same directory.
    outputFile: { junit: 'coverage/junit.xml' },
    coverage: {
      provider: 'istanbul',
      // cobertura is what the reusable workflow parses, the same format the
      // Python services emit.
      reporter: ['text', 'cobertura'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', '**/*.d.ts'],
    },
  },
});
