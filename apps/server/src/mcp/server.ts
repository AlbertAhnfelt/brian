import { McpServer } from '@modelcontextprotocol/server';
import { getMcpAuthContext } from 'agents/mcp/server';
import type { Props } from '../props';

export function createServer(): McpServer {
	const server = new McpServer({ name: 'brian', version: '0.0.1' });
	const props = getMcpAuthContext()?.props as Props | undefined;

	server.registerTool(
		'whoami',
		{ description: 'Return the email of the person whose Brian this is.' },
		async () => ({
			content: [{ type: 'text', text: props?.email ?? 'unknown' }]
		})
	);

	return server;
}
