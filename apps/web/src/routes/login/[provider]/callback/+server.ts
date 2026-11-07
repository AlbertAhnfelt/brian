import { error, redirect } from '@sveltejs/kit';
import { createSession, linkLogin, loginAllowed, SESSION_COOKIE, SESSION_DAYS, signIn } from '@brian/shared';
import { env } from 'cloudflare:workers';
import { findProvider, LOGIN_COOKIE } from '#lib/server/auth/index.ts';
import type { RequestEvent, RequestHandler } from './$types';

interface Pending {
	state: string;
	verifier: string;
	next: string;
	/** Set when a signed-in user started the login to add this provider to their account. */
	link?: string;
}

async function finish({ params, url, cookies, request, locals }: RequestEvent): Promise<never> {
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
	// Checked before signIn(), so a turned-away login never creates a user. The email is verified.
	if (!pending.link && !loginAllowed(env, profile.email)) error(403, 'This is a private test site.');

	if (pending.link) {
		// Trusted from the HttpOnly __Host- login cookie, which only this origin can set, and only
		// for a signed-in user. Apple's callback is a cross-site POST, so the SameSite=Lax session
		// cookie isn't sent there; when it is sent, it has to be the same user.
		if (locals.user && locals.user.id !== pending.link) error(400, 'You signed in as someone else meanwhile.');
		const exists = await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(pending.link).first();
		if (!exists) error(400, 'That account no longer exists.');
		if ((await linkLogin(env.DB, pending.link, profile)) === 'taken') {
			error(409, `That ${provider.label} login already belongs to another Brian account.`);
		}
		redirect(303, '/account');
	}

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
