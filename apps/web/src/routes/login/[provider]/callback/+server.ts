import { error, redirect } from '@sveltejs/kit';
import { createSession, SESSION_COOKIE, SESSION_DAYS, signIn } from '@brian/shared';
import { env } from 'cloudflare:workers';
import { findProvider, LOGIN_COOKIE } from '#lib/server/auth/index.ts';
import type { RequestEvent, RequestHandler } from './$types';

interface Pending {
	state: string;
	verifier: string;
	next: string;
}

async function finish({ params, url, cookies, request }: RequestEvent): Promise<never> {
	const provider = findProvider(env, params.provider);
	if (!provider) error(404, 'Unknown login method');

	let pending: Pending | null = null;
	try {
		pending = JSON.parse(cookies.get(LOGIN_COOKIE) ?? 'null');
	} catch {}
	cookies.delete(LOGIN_COOKIE, { path: '/', secure: true });

	const form = request.method === 'POST' ? await request.formData() : undefined;
	const param = (name: string) => (form ? form.get(name)?.toString() : url.searchParams.get(name)) ?? null;

	if (param('error')) redirect(303, '/login');
	const code = param('code');
	if (!code || !pending || param('state') !== pending.state) {
		error(400, 'Sign-in expired or was started in another browser. Please try again.');
	}

	const redirectUri = `${url.origin}/login/${provider.id}/callback`;
	const profile = await provider.profile(env, redirectUri, { code, verifier: pending.verifier, form });
	const user = await signIn(env.DB, profile);

	cookies.set(SESSION_COOKIE, await createSession(env.DB, user.id), {
		path: '/',
		secure: true,
		httpOnly: true,
		sameSite: 'lax',
		maxAge: SESSION_DAYS * 24 * 60 * 60
	});
	// `next` was checked with safeNext() when the login started, and lives in an HttpOnly cookie.
	redirect(303, pending.next);
}

export const GET: RequestHandler = (event) => finish(event);
export const POST: RequestHandler = (event) => finish(event);
