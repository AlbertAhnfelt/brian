import { READER_MARK_END, READER_MARK_START, type BrianSummary, type Outcome, wikilinkTargets } from '@brian/shared';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { signedInUser } from './helpers';

const account = exports.Account;

let seq = 0;

async function person(name: string) {
	const username = `${name}${++seq}`;
	const { user } = await signedInUser(`${username}@example.com`, username);
	await account.setUp(user.id);
	return { id: user.id, name: username };
}

function value<T>(outcome: Outcome<T>): T {
	if (!outcome.ok) throw new Error(outcome.message);
	return outcome.value;
}

async function brianOf(owner: { id: string }, visibility: 'private' | 'public') {
	return value(await account.createBrian(owner.id, `acme${++seq}`, visibility)) as BrianSummary;
}

const vault = (name: string) => env.VAULT.getByName(name);

describe('reading a shared brian', () => {
	it('lets members read a private brian and nobody else, signed in or not', async () => {
		const ann = await person('ann');
		const bob = await person('bob');
		const brian = await brianOf(ann, 'private');
		await vault(brian.id).write('plan.md', 'the secret plan');

		expect((await account.readView(ann.id, brian.id, 'plan.md'))?.page?.content).toBe('the secret plan');
		for (const reader of [bob.id, null]) {
			expect(await account.readView(reader, brian.id, '')).toBeNull();
			expect(await account.readView(reader, brian.id, 'plan.md')).toBeNull();
			expect(await account.readSearch(reader, brian.id, 'secret')).toBeNull();
		}
	});

	it('lets anyone read a public brian, without an account', async () => {
		const ann = await person('ann');
		const bob = await person('bob');
		const brian = await brianOf(ann, 'public');
		await vault(brian.id).write('notes/Idea.md', 'a public idea');

		for (const reader of [bob.id, null]) {
			const view = await account.readView(reader, brian.id, 'notes/Idea.md');
			expect(view?.shelf).toEqual({ kind: 'brian', id: brian.id, name: brian.name, visibility: 'public', role: null });
			expect(view?.page?.content).toBe('a public idea');
			expect((await account.readSearch(reader, brian.id, 'idea'))?.map((h) => h.path)).toEqual(['notes/Idea.md']);
		}
		expect((await account.readView(ann.id, brian.id, ''))?.shelf).toMatchObject({ role: 'owner' });
	});

	it('stops reading once the brian goes private or to the trash', async () => {
		const ann = await person('ann');
		const brian = await brianOf(ann, 'public');
		expect(await account.readView(null, brian.id, '')).not.toBeNull();
		value(await account.setVisibility(ann.id, brian.id, 'private'));
		expect(await account.readView(null, brian.id, '')).toBeNull();
		value(await account.setVisibility(ann.id, brian.id, 'public'));
		value(await account.deleteBrian(ann.id, brian.id));
		expect(await account.readView(null, brian.id, '')).toBeNull();
		expect(await account.readView(ann.id, brian.id, '')).toBeNull();
	});

	it("never reads a vault that isn't a brian, like someone's personal one", async () => {
		const ann = await person('ann');
		await vault(ann.id).write('diary.md', 'dear diary');
		expect(await account.readView(null, ann.id, 'diary.md')).toBeNull();
		expect(await account.readSearch(null, ann.id, 'diary')).toBeNull();
	});
});

describe('reading your own Brian', () => {
	it('needs a signed-in user, and shows only their own pages', async () => {
		const ann = await person('ann');
		const bob = await person('bob');
		await vault(ann.id).write('diary.md', 'dear diary');
		expect(await account.readView(null, null, 'diary.md')).toBeNull();
		expect((await account.readView(ann.id, null, 'diary.md'))?.page?.content).toBe('dear diary');
		expect(await account.readView(bob.id, null, 'diary.md')).toBeNull();
		expect(await account.readSearch(bob.id, null, 'diary')).toEqual([]);
	});

	it('shows shared brians under brian/<mount>/', async () => {
		const ann = await person('ann');
		const brian = await brianOf(ann, 'private');
		await vault(brian.id).write('plan.md', 'the plan');
		const view = await account.readView(ann.id, null, `brian/${brian.mount}/plan.md`);
		expect(view?.page?.path).toBe(`brian/${brian.mount}/plan.md`);
		expect(view?.tree['brian/'].folders).toContain(`brian/${brian.mount}/`);
	});

	it('lists every folder down to the open one, in their own casing', async () => {
		const ann = await person('ann');
		await vault(ann.id).write('Notes/Deep/page.md', 'x');
		const view = await account.readView(ann.id, null, 'notes/deep');
		expect(Object.keys(view!.tree)).toEqual(['', 'Notes/', 'Notes/Deep/']);
		expect(view!.folder).toBe('Notes/Deep/');
		expect(view!.tree['Notes/Deep/'].files).toEqual(['Notes/Deep/page.md']);
		expect(view!.page).toBeNull();
	});

	it("is null for a page or folder that isn't there, and for paths that can't exist", async () => {
		const ann = await person('ann');
		for (const path of ['missing.md', 'nowhere', '../x.md', 'a//b.md']) {
			expect(await account.readView(ann.id, null, path)).toBeNull();
		}
	});
});

describe('searching', () => {
	it('marks matches with characters no page uses, and drops markdown syntax from snippets', async () => {
		const ann = await person('ann');
		await vault(ann.id).write('garden.md', 'Tomatoes need **sun**, see [[Watering]].');
		const [hit] = (await account.readSearch(ann.id, null, 'tomatoes'))!;
		expect(hit.snippet).toBe(`${READER_MARK_START}Tomatoes${READER_MARK_END} need sun, see Watering.`);
	});
});

describe('wikilinks', () => {
	it('finds targets without aliases, headings and blocks', () => {
		expect(wikilinkTargets('see [[Idea]], [[notes/Plan#Why|why]], ![[Pic.png]], [[#Here]], [[Idea^b1]]')).toEqual(['Idea', 'notes/Plan', 'Pic.png']);
	});

	it('resolve like Obsidian: exact path, else the shortest path with that name, any casing', async () => {
		const ann = await person('ann');
		const v = vault(ann.id);
		await v.write('deep/down/Idea.md', 'x');
		await v.write('top/Idea.md', 'x');
		await v.write('notes/Plan.md', 'x');
		await v.write('home.md', 'See [[idea]], [[notes/plan|the plan]], [[Plan.md]], [[Gone]] and ![[Pic.png]].');
		const view = await account.readView(ann.id, null, 'home.md');
		expect(view?.page?.links).toEqual({
			idea: 'top/Idea.md',
			'notes/plan': 'notes/Plan.md',
			'Plan.md': 'notes/Plan.md',
			Gone: null,
			'Pic.png': null
		});
	});

	it('resolve within the shared brian the page is in', async () => {
		const ann = await person('ann');
		const brian = await brianOf(ann, 'public');
		await vault(ann.id).write('Plan.md', 'personal');
		await vault(brian.id).write('Plan.md', 'shared');
		await vault(brian.id).write('home.md', '[[Plan]]');
		expect((await account.readView(ann.id, null, `brian/${brian.mount}/home.md`))?.page?.links).toEqual({ Plan: `brian/${brian.mount}/Plan.md` });
		expect((await account.readView(null, brian.id, 'home.md'))?.page?.links).toEqual({ Plan: 'Plan.md' });
	});
});
