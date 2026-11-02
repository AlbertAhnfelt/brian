import { defineConfig } from 'vitest/config';

// Unit tests for server-side modules that don't need SvelteKit or Workers bindings.
export default defineConfig({
	test: { include: ['src/**/*.test.ts'], environment: 'node' }
});
