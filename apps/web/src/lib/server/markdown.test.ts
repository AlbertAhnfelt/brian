import { describe, expect, it } from 'vitest';
import { readerHref } from '#lib/reader.ts';
import { renderMarkdown, type RenderContext } from './markdown.ts';

const context = (links: RenderContext['links'] = {}, path = 'notes/home.md'): RenderContext => ({
	path,
	links,
	href: (p) => readerHref('/notes', p)
});

const html = (src: string, links?: RenderContext['links'], path?: string) => renderMarkdown(src, context(links, path)).html;

describe('rendering pages safely', () => {
	it('shows raw HTML as text, never as markup', () => {
		const out = html('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
		expect(out).not.toContain('<script');
		expect(out).not.toContain('<img');
		expect(out).toContain('&lt;script&gt;');
	});

	it('refuses script links', () => {
		expect(html('[x](javascript:alert(1))')).not.toContain('href="javascript');
		expect(html('[x](JAVASCRIPT:alert(1))')).not.toMatch(/href="javascript/i);
		expect(html('![x](javascript:alert(1))')).not.toMatch(/(src|href)="javascript/i);
	});

	it('escapes what goes into wikilinks, tags and callout titles', () => {
		expect(html('[["><script>x</script>]]')).not.toContain('<script');
		expect(html('[[a|"><b>]]', { a: 'a.md' })).toContain('&quot;&gt;&lt;b&gt;');
		expect(html('#tag"><b>')).not.toContain('"><b>');
		expect(html('> [!note] <b>hi</b>\n> body')).not.toContain('<b>');
	});

	it('opens other sites in a new tab, without passing anything on', () => {
		expect(html('[x](https://example.com)')).toContain('rel="noopener noreferrer nofollow ugc"');
	});
});

describe('Obsidian markdown', () => {
	it('links [[wikilinks]] to the pages the server found, and marks missing ones', () => {
		const out = html('[[Idea]] [[notes/Plan#The Why|why]] [[Gone]] [[#Local heading]]', { Idea: 'deep/Idea.md', 'notes/Plan': 'notes/Plan.md', Gone: null });
		expect(out).toContain('<a class="internal" href="/notes/deep/Idea.md">Idea</a>');
		expect(out).toContain('<a class="internal" href="/notes/notes/Plan.md#the-why">why</a>');
		expect(out).toContain('<span class="missing" title="No page yet">Gone</span>');
		expect(out).toContain('<a href="#local-heading">Local heading</a>');
	});

	it('encodes page paths in links', () => {
		expect(html('[[Q&A?]]', { 'Q&A?': 'my notes/Q&A?.md' })).toContain('href="/notes/my%20notes/Q%26A%3F.md"');
	});

	it('shows embedded attachments as not synced, and embedded pages as links', () => {
		expect(html('![[photo.png]]')).toContain('class="missing"');
		expect(html('![[Idea]]', { Idea: 'Idea.md' })).toContain('class="internal embed"');
	});

	it('follows relative markdown links to pages', () => {
		expect(html('[a](../Plan.md) [b](sub/Deep%20one.md#Some%20Part) [c](/Root.md)', {}, 'notes/x/home.md')).toMatch(
			/href="\/notes\/notes\/Plan.md".*href="\/notes\/notes\/x\/sub\/Deep%20one.md#some-part".*href="\/notes\/Root.md"/
		);
		expect(html('[up](../../../x.md)')).toContain('href="#"');
	});

	it('renders tasks, callouts, highlights, tags, footnotes and heading ids', () => {
		const out = html('# Top\n\n- [ ] todo\n- [x] done\n\n> [!warning] Careful\n> really\n\n==hi== #idea/sub\n\nNote[^1]\n\n[^1]: Footnote.');
		expect(out).toContain('<h1 id="top">Top</h1>');
		expect(out).toContain('<li class="task"><input type="checkbox" disabled> todo</li>');
		expect(out).toContain('<input type="checkbox" disabled checked> done');
		expect(out).toContain('<blockquote class="callout callout-warning">\n<p class="callout-title">Careful</p>\n<p>really</p>');
		expect(out).toContain('<mark>hi</mark> <span class="tag">#idea/sub</span>');
		expect(out).toContain('class="footnotes"');
	});

	it('gives a callout without a title its kind as title, and hides an empty body', () => {
		expect(html('> [!tip]')).toBe('<blockquote class="callout callout-tip">\n<p class="callout-title">Tip</p>\n</blockquote>\n');
	});

	it('does not treat numbers or mid-word # as tags', () => {
		const out = html('issue #12 and a#b');
		expect(out).not.toContain('class="tag"');
	});

	it('hides %% comments %%', () => {
		expect(html('shown %%hidden%% too')).toBe('<p>shown  too</p>\n');
	});

	it('reads frontmatter as properties and describes the page by its first paragraph', () => {
		const page = renderMarkdown('---\ntitle: "Hi"\ntags:\n  - a\n  - b\naliases: [x, y]\n---\n# Head\n\nFirst [[Idea|idea]] here.\n\nSecond.', context());
		expect(page.properties).toEqual([
			['title', 'Hi'],
			['tags', 'a, b'],
			['aliases', 'x, y']
		]);
		expect(page.description).toBe('First idea here.');
		expect(page.titled).toBe(true);
		expect(page.html).not.toContain('tags');
	});
});
