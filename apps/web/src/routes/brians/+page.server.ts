import { fail, redirect } from '@sveltejs/kit';
import { NAME_RULES, type Visibility } from '@brian/shared';
import { account } from '#lib/server/account.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(303, '/login?next=/brians');
	return { brians: await account().brians(locals.user.id), rules: NAME_RULES };
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/login?next=/brians');
		const form = await request.formData();
		const name = String(form.get('name') ?? '');
		const visibility: Visibility = form.get('visibility') === 'public' ? 'public' : 'private';
		const created = await account().createBrian(locals.user.id, name, visibility);
		if (!created.ok) return fail(400, { name, message: created.message });
		redirect(303, `/b/${created.value.id}`);
	}
};
