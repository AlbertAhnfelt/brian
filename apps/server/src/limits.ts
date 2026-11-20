/**
 * Rate limits (Cloudflare's Rate Limiting bindings, configured in wrangler.jsonc, counted per
 * Cloudflare location). They keep a script or a runaway agent from hammering sign-in or MCP.
 */

/** A 429 the caller can act on. */
export function tooMany(what: string): Response {
	return new Response(`Too many ${what}. Wait a minute and try again.`, {
		status: 429,
		headers: { 'Retry-After': '60', 'Content-Type': 'text/plain; charset=utf-8' }
	});
}

/** The caller's IP address, as Cloudflare saw it. */
export function clientIp(request: Request): string {
	return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** Sign-in and app registration, per IP address. Null when the request may go ahead. */
export async function limitAuth(request: Request, env: Env): Promise<Response | null> {
	const path = new URL(request.url).pathname;
	const ip = clientIp(request);
	if (path === '/oauth/register' && request.method === 'POST') {
		if (!(await env.REGISTER_LIMITER.limit({ key: ip })).success) return tooMany('app registrations');
	}
	if (path === '/authorize' || path.startsWith('/oauth/')) {
		if (!(await env.AUTH_LIMITER.limit({ key: ip })).success) return tooMany('sign-in requests');
	}
	return null;
}
