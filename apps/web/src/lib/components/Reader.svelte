<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ReaderHit, ReaderListing } from '@brian/shared';
	import { page as route } from '$app/state';
	import { displayName, readerHref, snippetParts } from '#lib/reader.ts';
	import Tree from './Tree.svelte';

	interface Props {
		base: string;
		/** What the root is called: the username, or the brian's name. */
		rootName: string;
		tree: Record<string, ReaderListing>;
		folder: string;
		page: {
			path: string;
			updatedAt: number;
			html: string;
			properties: [string, string][];
			titled: boolean;
		} | null;
		q: string;
		hits: ReaderHit[] | null;
		/** Shown above the page: joining a public brian, say. */
		banner?: Snippet;
	}

	let { base, rootName, tree, folder, page, q, hits, banner }: Props = $props();

	/** On a phone the tree folds away; it opens with this. */
	let showTree = $state(false);

	const current = $derived(page?.path ?? folder);
	const crumbs = $derived.by(() => {
		const parts = current.split('/').filter(Boolean);
		return parts.map((part, i) => ({
			name: i === parts.length - 1 ? displayName(part) : part,
			href: readerHref(base, parts.slice(0, i + 1).join('/'))
		}));
	});
	const here = $derived(tree[folder] ?? { folders: [], files: [] });
	const updated = $derived(
		page && new Date(page.updatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
	);

	// A new page closes the tree on a phone.
	$effect(() => {
		void current;
		showTree = false;
	});
</script>

<div class="reader">
	<aside>
		<div class="top">
			<a class="root" href={base}>{rootName}</a>
			<button class="toggle button ghost" aria-expanded={showTree} onclick={() => (showTree = !showTree)}>
				{showTree ? 'Hide folders' : 'Folders'}
			</button>
		</div>
		<form method="get" action={route.url.pathname} role="search">
			<input type="search" name="q" value={q} placeholder="Search" aria-label="Search pages" maxlength="200" />
		</form>
		<nav class="tree" class:open={showTree} aria-label="Folders and pages">
			<Tree {tree} prefix="" {base} {current} />
		</nav>
	</aside>

	<section>
		{@render banner?.()}

		<nav class="crumbs" aria-label="Where you are">
			<a href={base}>{rootName}</a>
			{#each crumbs as crumb, i (crumb.href)}
				<span aria-hidden="true">/</span>
				{#if i === crumbs.length - 1 && !hits}<span aria-current="page">{crumb.name}</span>{:else}<a href={crumb.href}>{crumb.name}</a>{/if}
			{/each}
		</nav>

		{#if hits}
			<div class="results">
				<div class="results-head">
					<h1>“{q}”</h1>
					<a href={route.url.pathname}>close</a>
				</div>
				{#if hits.length}
					<ol>
						{#each hits as hit (hit.path)}
							<li>
								<a href={readerHref(base, hit.path)}>{displayName(hit.path)}</a>
								<span class="where">{hit.path}</span>
								<p>
									{#each snippetParts(hit.snippet) as part, i (i)}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
								</p>
							</li>
						{/each}
					</ol>
				{:else}
					<p class="muted">No pages match.</p>
				{/if}
			</div>
		{:else if page}
			<article>
				{#if !page.titled}<h1 class="title">{displayName(page.path)}</h1>{/if}
				{#if page.properties.length}
					<dl class="properties">
						{#each page.properties as [key, value], i (i)}
							<dt>{key}</dt>
							<dd>{value || '—'}</dd>
						{/each}
					</dl>
				{/if}
				<!-- Rendered on the server from markdown with raw HTML turned off: see lib/server/markdown.ts. -->
				<div class="prose">{@html page.html}</div>
				<p class="updated">Updated {updated}</p>
			</article>
		{:else}
			<h1 class="title">{folder ? displayName(folder) : rootName}</h1>
			{#if here.folders.length || here.files.length}
				<ul class="index">
					{#each here.folders as sub (sub)}
						<li><a href={readerHref(base, sub)}><span class="kind" aria-hidden="true">▸</span>{displayName(sub)}</a></li>
					{/each}
					{#each here.files as file (file)}
						<li><a href={readerHref(base, file)}><span class="kind" aria-hidden="true">·</span>{displayName(file)}</a></li>
					{/each}
				</ul>
			{:else}
				<p class="muted">Nothing here yet.</p>
			{/if}
		{/if}
	</section>
</div>

<style>
	.reader {
		display: grid;
		grid-template-columns: 15rem minmax(0, 1fr);
		gap: 3rem;
		padding-top: 2rem;
	}

	aside {
		position: sticky;
		top: 1rem;
		align-self: start;
		max-height: calc(100vh - 2rem);
		overflow-y: auto;
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.75rem;
	}

	.root {
		font-size: 1.1rem;
		font-weight: 600;
		text-decoration: none;
		overflow-wrap: anywhere;
	}

	.toggle {
		display: none;
		padding: 0.3rem 0.8rem;
		font-size: 0.85rem;
	}

	input[type='search'] {
		width: 100%;
		margin-bottom: 1rem;
		padding: 0.45rem 0.9rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--surface);
		font: inherit;
		font-size: 0.92rem;
	}

	.crumbs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 1.5rem;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.crumbs a {
		color: var(--muted);
		text-decoration: none;
	}

	.crumbs a:hover,
	.crumbs [aria-current] {
		color: var(--ink);
	}

	.title,
	.results h1 {
		margin-bottom: 1.25rem;
		overflow-wrap: anywhere;
	}

	article,
	.results {
		max-width: 40rem;
	}

	.properties {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.3rem 1.25rem;
		margin: 0 0 1.75rem;
		padding: 0.85rem 1rem;
		border: 1px solid var(--line);
		border-radius: 0.6rem;
		background: var(--surface);
		font-size: 0.9rem;
	}

	.properties dt {
		color: var(--muted);
	}

	.properties dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.updated,
	.muted,
	.where {
		color: var(--muted);
	}

	.updated {
		margin-top: 3rem;
		font-size: 0.85rem;
	}

	.index {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.index a {
		display: flex;
		gap: 0.6rem;
		padding: 0.45rem 0;
		border-bottom: 1px solid var(--line);
		text-decoration: none;
	}

	.index a:hover {
		color: var(--muted);
	}

	.kind {
		width: 0.8rem;
		color: var(--muted);
	}

	.results-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}

	.results-head a {
		color: var(--muted);
		font-size: 0.9rem;
	}

	.results ol {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.results li {
		padding: 0.9rem 0;
		border-bottom: 1px solid var(--line);
	}

	.results li > a {
		font-size: 1.1rem;
	}

	.where {
		display: block;
		font-size: 0.8rem;
	}

	.results p {
		margin: 0.35rem 0 0;
		font-size: 0.95rem;
	}

	mark,
	.prose :global(mark) {
		background: color-mix(in srgb, var(--tag) 45%, transparent);
		color: inherit;
		border-radius: 0.15rem;
	}

	/* The page itself. */
	.prose {
		font-size: 1.05rem;
		line-height: 1.65;
		overflow-wrap: break-word;
	}

	.prose :global(:is(h1, h2, h3, h4, h5, h6)) {
		margin: 2rem 0 0.6rem;
		font-weight: 500;
		line-height: 1.25;
		scroll-margin-top: 1rem;
	}

	.prose :global(> :first-child) {
		margin-top: 0;
	}

	.prose :global(h1) {
		font-size: 2.1rem;
	}

	.prose :global(h2) {
		font-size: 1.55rem;
	}

	.prose :global(h3) {
		font-size: 1.25rem;
	}

	.prose :global(h4),
	.prose :global(h5),
	.prose :global(h6) {
		font-size: 1.05rem;
	}

	.prose :global(p),
	.prose :global(ul),
	.prose :global(ol) {
		margin: 0 0 1rem;
	}

	.prose :global(ul),
	.prose :global(ol) {
		padding-left: 1.4rem;
	}

	.prose :global(li > ul),
	.prose :global(li > ol) {
		margin-bottom: 0;
	}

	.prose :global(li.task) {
		list-style: none;
		margin-left: -1.4rem;
	}

	.prose :global(li.task input) {
		margin: 0 0.4rem 0 0;
		accent-color: var(--ink);
		vertical-align: -0.1rem;
	}

	.prose :global(a) {
		text-decoration-color: var(--line);
		text-underline-offset: 0.18em;
	}

	.prose :global(a:hover) {
		text-decoration-color: currentColor;
	}

	.prose :global(a.internal) {
		text-decoration-color: color-mix(in srgb, var(--tag) 70%, transparent);
		text-decoration-thickness: 2px;
	}

	.prose :global(a.embed) {
		display: block;
		margin: 0.5rem 0;
		padding: 0.6rem 0.9rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: var(--surface);
	}

	.prose :global(.missing) {
		color: var(--muted);
		text-decoration: underline dotted;
		cursor: help;
	}

	.prose :global(.tag) {
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		background: var(--surface);
		border: 1px solid var(--line);
		color: var(--muted);
		font-size: 0.85em;
	}

	.prose :global(blockquote) {
		margin: 0 0 1rem;
		padding: 0.1rem 0 0.1rem 1rem;
		border-left: 3px solid var(--line);
		color: var(--muted);
	}

	.prose :global(blockquote.callout) {
		padding: 0.75rem 1rem 0.1rem;
		border: 1px solid var(--line);
		border-left: 3px solid var(--tag);
		border-radius: 0.5rem;
		background: var(--surface);
		color: var(--ink);
	}

	.prose :global(:is(.callout-warning, .callout-caution, .callout-attention, .callout-danger, .callout-error, .callout-bug, .callout-failure)) {
		border-left-color: var(--collar);
	}

	.prose :global(.callout-title) {
		margin-bottom: 0.4rem;
		font-weight: 600;
	}

	.prose :global(code) {
		padding: 0.1rem 0.3rem;
		border-radius: 0.25rem;
		background: var(--surface);
		border: 1px solid var(--line);
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 0.82em;
	}

	.prose :global(pre) {
		margin: 0 0 1rem;
		padding: 0.9rem 1rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: var(--surface);
		overflow-x: auto;
		line-height: 1.45;
	}

	.prose :global(pre code) {
		padding: 0;
		border: 0;
		background: none;
	}

	.prose :global(hr) {
		margin: 2rem 0;
		border: 0;
		border-top: 1px solid var(--line);
	}

	.prose :global(img) {
		max-width: 100%;
		border-radius: 0.4rem;
	}

	.prose :global(table) {
		display: block;
		max-width: 100%;
		margin: 0 0 1rem;
		overflow-x: auto;
		border-collapse: collapse;
		font-size: 0.95rem;
	}

	.prose :global(:is(th, td)) {
		padding: 0.4rem 0.75rem;
		border: 1px solid var(--line);
		text-align: left;
	}

	.prose :global(th) {
		background: var(--surface);
		font-weight: 600;
	}

	.prose :global(.footnotes) {
		margin-top: 2.5rem;
		color: var(--muted);
		font-size: 0.9rem;
	}

	@media (max-width: 760px) {
		.reader {
			grid-template-columns: minmax(0, 1fr);
			gap: 1.25rem;
			padding-top: 1rem;
		}

		aside {
			position: static;
			max-height: none;
			overflow: visible;
		}

		.toggle {
			display: inline-flex;
		}

		.tree {
			display: none;
			padding-bottom: 0.5rem;
			border-bottom: 1px solid var(--line);
		}

		.tree.open {
			display: block;
		}
	}
</style>
