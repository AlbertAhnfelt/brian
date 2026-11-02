/** Returns `next` if it's a same-site relative path, else `fallback`. Prevents open redirects. */
export function safeNext(next: string | null | undefined, fallback = '/connect'): string {
	if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
	return next;
}
