import { fail, redirect } from '@sveltejs/kit';
import { NAME_RULES, safeNext, setUsername } from '@brian/shared';
import { env } from 'cloudflare:workers';
import { account } from '#lib/server/account.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const next = safeNext(url.searchParams.get('next'));
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(`/welcome?next=${encodeURIComponent(next)}`)}`);
	if (locals.user.username) redirect(303, next);
	return { next, rules: NAME_RULES };
};

export const actions: Actions = {
	default: async ({ locals, request, url }) => {
		if (!locals.user) redirect(303, '/login');
		const input = String((await request.formData()).get('username') ?? '');
		const result = await setUsername(env.DB, locals.user.id, input);
		if (!result.ok) return fail(400, { username: input, message: result.message });
		// The starting brian/BRIAN.md is a nicety: a failure here mustn't block onboarding.
		await account()
			.setUp(locals.user.id)
			.catch((error) => console.error('setUp failed', error));
		redirect(303, safeNext(url.searchParams.get('next')));
	}
};
