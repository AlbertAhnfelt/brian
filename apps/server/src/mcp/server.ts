import { McpServer } from '@modelcontextprotocol/server';
import { getMcpAuthContext } from 'agents/mcp/server';
import { env } from 'cloudflare:workers';
import { LIMITS } from '@brian/shared';
import { z } from 'zod';
import { Brian, instructions } from '../brian/router';
import type { Props } from '../props';

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (value: string): Result => ({ content: [{ type: 'text', text: value }] });

/** Runs a vault call; any failure becomes a tool error the agent can read and act on. */
async function run(fn: () => Promise<string>): Promise<Result> {
	try {
		return text(await fn());
	} catch (error) {
		return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
	}
}

/**
 * Built for every MCP request, for the user the access token belongs to. Their memberships are
 * loaded fresh each time, so a removed member loses access with their next call.
 */
export async function createServer(): Promise<McpServer> {
	const props = getMcpAuthContext()?.props as Props | undefined;
	if (!props) return new McpServer({ name: 'brian', version: '0.0.1' });

	const vault = await Brian.load(env, props.userId);
	const server = new McpServer({ name: 'brian', version: '0.0.1' }, { instructions: instructions(vault) });

	server.registerTool(
		'whoami',
		{ description: 'Who this Brian belongs to, and the shared brians in it with your role in each.' },
		async () => {
			const lines = [`${vault.username ?? '(no username yet)'} <${props.email}>`];
			for (const b of vault.brians) lines.push(`brian/${b.mount}/ — "${b.name}", ${b.role}, ${b.visibility}`);
			return text(lines.join('\n'));
		}
	);

	server.registerTool(
		'list',
		{
			description:
				'List the Brian like `ls`: folders and files directly under a prefix. Use "" for the root, "notes/" for a folder. Shared brians are the folders in brian/.',
			inputSchema: z.object({ prefix: z.string().default('') })
		},
		({ prefix }) =>
			run(async () => {
				const { folders, files } = await vault.list(prefix);
				const lines = [...folders, ...files];
				return lines.length ? lines.join('\n') : 'Nothing here yet.';
			})
	);

	server.registerTool(
		'search',
		{
			description:
				'Full-text search over page paths and contents in every brian, best matches first. Every word must match; end a word with * for prefix matching. Returns paths with snippets: read_page the ones you need before acting on them.',
			inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(LIMITS.searchResults).default(20) })
		},
		({ query, limit }) =>
			run(async () => {
				const hits = await vault.search(query, limit);
				return hits.length ? hits.map((h) => `${h.path}\n  ${h.snippet.replace(/\s+/g, " ")}`).join('\n') : 'No matches.';
			})
	);

	server.registerTool(
		'read_page',
		{
			description: 'Read a full page by its path, e.g. notes/today.md. Returns its etag: keep it if you will overwrite the page.',
			inputSchema: z.object({ path: z.string().min(1) })
		},
		({ path }) =>
			run(async () => {
				const page = await vault.read(path);
				return `etag: ${page.etag}\n\n${page.content}`;
			})
	);

	server.registerTool(
		'write_page',
		{
			description:
				`Create a page, or fully overwrite one. Pages are markdown: paths must end in .md, are case-insensitive, and must be valid file names on any device (no \\ : * ? \" < > |, no leading dot); each brian holds up to ${LIMITS.pagesPerBrian.toLocaleString('en-US')} pages. Shared brians you view are read-only. To create: omit expected_etag (fails if the page exists). To overwrite: pass the etag from read_page (fails if the page changed since; re-read and retry). For small changes prefer edit_page.`,
			inputSchema: z.object({ path: z.string().min(1), content: z.string(), expected_etag: z.string().optional() })
		},
		({ path, content, expected_etag }) =>
			run(async () => {
				const page = await vault.write(path, content, expected_etag);
				return `Saved ${page.path} (etag: ${page.etag})`;
			})
	);

	server.registerTool(
		'edit_page',
		{
			description:
				'Edit a page by exact string replacement: cheaper and safer than rewriting it. old_string must match exactly once (or set replace_all). To append, use the last line as old_string and repeat it in new_string.',
			inputSchema: z.object({
				path: z.string().min(1),
				old_string: z.string().min(1),
				new_string: z.string(),
				replace_all: z.boolean().default(false)
			})
		},
		({ path, old_string, new_string, replace_all }) =>
			run(async () => {
				const page = await vault.edit(path, old_string, new_string, replace_all);
				return `Edited ${page.path} (etag: ${page.etag})`;
			})
	);

	server.registerTool(
		'move_page',
		{
			description: 'Move or rename a page, also between brians. The new path must end in .md. Fails if the destination already exists.',
			inputSchema: z.object({ from: z.string().min(1), to: z.string().min(1) })
		},
		({ from, to }) =>
			run(async () => {
				const page = await vault.move(from, to);
				return `Moved to ${page.path}`;
			})
	);

	server.registerTool(
		'delete_page',
		{
			description: 'Delete a page. It goes to the trash rather than being destroyed.',
			inputSchema: z.object({ path: z.string().min(1) })
		},
		({ path }) =>
			run(async () => {
				await vault.delete(path);
				return `Moved ${path} to the trash.`;
			})
	);

	return server;
}
