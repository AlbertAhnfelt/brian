import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			// Handed to test/setup.ts, which applies them to each test's fresh D1 database.
			miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') } }
		})
	],
	test: { setupFiles: ['./test/setup.ts'] }
}));
