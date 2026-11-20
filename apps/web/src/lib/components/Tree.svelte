<script lang="ts">
	import type { ReaderListing } from '@brian/shared';
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
</script>

<ul>
	{#each folders as folder (folder)}
		{@const open = folder in tree}
		<li>
			<a href={readerHref(base, folder)} class="folder" class:open aria-current={current === folder ? 'page' : undefined}>
				<span class="caret" aria-hidden="true"></span>{displayName(folder)}
			</a>
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

	a {
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

	a:hover {
		background: var(--surface);
		color: var(--ink);
	}

	a[aria-current='page'] {
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
