<script lang="ts">
	import '@fontsource-variable/eb-garamond';
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Brian</title>
</svelte:head>

<header>
	<a href="/" class="wordmark"><span class="tag" aria-hidden="true"></span>brian</a>
	<nav>
		<a href="/about" aria-current={page.url.pathname === '/about' ? 'page' : undefined}>about</a>
		{#if data.user}
			<form method="post" action="/logout">
				<button class="button ghost">log out</button>
			</form>
		{:else}
			<a href="/login" class="button ghost">log in</a>
		{/if}
	</nav>
</header>

<main>
	{@render children()}
</main>

<footer>
	<a href="/privacy">privacy</a>
	<a href="/terms">terms</a>
</footer>

<style>
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		max-width: 960px;
		margin: 0 auto;
		padding: 1.25rem 1.5rem;
	}

	.wordmark {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 1.3rem;
		font-weight: 600;
		text-decoration: none;
	}

	.tag {
		width: 0.7rem;
		height: 0.7rem;
		border: 1.5px solid var(--ink);
		border-radius: 50%;
		background: var(--tag);
	}

	nav {
		display: flex;
		align-items: center;
		gap: 1.25rem;
		font-size: 0.9rem;
	}

	nav a:not(.button) {
		color: var(--muted);
		text-decoration: none;
	}

	nav a:not(.button):hover,
	nav a[aria-current='page'] {
		color: var(--ink);
	}

	nav .button {
		padding: 0.4rem 0.9rem;
		font-size: 0.85rem;
	}

	main {
		max-width: 960px;
		margin: 0 auto;
		padding: 0 1.5rem 4rem;
	}

	footer {
		display: flex;
		gap: 1.25rem;
		max-width: 960px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
		font-size: 0.85rem;
	}

	footer a {
		color: var(--muted);
		text-decoration: none;
	}

	footer a:hover {
		color: var(--ink);
	}
</style>
