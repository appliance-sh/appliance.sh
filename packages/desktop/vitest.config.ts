import { defineConfig } from 'vitest/config';

// Desktop unit tests (node env). Currently the agent-credential envelope
// parity guard — kept narrow so the heavy Tauri/vite build graph stays out of
// the test target.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
