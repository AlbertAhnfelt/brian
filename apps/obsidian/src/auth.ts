import { requestUrl } from 'obsidian';

/** Where Brian sends the browser back after sign-in: Obsidian's own URL scheme. */
export const REDIRECT_URI = 'obsidian://brian-auth';

export interface Tokens {
	access: string;
	refresh: string | null;
	/** When the access token expires, in ms since the epoch. */
	expiresAt: number;
}

/** A sign-in started in the browser, waiting for Brian to send the browser back. */
export interface PendingSignIn {
	clientId: string;
	verifier: string;
	state: string;
}

const random = (bytes: number) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challenge(verifier: string): Promise<string> {
	return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** Registers this plugin with Brian's OAuth server (once per server), as a public client. */
export async function register(server: string): Promise<string> {
	const response = await requestUrl({
		url: `${server}/oauth/register`,
		method: 'POST',
		contentType: 'application/json',
		body: JSON.stringify({ client_name: 'Obsidian', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }),
		throw: false
	});
	if (response.status >= 300) throw new Error(`Brian refused to register the plugin (${response.status}).`);
	return response.json.client_id as string;
}

/** The URL that starts sign-in in the browser, and what to remember until Brian sends it back. */
export async function startSignIn(server: string, clientId: string): Promise<{ url: string; pending: PendingSignIn }> {
	const pending = { clientId, verifier: random(48), state: random(24) };
	const url = new URL('/authorize', server);
	url.search = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		scope: 'brian',
		state: pending.state,
		code_challenge: await challenge(pending.verifier),
		code_challenge_method: 'S256',
		resource: `${server}/mcp`
	}).toString();
	return { url: url.toString(), pending };
}

/** Finishes sign-in with what Brian sent back to obsidian://brian-auth. */
export async function finishSignIn(server: string, pending: PendingSignIn, params: Record<string, string>): Promise<Tokens> {
	if (params.state !== pending.state) throw new Error('This sign-in link is out of date. Start signing in again.');
	if (params.error) throw new Error(params.error === 'access_denied' ? 'Sign-in was cancelled.' : `Sign-in failed: ${params.error}`);
	if (!params.code) throw new Error('Brian sent no sign-in code.');
	return token(server, {
		grant_type: 'authorization_code',
		code: params.code,
		client_id: pending.clientId,
		redirect_uri: REDIRECT_URI,
		code_verifier: pending.verifier,
		resource: `${server}/mcp`
	});
}

/** A fresh access token from the refresh token. */
export async function refresh(server: string, clientId: string, tokens: Tokens): Promise<Tokens> {
	if (!tokens.refresh) throw new Error('Signed out: sign in to Brian again.');
	const fresh = await token(server, { grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: clientId, resource: `${server}/mcp` });
	// Keep the old refresh token if the server didn't rotate it.
	return { ...fresh, refresh: fresh.refresh ?? tokens.refresh };
}

async function token(server: string, form: Record<string, string>): Promise<Tokens> {
	const response = await requestUrl({
		url: `${server}/oauth/token`,
		method: 'POST',
		contentType: 'application/x-www-form-urlencoded',
		body: new URLSearchParams(form).toString(),
		throw: false
	});
	if (response.status >= 300) throw new Error(`Signed out: sign in to Brian again (${response.status}).`);
	const json = response.json as { access_token: string; refresh_token?: string; expires_in?: number };
	return {
		access: json.access_token,
		refresh: json.refresh_token ?? null,
		expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000
	};
}
