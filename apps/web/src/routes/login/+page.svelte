<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Log in · Brian</title>
</svelte:head>

<div class="card">
	<h1>Log in</h1>
	<p>Sign in to set up your Brian.</p>

	{#each data.providers as provider (provider.id)}
		<a
			href="/login/{provider.id}?next={encodeURIComponent(data.next)}"
			class="button"
			data-sveltekit-reload
		>
			Continue with {provider.label}
		</a>
	{:else}
		<p>No login methods are configured.</p>
	{/each}
</div>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		max-width: 22rem;
		margin: 4rem auto 0;
		padding: 2rem;
		border: 1px solid var(--line);
		border-radius: 1rem;
		background: var(--surface);
	}

	p {
		margin: 0 0 0.75rem;
		color: var(--muted);
	}
</style>
