import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import { getSessionUser, loginAllowed, readCookie, SESSION_COOKIE, type User } from '@brian/shared';
import { SCOPE, type Props } from '../props';
import { consentPage } from './consent';
import { escape, page } from './html';

/**
 * Owns /authorize. Login happens on the website (same origin), so this only checks the
 * website session, asks for consent and completes the grant.
 */
export const authHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname !== '/authorize') return new Response('Not found', { status: 404 });

		try {
			const session = await getSessionUser(env.DB, readCookie(request.headers.get('Cookie'), SESSION_COOKIE));
			const user = session && loginAllowed(env, session.email) ? session : null;
			if (request.method === 'GET') {
				if (!user) return toWebsite(request, env, '/login');
				// The username names the user's brian, so it has to exist before any app connects.
				if (!user.username) return toWebsite(request, env, '/welcome');
				return await showConsent(request, env, user);
			}
			if (request.method === 'POST' && user?.username) return await submitConsent(request, env, user);
			if (request.method === 'POST') return html(errorPage('Your session ended. Start connecting again from your app.'), 401);
			return new Response('Method not allowed', { status: 405 });
		} catch (error) {
			if (error instanceof AuthorizationError && error.redirectTo) {
				return Response.redirect(error.redirectTo, 302);
			}
			if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
				const message =
					error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
				return html(errorPage(`${message ?? ''}. Start connecting again from your app.`), 400);
			}
			throw error;
		}
	}
};

/** Sends the user to a website page (sign-in, username), then back to this exact /authorize request. */
function toWebsite(request: Request, env: Env, page: '/login' | '/welcome'): Response {
	const { pathname, search } = new URL(request.url);
	const target = new URL(page, env.BASE_URL);
	target.searchParams.set('next', pathname + search);
	return Response.redirect(target.toString(), 302);
}

async function showConsent(request: Request, env: Env, user: User): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const authRequest = await oauth.parseAuthRequest(request);
	const details = await oauth.describeConsent(authRequest);
	const consent = await oauth.beginConsent(authRequest);
	consent.headers.set('Content-Type', 'text/html; charset=utf-8');
	return new Response(consentPage(details, consent.handle, user.email), { headers: consent.headers });
}

async function submitConsent(request: Request, env: Env, user: User): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const form = await request.formData();
	const handle = String(form.get('handle'));

	if (form.get('decision') !== 'approve') {
		const denied = await oauth.denyConsent(request, handle);
		return new Response(null, { status: 302, headers: denied.headers });
	}

	const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
	const app = await oauth.lookupClient(approved.request.clientId);
	const client = (app?.clientName ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || undefined;
	const props: Props = { userId: user.id, email: user.email, client };
	const { redirectTo } = await oauth.completeAuthorization({
		request: approved.request,
		userId: user.id,
		metadata: {},
		scope: approved.request.scope,
		props
	});
	approved.headers.set('Location', redirectTo);
	return new Response(null, { status: 302, headers: approved.headers });
}

function errorPage(message: string): string {
	return page('Something went wrong', `<h1>Something went wrong</h1><p>${escape(message)}</p>`);
}

function html(body: string, status = 200): Response {
	return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
