<script lang="ts">
	import Reader from '#lib/components/Reader.svelte';
	import { page as route } from '$app/state';
	import { displayName } from '#lib/reader.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const brian = $derived(data.shelf.kind === 'brian' ? data.shelf : null);
	const name = $derived(brian?.name ?? '');
	const title = $derived(data.page ? `${displayName(data.page.path)} · ${name}` : data.folder ? `${displayName(data.folder)} · ${name}` : name);
	const description = $derived(data.page?.description || `${name}, a brian of shared notes. Read it here, or sync it to your own Brian.`);
	const canonical = $derived(route.url.origin + route.url.pathname);
</script>

<svelte:head>
	<title>{title} · Brian</title>
	<meta name="description" content={description} />
	{#if brian?.visibility === 'public' && !data.q}
		<link rel="canonical" href={canonical} />
		<meta property="og:type" content="article" />
		<meta property="og:title" content={title} />
		<meta property="og:description" content={description} />
		<meta property="og:url" content={canonical} />
	{:else}
		<meta name="robots" content="noindex" />
	{/if}
</svelte:head>

<Reader {...data} rootName={name}>
	{#snippet banner()}
		{#if brian && brian.role === null}
			<div class="banner">
				<p>A public brian. Sync to it to get it in your Brian as a read-only folder in <code>brian/</code>, kept up to date.</p>
				{#if data.signedIn}
					<form method="post" action="/b/{brian.id}?/join">
						<button class="button">Sync to this brian</button>
					</form>
				{:else}
					<a class="button" href="/login?next={encodeURIComponent(`/b/${brian.id}`)}">Log in to sync</a>
				{/if}
			</div>
		{:else if brian}
			<p class="member">
				You're {brian.role === 'owner' ? 'the owner' : `a ${brian.role}`} of this {brian.visibility} brian. <a href="/b/{brian.id}">Members and settings</a>
			</p>
		{/if}
	{/snippet}
</Reader>

<style>
	.banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem 1.5rem;
		margin-bottom: 1.75rem;
		padding: 0.9rem 1.1rem;
		border: 1px solid var(--line);
		border-left: 3px solid var(--tag);
		border-radius: 0.6rem;
		background: var(--surface);
	}

	.banner p {
		flex: 1 1 18rem;
		margin: 0;
		font-size: 0.95rem;
	}

	.member {
		margin: 0 0 1rem;
		color: var(--muted);
		font-size: 0.85rem;
	}

	.member a {
		color: var(--muted);
	}
</style>
