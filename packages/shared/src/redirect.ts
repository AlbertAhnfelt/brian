/**
 * Returns `next` if it's a same-site relative path, else `fallback`. Prevents open redirects.
 * Resolves `next` the way a browser would (which ignores tabs and newlines, and treats "\" as "/")
 * and requires it to stay on the same origin.
 */
export function safeNext(next: string | null | undefined, fallback = '/connect'): string {
	if (!next || !next.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
	const base = 'https://brian.invalid';
	const url = new URL(next, base);
	if (url.origin !== base) return fallback;
	return url.pathname + url.search + url.hash;
}
