<script lang="ts">
	import Reader from '#lib/components/Reader.svelte';
	import { displayName } from '#lib/reader.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const rootName = $derived(data.shelf.kind === 'mine' ? data.shelf.username : data.shelf.name);
	const title = $derived(data.page ? displayName(data.page.path) : data.folder ? displayName(data.folder) : 'Notes');
</script>

<svelte:head>
	<title>{title} · Brian</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<Reader {...data} {rootName} />
