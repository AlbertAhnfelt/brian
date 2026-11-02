import { redirect } from '@sveltejs/kit';
import { safeNext } from '@brian/shared';
import { env } from 'cloudflare:workers';
import { enabledProviders } from '#lib/server/auth/index.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const next = safeNext(url.searchParams.get('next'));
	if (locals.user) redirect(303, next);
	return {
		next,
		providers: enabledProviders(env).map(({ id, label }) => ({ id, label }))
	};
};
