<script lang="ts">
	import type { ReaderListing } from '@brian/shared';
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { displayName, readerHref } from '#lib/reader.ts';
	import Tree from './Tree.svelte';

	interface Props {
		/** Listings by folder: the ones there are listings for are open. */
		tree: Record<string, ReaderListing>;
		prefix: string;
		base: string;
		/** The open page's or folder's path. */
		current: string;
	}

	let { tree, prefix, base, current }: Props = $props();

	const byName = (a: string, b: string) => displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base', numeric: true });
	const folders = $derived([...(tree[prefix]?.folders ?? [])].sort(byName));
	const files = $derived([...(tree[prefix]?.files ?? [])].sort(byName));

	/** Folders closed with their arrow. Opening a page inside one opens it again. */
	const closed = new SvelteSet<string>();
	// Only when the page changes: closing the folder the open page is in must stay closed.
	$effect(() => {
		const here = current;
		untrack(() => {
			for (const folder of closed) if (here !== folder && here.startsWith(folder)) closed.delete(folder);
		});
	});
	const toggle = (folder: string) => (closed.has(folder) ? closed.delete(folder) : closed.add(folder));
</script>

<ul>
	{#each folders as folder (folder)}
		{@const loaded = folder in tree}
		{@const open = loaded && !closed.has(folder)}
		<li>
			<div class="row" class:open aria-current={current === folder ? 'page' : undefined}>
				{#if loaded}
					<button class="arrow" aria-expanded={open} aria-label="{open ? 'Close' : 'Open'} {displayName(folder)}" onclick={() => toggle(folder)}>
						<span class="caret" aria-hidden="true"></span>
					</button>
				{:else}
					<a class="arrow" href={readerHref(base, folder)} tabindex="-1" aria-hidden="true"><span class="caret"></span></a>
				{/if}
				<a href={readerHref(base, folder)} class="folder">{displayName(folder)}</a>
			</div>
			{#if open}<Tree {tree} prefix={folder} {base} {current} />{/if}
		</li>
	{/each}
	{#each files as file (file)}
		<li>
			<a href={readerHref(base, file)} class="file" aria-current={current === file ? 'page' : undefined}>{displayName(file)}</a>
		</li>
	{/each}
</ul>

<style>
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	ul :global(ul) {
		margin-left: 0.55rem;
		padding-left: 0.55rem;
		border-left: 1px solid var(--line);
	}

	a,
	.row {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.18rem 0.4rem;
		border-radius: 0.35rem;
		color: var(--muted);
		font-size: 0.92rem;
		line-height: 1.35;
		text-decoration: none;
		overflow-wrap: anywhere;
	}

	a:hover,
	.row:hover {
		background: var(--surface);
		color: var(--ink);
	}

	.row {
		gap: 0;
		padding: 0;
	}

	.row .folder {
		padding: 0.18rem 0.4rem 0.18rem 0.1rem;
		flex: 1;
	}

	.row .arrow {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.15rem;
		align-self: stretch;
		padding: 0 0 0 0.3rem;
		border: 0;
		background: none;
		cursor: pointer;
	}

	a[aria-current='page'],
	.row[aria-current='page'] {
		background: var(--surface);
		color: var(--ink);
		box-shadow: inset 2px 0 0 var(--tag);
	}

	.folder {
		color: var(--ink);
	}

	.caret {
		flex: none;
		width: 0;
		height: 0;
		border-top: 0.28rem solid transparent;
		border-bottom: 0.28rem solid transparent;
		border-left: 0.38rem solid var(--muted);
		transition: transform 120ms ease;
	}

	.open .caret {
		transform: rotate(90deg);
	}

	.file {
		padding-left: 1.15rem;
	}
</style>
