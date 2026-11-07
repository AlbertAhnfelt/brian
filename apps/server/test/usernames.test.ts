import { getSessionUser, normalizeName, setUsername, signIn, usernameProblem } from '@brian/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { authorizeUrl, registerClient, signedInUser } from './helpers';

const newUser = (id: string) => signIn(env.DB, { provider: 'google', providerUserId: id, email: `${id}@example.com`, name: null });

describe('username rules', () => {
	it('accepts lowercase letters, digits and single inner hyphens', () => {
		for (const name of ['abc', 'albert', 'a-b-c', 'x99', 'a'.repeat(32)]) expect(usernameProblem(name)).toBeNull();
	});

	it('refuses everything else', () => {
		for (const name of ['ab', 'a'.repeat(33), '-abc', 'abc-', 'a--b', 'Abc', 'a_b', 'a.b', 'åsa', 'a b', '']) {
			expect(usernameProblem(name)).not.toBeNull();
		}
	});

	it('refuses reserved names', () => {
		expect(usernameProblem('admin')).toMatch(/reserved/);
		expect(usernameProblem('brian')).toMatch(/reserved/);
	});

	it('normalizes case and whitespace', () => {
		expect(normalizeName('  Albert ')).toBe('albert');
	});
});

describe('setUsername', () => {
	it('sets a username once, and the session user carries it', async () => {
		const user = await newUser('set-once');
		expect(await setUsername(env.DB, user.id, 'Ann')).toEqual({ ok: true, username: 'ann' });
		expect(await setUsername(env.DB, user.id, 'other')).toMatchObject({ ok: false, message: expect.stringMatching(/already set/) });
		expect((await signIn(env.DB, { provider: 'google', providerUserId: 'set-once', email: 'x', name: null })).username).toBe('ann');
	});

	it('refuses a taken username, in any case', async () => {
		const a = await newUser('taken-a');
		const b = await newUser('taken-b');
		await setUsername(env.DB, a.id, 'same');
		expect(await setUsername(env.DB, b.id, 'SAME')).toMatchObject({ ok: false, message: expect.stringMatching(/taken/) });
	});

	it('refuses invalid names without touching the user', async () => {
		const user = await newUser('invalid');
		expect((await setUsername(env.DB, user.id, 'no way')).ok).toBe(false);
		const { jar, user: fresh } = await signedInUser('fresh@example.com', null);
		expect(fresh.username).toBeNull();
		const token = jar.header().split('=')[1];
		expect((await getSessionUser(env.DB, token))?.username).toBeNull();
	});
});

describe('/authorize without a username', () => {
	it('sends the user to pick one, then back', async () => {
		const { jar } = await signedInUser('nousername@example.com', null);
		const path = await authorizeUrl(await registerClient(), 'v'.repeat(50));
		const response = await jar.fetch(path);
		expect(response.status).toBe(302);
		const welcome = new URL(response.headers.get('Location')!);
		expect(welcome.pathname).toBe('/welcome');
		expect(welcome.searchParams.get('next')).toBe(path);
	});
});
