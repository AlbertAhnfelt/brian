export const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** A bare page in the website's style. `body` must already be escaped. */
export function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Brian</title>
<style>
	body { margin: 0; background: #faf8f5; color: #1a1a1a; font: 18px/1.6 'EB Garamond', Garamond, Georgia, serif; }
	main { max-width: 26rem; margin: 5rem auto; padding: 2rem; border: 1px solid #e8e3dc; border-radius: 1rem; background: #fff; }
	h1 { margin: 0 0 0.5rem; font-size: 1.75rem; font-weight: 500; }
	p { margin: 0 0 1rem; color: #75716b; }
	strong { color: #1a1a1a; font-weight: 600; }
	.warning { color: #e3120b; }
	.actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
	button { padding: 0.6rem 1.2rem; border: 1px solid #1a1a1a; border-radius: 999px; font: inherit; cursor: pointer; }
	button[value=approve] { background: #1a1a1a; color: #faf8f5; }
	button[value=deny] { background: transparent; color: #1a1a1a; }
</style>
<main>${body}</main>
</html>`;
}
