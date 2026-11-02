import { createSession, deleteSession, getSessionUser, signIn } from '@brian/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('signIn', () => {
	it('creates a user on first login and finds them again', async () => {
		const first = await signIn(env.DB, { provider: 'google', providerUserId: 'g1', email: 'Ann@Example.com', name: 'Ann' });
		const again = await signIn(env.DB, { provider: 'google', providerUserId: 'g1', email: 'ann@example.com', name: 'Ann' });
		expect(again.id).toBe(first.id);
		expect(first.email).toBe('ann@example.com');
	});

	it('links a second provider with the same verified email', async () => {
		const google = await signIn(env.DB, { provider: 'google', providerUserId: 'g2', email: 'bo@example.com', name: null });
		const github = await signIn(env.DB, { provider: 'github', providerUserId: '99', email: 'BO@example.com', name: null });
		expect(github.id).toBe(google.id);
		const { results } = await env.DB.prepare('SELECT provider FROM accounts WHERE user_id = ? ORDER BY provider')
			.bind(google.id)
			.all<{ provider: string }>();
		expect(results.map((r) => r.provider)).toEqual(['github', 'google']);
	});

	it('keeps different emails apart', async () => {
		const a = await signIn(env.DB, { provider: 'apple', providerUserId: 'a1', email: 'x@privaterelay.appleid.com', name: null });
		const b = await signIn(env.DB, { provider: 'google', providerUserId: 'g3', email: 'x@example.com', name: null });
		expect(a.id).not.toBe(b.id);
	});
});

describe('sessions', () => {
	it('finds the user for a token, and not after deletion', async () => {
		const user = await signIn(env.DB, { provider: 'github', providerUserId: 's1', email: 's@example.com', name: null });
		const token = await createSession(env.DB, user.id);
		expect((await getSessionUser(env.DB, token))?.id).toBe(user.id);
		expect(await getSessionUser(env.DB, 'wrong')).toBeNull();
		await deleteSession(env.DB, token);
		expect(await getSessionUser(env.DB, token)).toBeNull();
	});

	it('stores only a hash of the token', async () => {
		const user = await signIn(env.DB, { provider: 'github', providerUserId: 's2', email: 't@example.com', name: null });
		const token = await createSession(env.DB, user.id);
		const row = await env.DB.prepare('SELECT id_hash FROM sessions WHERE user_id = ?').bind(user.id).first<{ id_hash: string }>();
		expect(row?.id_hash).not.toBe(token);
		expect(row?.id_hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('ignores expired sessions', async () => {
		const user = await signIn(env.DB, { provider: 'github', providerUserId: 's3', email: 'u@example.com', name: null });
		const token = await createSession(env.DB, user.id);
		await env.DB.prepare('UPDATE sessions SET expires_at = unixepoch() - 1 WHERE user_id = ?').bind(user.id).run();
		expect(await getSessionUser(env.DB, token)).toBeNull();
	});
});
