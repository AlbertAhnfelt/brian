import { fail, redirect } from '@sveltejs/kit';
import type { ActivityFilter } from '@brian/shared';
import { account } from '#lib/server/account.ts';
import type { Actions, PageServerLoad } from './$types';

const login = (url: URL) => `/login?next=${encodeURIComponent(url.pathname + url.search)}`;

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(303, login(url));
	const q = url.searchParams;
	const before = Number(q.get('before'));
	const filter: ActivityFilter = {
		brian: q.get('brian') || undefined,
		person: q.get('person')?.trim() || undefined,
		app: q.get('app')?.trim() || undefined,
		before: Number.isFinite(before) && before > 0 ? before : undefined
	};
	const [page, brians] = await Promise.all([account().activity(locals.user.id, filter), account().brians(locals.user.id)]);
	return { ...page, brians, filter };
};

export const actions: Actions = {
	undo: async ({ locals, request, url }) => {
		if (!locals.user) redirect(303, login(url));
		const key = String((await request.formData()).get('key') ?? '');
		const result = await account().undo(locals.user.id, key);
		if (!result.ok) return fail(400, { key, message: result.message });
		return { key, undone: result.value };
	}
};
