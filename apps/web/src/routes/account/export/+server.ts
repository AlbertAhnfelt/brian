import { error } from '@sveltejs/kit';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { account } from '#lib/server/account.ts';
import type { RequestHandler } from './$types';

/** Downloads the whole vault as a zip of its pages, folders included. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Log in to export your Brian.');
	const pages = await account().exportPages(locals.user.id);
	const files: Zippable = {};
	for (const page of pages) files[page.path] = [strToU8(page.content), { mtime: new Date(page.updatedAt) }];
	const date = new Date().toISOString().slice(0, 10);
	return new Response(zipSync(files), {
		headers: {
			'Content-Type': 'application/zip',
			'Content-Disposition': `attachment; filename="brian-${date}.zip"`,
			'Cache-Control': 'no-store'
		}
	});
};
