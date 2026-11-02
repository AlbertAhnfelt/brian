import type { Profile, Provider } from '@brian/shared';

export interface Callback {
	code: string;
	verifier: string;
	/** Apple posts the user's name on first sign-in only, as JSON in a form field. */
	form?: FormData;
}

export interface LoginProvider {
	id: Provider;
	label: string;
	/** The only external origin a login redirect may go to. */
	origin: string;
	/** Apple posts its callback cross-site; the others redirect with a GET. */
	callback: 'GET' | 'POST';
	enabled(env: Env): boolean;
	authUrl(env: Env, redirectUri: string, check: { state: string; verifier: string }): Promise<string>;
	profile(env: Env, redirectUri: string, callback: Callback): Promise<Profile>;
}
