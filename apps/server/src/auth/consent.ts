import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { escape, page } from './html';

export function consentPage(details: ConsentDescription, handle: string, email: string): string {
	const name = escape(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escape(details.clientDomain)}</strong>.`
		: 'This app registered itself, so its name is not verified.';
	const loopbackWarning = details.redirectIsLoopback
		? '<p class="warning">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>'
		: '';

	return page(
		`Connect ${details.clientName}`,
		`<h1>Connect ${name} to your Brian?</h1>
<p>${origin} It will be able to read and write your Brian. Access is sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${loopbackWarning}
<p>Signed in as <strong>${escape(email)}</strong>.</p>
<form method="post">
	<input type="hidden" name="handle" value="${escape(handle)}">
	<div class="actions">
		<button name="decision" value="approve">Allow</button>
		<button name="decision" value="deny">Deny</button>
	</div>
</form>`
	);
}
