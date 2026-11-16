import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { purgeDeletedBrians } from './brian/members';
import { oauthOptions } from './oauth';

const provider = new OAuthProvider<Env>(oauthOptions);

export default {
	fetch: (request, env, ctx) => provider.fetch(request, env, ctx),
	/** Daily: erases the brians that have been in the trash longer than LIMITS.trashDays. */
	async scheduled(_controller, env) {
		const purged = await purgeDeletedBrians(env);
		if (purged) console.log(`Purged ${purged} deleted brian${purged === 1 ? '' : 's'}.`);
	}
} satisfies ExportedHandler<Env>;

export { Account } from './account';
export { Vault } from './vault/vault';
