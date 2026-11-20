// These markdown-it plugins ship without types.
declare module 'markdown-it-footnote' {
	import type { MarkdownIt } from 'markdown-it';
	const plugin: (md: MarkdownIt) => void;
	export default plugin;
}

declare module 'markdown-it-mark' {
	import type { MarkdownIt } from 'markdown-it';
	const plugin: (md: MarkdownIt) => void;
	export default plugin;
}
