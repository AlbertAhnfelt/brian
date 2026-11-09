import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { signedInUser } from './helpers';

const account = exports.Account;

async function person(name: string) {
	const id = crypto.randomUUID().slice(0, 6);
	return (await signedInUser(`${name}-${id}@Example.com`, `${name}-${id}`)).user;
}

describe('friends', () => {
	it('are found by an exact username or email only, showing the username and never the email', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		expect(await account.findPerson(ann.id, bo.username!)).toEqual({ username: bo.username, you: false, friend: false });
		expect(await account.findPerson(ann.id, bo.username!.toUpperCase())).toMatchObject({ username: bo.username });
		expect(await account.findPerson(ann.id, ` ${bo.email.toUpperCase()} `)).toMatchObject({ username: bo.username });
		expect(await account.findPerson(ann.id, bo.username!.slice(0, -1))).toBeNull();
		expect(await account.findPerson(ann.id, bo.email.slice(1))).toBeNull();
		expect(await account.findPerson(ann.id, 'jaskda')).toBeNull();
		expect(await account.findPerson(ann.id, ann.username!)).toMatchObject({ you: true });
		expect(JSON.stringify(await account.findPerson(ann.id, bo.email))).not.toContain('@');
	});

	it("can't be found before they pick a username", async () => {
		const ann = await person('ann');
		const { user } = await signedInUser(`nobody-${crypto.randomUUID().slice(0, 6)}@example.com`, null);
		expect(await account.findPerson(ann.id, user.email)).toBeNull();
	});

	it('are added one way, listed, and removed', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		expect(await account.addFriend(ann.id, bo.username!)).toEqual({ ok: true, value: undefined });
		expect(await account.addFriend(ann.id, bo.username!)).toMatchObject({ ok: true }); // Twice is fine.
		expect(await account.friends(ann.id)).toEqual([bo.username]);
		expect(await account.friends(bo.id)).toEqual([]);
		expect(await account.findPerson(ann.id, bo.username!)).toMatchObject({ friend: true });
		expect(await account.addFriend(ann.id, ann.username!)).toMatchObject({ ok: false });
		expect(await account.addFriend(ann.id, 'no-such-person')).toMatchObject({ ok: false });
		await account.removeFriend(ann.id, bo.username!);
		expect(await account.friends(ann.id)).toEqual([]);
	});
});
