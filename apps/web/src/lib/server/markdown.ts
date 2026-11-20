import MarkdownIt, { type StateCore, type StateInline, type Token } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import mark from 'markdown-it-mark';
import { wikilinkTarget } from '@brian/shared';
import { slugify } from '#lib/reader.ts';

/** What rendering one page needs to know. */
export interface RenderContext {
	/** The page's own path, for relative links. */
	path: string;
	/** Where its [[wikilinks]] lead (from the server): target → page path, or null. */
	links: Record<string, string | null>;
	/** The reader's URL for a page path. */
	href: (path: string) => string;
}

export interface Rendered {
	html: string;
	/** Frontmatter, as key and value text. */
	properties: [string, string][];
	/** The first paragraph as plain text, for search engines and link previews. */
	description: string;
	/** The page starts with its own # heading, so the reader shows no separate title. */
	titled: boolean;
}

const NOT_SYNCED = 'Images and attachments aren’t synced to Brian yet';

/**
 * Markdown as Obsidian shows it, made safe to put in a page: raw HTML in a page is shown as text,
 * never run (`html: false`), and markdown-it refuses javascript:, vbscript:, file: and data: links
 * (data: images aside). Everything added here escapes what it writes.
 */
const md = MarkdownIt({ html: false, linkify: true, breaks: true }).use(footnote).use(mark);
const escape = md.utils.escapeHtml;

// [[Page]], [[Page#Heading|text]], ![[embed]]
md.inline.ruler.before('link', 'wikilink', (state: StateInline, silent: boolean) => {
	const { src } = state;
	const embed = src.charCodeAt(state.pos) === 0x21; /* ! */
	const open = state.pos + (embed ? 1 : 0);
	if (!src.startsWith('[[', open)) return false;
	const end = src.indexOf(']]', open + 2);
	if (end < 0) return false;
	const inner = src.slice(open + 2, end);
	if (!inner.trim() || /[\n[\]]/.test(inner)) return false;
	if (!silent) state.push('wikilink', '', 0).meta = { inner, embed };
	state.pos = end + 2;
	return true;
});

md.renderer.rules.wikilink = (tokens, idx, _options, rendering) => {
	const env = rendering as unknown as RenderContext;
	const { inner, embed } = tokens[idx].meta as { inner: string; embed: boolean };
	const bar = inner.indexOf('|');
	const ref = bar < 0 ? inner : inner.slice(0, bar);
	const alias = bar < 0 ? '' : inner.slice(bar + 1).trim();
	const target = wikilinkTarget(inner);
	const hash = ref.indexOf('#');
	const heading = hash < 0 ? '' : (ref.slice(hash + 1).split('#').pop() ?? '').trim();
	const anchor = heading && !heading.startsWith('^') ? `#${slugify(heading)}` : '';
	const text = alias || (heading ? (target ? `${target} › ${heading}` : heading) : target);

	if (!target) return `<a href="${escape(anchor || '#')}">${escape(text)}</a>`;
	if (embed && /\.(?!md$)[a-z0-9]{2,5}$/i.test(target)) {
		return `<span class="missing" title="${NOT_SYNCED}">${escape(target)}</span>`;
	}
	const path = env.links[target];
	if (!path) return `<span class="missing" title="No page yet">${escape(text)}</span>`;
	return `<a class="internal${embed ? ' embed' : ''}" href="${escape(env.href(path) + anchor)}">${escape(text)}</a>`;
};

// #tags, after a space or at the start, with at least one character that isn't a digit.
md.inline.ruler.push('tag', (state: StateInline, silent: boolean) => {
	if (state.src.charCodeAt(state.pos) !== 0x23 /* # */) return false;
	if (state.pos > 0 && !/\s/.test(state.src[state.pos - 1])) return false;
	const found = /^#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/u.exec(state.src.slice(state.pos));
	if (!found) return false;
	if (!silent) state.push('tag', '', 0).content = found[1];
	state.pos += found[0].length;
	return true;
});
md.renderer.rules.tag = (tokens, idx) => `<span class="tag">#${escape(tokens[idx].content)}</span>`;

// Headings get ids, so [[Page#Heading]] and the table of contents can point at them.
md.core.ruler.push('heading_ids', (state: StateCore) => {
	const used = new Map<string, number>();
	state.tokens.forEach((token, i) => {
		if (token.type !== 'heading_open') return;
		const base = slugify(state.tokens[i + 1].content) || 'section';
		const n = used.get(base) ?? 0;
		used.set(base, n + 1);
		token.attrSet('id', n ? `${base}-${n}` : base);
	});
});

// - [ ] and - [x] become checkboxes, read-only.
md.core.ruler.after('inline', 'tasks', (state: StateCore) => {
	const tokens = state.tokens;
	for (let i = 2; i < tokens.length; i++) {
		const inline = tokens[i];
		if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
		const box = /^\[([ xX])\][ \t]/.exec(inline.content);
		const first = inline.children?.[0];
		if (!box || first?.type !== 'text' || !first.content.startsWith(box[0])) continue;
		first.content = first.content.slice(box[0].length);
		const input = new state.Token('html_inline', '', 0);
		input.content = `<input type="checkbox" disabled${box[1] === ' ' ? '' : ' checked'}> `;
		inline.children!.unshift(input);
		tokens[i - 2].attrJoin('class', 'task');
	}
});

// > [!note] Title  callouts.
md.core.ruler.after('inline', 'callouts', (state: StateCore) => {
	const tokens = state.tokens;
	for (let i = 0; i < tokens.length - 3; i++) {
		if (tokens[i].type !== 'blockquote_open' || tokens[i + 1].type !== 'paragraph_open') continue;
		const inline = tokens[i + 2];
		const marker = /^\[!([\w-]+)\][+-]?/.exec(inline.content);
		const children = inline.children ?? [];
		if (!marker || children[0]?.type !== 'text' || !children[0].content.startsWith(marker[0])) continue;
		const kind = marker[1].toLowerCase();
		children[0].content = children[0].content.slice(marker[0].length).replace(/^[ \t]+/, '');
		const line = children.findIndex((c) => c.type === 'softbreak' || c.type === 'hardbreak');
		const title = line < 0 ? children : children.slice(0, line);
		inline.children = line < 0 ? [] : children.slice(line + 1);
		const titleHtml = state.md.renderer.renderInline(title, state.md.options, state.env).trim();

		tokens[i].attrJoin('class', `callout callout-${kind}`);
		const heading = new state.Token('html_block', '', 0);
		heading.content = `<p class="callout-title">${titleHtml || escape(kind[0].toUpperCase() + kind.slice(1))}</p>\n`;
		if (!inline.children.length) tokens[i + 1].hidden = tokens[i + 3].hidden = true;
		tokens.splice(i + 1, 0, heading);
	}
});

// Links: other sites open in a new tab; links to .md pages go to the reader.
md.renderer.rules.link_open = (tokens, idx, options, rendering, self) => {
	const env = rendering as unknown as RenderContext;
	const token = tokens[idx];
	const href = String(token.attrGet('href') ?? '');
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
		token.attrSet('target', '_blank');
		token.attrSet('rel', 'noopener noreferrer nofollow ugc');
	} else if (!href.startsWith('#')) {
		token.attrSet('href', localHref(href, env));
	}
	return self.renderToken(tokens, idx, options);
};

// Images from the web show; anything else would be an attachment, which isn't synced yet.
md.renderer.rules.image = (tokens, idx, options, env, self) => {
	const token = tokens[idx];
	const src = String(token.attrGet('src') ?? '');
	const alt = self.renderInlineAsText(token.children ?? [], options, env);
	if (!/^(https:|data:image\/)/i.test(src)) return `<span class="missing" title="${NOT_SYNCED}">${escape(alt || src)}</span>`;
	token.attrSet('alt', alt);
	token.attrSet('loading', 'lazy');
	token.attrSet('referrerpolicy', 'no-referrer');
	return self.renderToken(tokens, idx, options);
};

/** A link to another page by its path, relative to this page's folder ("../Plan.md") or to the root ("/Plan.md"). */
function localHref(href: string, env: RenderContext): string {
	const hash = href.indexOf('#');
	const pathPart = hash < 0 ? href : href.slice(0, hash);
	const heading = hash < 0 ? '' : href.slice(hash + 1);
	let path: string;
	try {
		path = decodeURIComponent(pathPart);
	} catch {
		return '#';
	}
	if (!/\.md$/i.test(path)) return href;
	const parts = path.startsWith('/') ? [] : env.path.split('/').slice(0, -1);
	for (const part of path.split('/')) {
		if (part === '..') {
			if (!parts.length) return '#';
			parts.pop();
		} else if (part && part !== '.') parts.push(part);
	}
	let anchor = '';
	try {
		anchor = heading ? `#${slugify(decodeURIComponent(heading))}` : '';
	} catch {
		// A malformed anchor: link to the page itself.
	}
	return env.href(parts.join('/')) + anchor;
}

/** YAML frontmatter as simple key and value text: "key: value", and "- item" lists under a key. */
function frontmatter(src: string): { properties: [string, string][]; body: string } {
	const found = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
	if (!found) return { properties: [], body: src };
	const properties: [string, string[]][] = [];
	for (const line of found[1].split(/\r?\n/)) {
		const item = /^\s+-\s*(.*)$/.exec(line);
		const pair = /^([^\s:#][^:]*):\s*(.*)$/.exec(line);
		if (item && properties.length) properties.at(-1)![1].push(unquote(item[1]));
		else if (pair) properties.push([pair[1].trim(), pair[2] ? [unquote(pair[2])] : []]);
	}
	return {
		properties: properties.map(([key, values]) => [key, values.join(', ').replace(/^\[(.*)\]$/, '$1')]),
		body: src.slice(found[0].length)
	};
}

const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, '$2');

/** The text of an inline token's children, with [[links]] as their text. */
function plainText(children: Token[]): string {
	return children
		.map((child) => {
			if (child.type === 'wikilink') {
				const inner = (child.meta as { inner: string }).inner;
				return inner.includes('|') ? inner.slice(inner.indexOf('|') + 1) : wikilinkTarget(inner);
			}
			if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
			return child.type === 'text' || child.type === 'code_inline' ? child.content : '';
		})
		.join('')
		.trim();
}

export function renderMarkdown(src: string, context: RenderContext): Rendered {
	const { properties, body } = frontmatter(src);
	// %% Obsidian comments %% are hidden in reading view.
	const text = body.replace(/%%[\s\S]*?%%/g, '');
	const env = { ...context };
	const tokens = md.parse(text, env);

	let description = '';
	for (let i = 1; i < tokens.length && !description; i++) {
		if (tokens[i].type === 'inline' && tokens[i - 1].type === 'paragraph_open') description = plainText(tokens[i].children ?? []);
	}
	if (description.length > 160) description = `${description.slice(0, 157).replace(/\s+\S*$/, '')}…`;

	return {
		html: md.renderer.render(tokens, md.options, env),
		properties,
		description,
		titled: tokens[0]?.type === 'heading_open' && tokens[0].tag === 'h1'
	};
}
