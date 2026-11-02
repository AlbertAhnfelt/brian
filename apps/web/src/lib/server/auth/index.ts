import { apple } from './apple.ts';
import { github } from './github.ts';
import { google } from './google.ts';
import type { LoginProvider } from './types.ts';

export type { LoginProvider } from './types.ts';

const providers: LoginProvider[] = [google, github, apple];

/** Providers with credentials in this environment. Locally that's usually Google and GitHub. */
export const enabledProviders = (env: Env) => providers.filter((p) => p.enabled(env));

export const findProvider = (env: Env, id: string) => enabledProviders(env).find((p) => p.id === id);

/** Short-lived cookie holding the login's state, PKCE verifier and where to go afterwards. */
export const LOGIN_COOKIE = 'brian_login';
