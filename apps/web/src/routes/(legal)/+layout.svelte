<script lang="ts">
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<article>
	{@render children()}
</article>

<style>
	article {
		max-width: 38rem;
		padding-top: 3rem;
	}

	article :global(h2) {
		margin: 2rem 0 0.5rem;
		font-size: 1.3rem;
		font-weight: 500;
	}

	article :global(p),
	article :global(li) {
		color: var(--muted);
	}

	article :global(strong) {
		color: var(--ink);
		font-weight: 600;
	}

	article :global(.updated) {
		margin-top: 0.25rem;
		font-size: 0.9rem;
	}
</style>
