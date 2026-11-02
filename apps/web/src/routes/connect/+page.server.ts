import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) redirect(303, '/login?next=/connect');
	// The MCP server lives on the same origin as the website.
	return { mcpUrl: `${url.origin}/mcp` };
};
