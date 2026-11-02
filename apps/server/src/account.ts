import { getOAuthApi } from '@cloudflare/workers-oauth-provider';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { oauthOptions } from './oauth';
import type { AccountRpc, Connection } from '@brian/shared';
import type { Page } from './vault/vault';

/**
 * Account management for the website, over a service binding. Not reachable from the internet:
 * only Workers bound to it can call it, and the website passes the user ID from its own session.
 */
export class Account extends WorkerEntrypoint<Env> implements AccountRpc {
	/** Apps (Claude, ChatGPT, …) the user has connected. */
	async connections(userId: string): Promise<Connection[]> {
		const oauth = getOAuthApi(oauthOptions, this.env);
		const grants = await this.grants(userId);
		return Promise.all(
			grants.map(async (grant) => {
				const client = await oauth.lookupClient(grant.clientId).catch(() => null);
				return { grantId: grant.id, clientName: client?.clientName || grant.clientId, createdAt: grant.createdAt };
			})
		);
	}

	async disconnect(userId: string, grantId: string): Promise<void> {
		await getOAuthApi(oauthOptions, this.env).revokeGrant(grantId, userId);
	}

	async exportPages(userId: string): Promise<Page[]> {
		return this.env.VAULT.getByName(userId).exportAll();
	}

	/** Revokes every connected app and erases the vault. The website deletes the user rows. */
	async deleteAccount(userId: string): Promise<void> {
		// No client lookups here: a CIMD client's metadata fetch must not be able to slow deletion.
		const oauth = getOAuthApi(oauthOptions, this.env);
		for (const grant of await this.grants(userId)) await oauth.revokeGrant(grant.id, userId);
		await this.env.VAULT.getByName(userId).destroy();
	}

	private async grants(userId: string) {
		const oauth = getOAuthApi(oauthOptions, this.env);
		const grants = [];
		let cursor: string | undefined;
		do {
			const page = await oauth.listUserGrants(userId, { cursor });
			grants.push(...page.items);
			cursor = page.cursor;
		} while (cursor);
		return grants;
	}
}
