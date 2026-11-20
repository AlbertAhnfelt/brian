<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActivityEntry } from '@brian/shared';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** A sentence in parts, so paths and names stay text (Svelte escapes them) and paths get <code>. */
	type Part = { text: string } | { code: string } | { brian: { id: string; name: string } };

	const a = (role: string | null | undefined) => (role === 'editor' ? 'an editor' : 'a viewer');
	const pages = (e: ActivityEntry, verb: string, where = 'in'): Part[] =>
		e.count && e.count > 1
			? [{ text: `${verb} ${e.count} pages ${where} ` }, e.path ? { code: e.path } : { text: 'the top of the brian' }]
			: [{ text: `${verb} ` }, { code: e.path ?? '' }];

	function sentence(e: ActivityEntry): Part[] {
		const it: Part = e.brian ? { brian: e.brian } : { text: 'it' };
		switch (e.action) {
			case 'create':
				return pages(e, 'created');
			case 'edit':
				return pages(e, 'edited');
			case 'delete':
				return pages(e, 'deleted', 'from');
			case 'restore':
				return pages(e, 'brought back');
			case 'move':
				return e.count && e.count > 1 ? pages(e, 'moved', 'to') : [{ text: 'moved ' }, { code: e.fromPath ?? '' }, { text: ' to ' }, { code: e.path ?? '' }];
			case 'brian.create':
				return [{ text: 'created ' }, it, { text: `, ${e.role === 'public' ? 'public' : 'private'}` }];
			case 'brian.rename':
				return [{ text: `renamed ${e.from} to ` }, it];
			case 'brian.visibility':
				return [{ text: 'made ' }, it, { text: ` ${e.role}` }];
			case 'brian.invite':
				return [{ text: `invited ${e.target} to ` }, it, { text: ` as ${a(e.role)}` }];
			case 'brian.uninvite':
				return [{ text: `took back ${e.target}'s invitation to ` }, it];
			case 'brian.accept':
				return [{ text: 'joined ' }, it, { text: ` as ${a(e.role)}` }];
			case 'brian.join':
				return [{ text: 'started syncing to ' }, it, { text: ', as a viewer' }];
			case 'brian.leave':
				return [{ text: 'left ' }, it];
			case 'brian.role':
				return [{ text: `made ${e.target} ${a(e.role)} of ` }, it];
			case 'brian.remove':
				return [{ text: `removed ${e.target} from ` }, it];
			case 'brian.delete':
				return [{ text: 'deleted ' }, it];
			case 'brian.restore':
				return [{ text: 'restored ' }, it, { text: ' from the trash' }];
		}
	}

	const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
	const time = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

	const days = $derived.by(() => {
		const out: { day: string; entries: ActivityEntry[] }[] = [];
		for (const e of data.entries) {
			const d = day(e.at);
			if (out.at(-1)?.day !== d) out.push({ day: d, entries: [] });
			out.at(-1)!.entries.push(e);
		}
		return out;
	});

	const older = $derived.by(() => {
		const q = new URLSearchParams();
		for (const [k, v] of Object.entries(data.filter)) if (v && k !== 'before') q.set(k, String(v));
		if (data.before) q.set('before', String(data.before));
		return `?${q}`;
	});

	const filtered = $derived(Boolean(data.filter.brian || data.filter.person || data.filter.app));
</script>

<svelte:head>
	<title>Activity · Brian</title>
</svelte:head>

<article>
	<h1>Activity</h1>
	<p>
		Who changed what in your Brian and in the shared brians you're in: you, your friends, and the agents you all use. You can undo deletes,
		moves, new pages and changes to brians. Edits can't be undone: Brian doesn't keep a page's earlier text.
	</p>

	<form method="get" class="filters">
		<label>
			Brian
			<select name="brian">
				<option value="">All</option>
				<option value="personal" selected={data.filter.brian === 'personal'}>Your own</option>
				{#each data.brians as b (b.id)}
					<option value={b.id} selected={data.filter.brian === b.id}>{b.name}</option>
				{/each}
			</select>
		</label>
		<label>
			Person
			<input name="person" value={data.filter.person ?? ''} placeholder="username" autocapitalize="none" spellcheck="false" autocomplete="off" />
		</label>
		<label>
			App
			<input name="app" value={data.filter.app ?? ''} placeholder="Claude, Obsidian, website…" autocomplete="off" />
		</label>
		<button class="button ghost small">Filter</button>
		{#if filtered}<a href="/activity" class="small-print">Clear</a>{/if}
	</form>

	{#if !data.entries.length}
		<p class="muted">{filtered || data.filter.before ? 'Nothing here.' : 'Nothing yet. Changes show up here as you, your agents and your friends make them.'}</p>
	{/if}

	{#each days as group (group.day)}
		<h2>{group.day}</h2>
		<ul>
			{#each group.entries as e (e.key)}
				<li>
					<span class="time muted">{time(e.at)}</span>
					<span class="what">
						<strong>{e.you ? 'You' : (e.who ?? 'Someone who has since left Brian')}</strong>
						{#each sentence(e) as part, i (i)}{#if 'code' in part}<code>{part.code}</code>{:else if 'brian' in part}<a href="/b/{part.brian.id}">{part.brian.name}</a>{:else}{part.text}{/if}{/each}
						<span class="muted">· {e.app === 'website' ? 'on the website' : `with ${e.app}`}</span>
						{#if form?.key === e.key}
							<span class={form.undone ? 'notice' : 'error'}>{form.undone ?? form.message}</span>
						{/if}
					</span>
					{#if e.undoable}
						<form method="post" action="?/undo" use:enhance>
							<input type="hidden" name="key" value={e.key} />
							<button class="button ghost small">Undo</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/each}

	{#if data.before}
		<p><a href={older}>Older</a></p>
	{/if}
</article>

<style>
	article {
		max-width: 44rem;
		padding-top: 3rem;
	}

	h2 {
		margin: 2rem 0 0.5rem;
		font-size: 1.1rem;
		font-weight: 500;
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	li {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		padding: 0.45rem 0;
		border-bottom: 1px solid var(--line);
	}

	.time {
		flex: none;
		width: 3rem;
		font-variant-numeric: tabular-nums;
	}

	.what {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	code {
		font-size: 0.85em;
	}

	p,
	.muted {
		color: var(--muted);
	}

	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.75rem;
		margin-top: 1.5rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		color: var(--muted);
		font-size: 0.85rem;
	}

	input,
	select {
		width: 11rem;
		max-width: 100%;
		padding: 0.45rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: var(--surface);
		font: inherit;
		font-size: 0.95rem;
	}

	.small {
		padding: 0.3rem 0.8rem;
		font-size: 0.85rem;
	}

	.small-print {
		font-size: 0.85rem;
	}

	.error {
		display: block;
		color: var(--collar);
	}

	.notice {
		display: block;
		color: var(--ink);
	}
</style>
