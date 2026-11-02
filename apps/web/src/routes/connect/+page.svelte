<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const mcpUrl = $derived(data.mcpUrl);

	let copied = $state(false);

	async function copy() {
		await navigator.clipboard.writeText(mcpUrl);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

<svelte:head>
	<title>Connect · Brian</title>
</svelte:head>

<article>
	<h1>Connect your Brian</h1>
	<p>Signed in as {data.user?.email}.</p>
	<p>Add this URL as a custom connector in Claude, ChatGPT, or any MCP client.</p>

	<div class="url">
		<code>{mcpUrl}</code>
		<button class="button ghost" onclick={copy}>{copied ? 'copied' : 'copy'}</button>
	</div>
</article>

<style>
	article {
		max-width: 36rem;
		padding-top: 3rem;
	}

	p {
		color: var(--muted);
	}

	.url {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 1.5rem;
		padding: 0.5rem 0.5rem 0.5rem 1rem;
		border: 1px solid var(--line);
		border-radius: 0.75rem;
		background: var(--surface);
	}

	code {
		overflow-x: auto;
		font-family: inherit;
		font-size: 1.05rem;
		white-space: nowrap;
	}

	.url .button {
		flex-shrink: 0;
		padding: 0.35rem 0.85rem;
		font-size: 0.8rem;
	}
</style>
