import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Locally, mirror production's single origin: these paths belong to apps/server (wrangler dev on :8787).
const server = 'http://localhost:8787';
const serverPaths = ['/mcp', '/authorize', '/oauth', '/sync', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource'];

export default defineConfig({
	server: {
		port: 5173,
		strictPort: true,
		proxy: Object.fromEntries(serverPaths.map((path) => [path, { target: server, changeOrigin: false, ws: path === '/sync' }]))
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Apple's login callback is a form post from appleid.apple.com.
			csrf: { trustedOrigins: ['https://appleid.apple.com'] },
			// Share local D1 state with apps/server's wrangler dev.
			adapter: adapter({ platformProxy: { persist: { path: '../../.wrangler/state/v3' } } })
		})
	]
});
