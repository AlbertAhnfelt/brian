<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Brians · Brian</title>
</svelte:head>

<article>
	<h1>Brians</h1>
	<p>
		Your own notes are your brian, <strong>{data.user?.username}</strong>, and only you can see them. Shared
		brians are folders in <code>brian/</code> that other people are members of too.
	</p>

	<h2>Shared with you</h2>
	{#if data.brians.length}
		<ul>
			{#each data.brians as brian (brian.id)}
				<li class="row">
					<a href="/b/{brian.id}">{brian.name}</a>
					<span class="muted">brian/{brian.mount}/ · {brian.role} · {brian.visibility}</span>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted">None yet. Create one, or ask someone to add you to theirs.</p>
	{/if}

	<h2>New brian</h2>
	<form method="post" action="?/create" use:enhance class="create">
		<label>
			Name
			<input name="name" value={form?.name ?? ''} autocapitalize="none" spellcheck="false" required />
		</label>
		<fieldset>
			<label class="choice"><input type="radio" name="visibility" value="private" checked /> Private: invite only, even to see it</label>
			<label class="choice"><input type="radio" name="visibility" value="public" /> Public: anyone with the link can sync to it, as a viewer</label>
		</fieldset>
		<button class="button">Create</button>
	</form>
	<p class="muted small-print">{data.rules}</p>
	{#if form?.message}<p class="error">{form.message}</p>{/if}
</article>

<style>
	article {
		max-width: 36rem;
		padding-top: 3rem;
	}

	h2 {
		margin: 2.25rem 0 0.75rem;
		font-size: 1.3rem;
		font-weight: 500;
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.4rem 0;
	}

	p,
	.muted {
		color: var(--muted);
	}

	.create {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.75rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		color: var(--muted);
	}

	fieldset {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.choice {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
	}

	input:not([type='radio']) {
		width: 20rem;
		max-width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: var(--surface);
		font: inherit;
	}

	.small-print {
		font-size: 0.85rem;
	}

	.error {
		color: var(--collar);
	}
</style>
