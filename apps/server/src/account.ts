import { getOAuthApi } from '@cloudflare/workers-oauth-provider';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { oauthOptions } from './oauth';
import type { AccountRpc, BrianSummary, BrianView, Connection, Outcome, Role, Visibility } from '@brian/shared';
import * as members from './brian/members';
import type { ExportedPage } from './vault/vault';

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

	/** The personal brian, plus every shared brian the user is in, under brian/<mount>/. */
	async exportPages(userId: string): Promise<ExportedPage[]> {
		const pages = await this.env.VAULT.getByName(userId).exportAll();
		for (const brian of await members.membershipsOf(this.env.DB, userId)) {
			const shared = await this.env.VAULT.getByName(brian.id).exportAll();
			pages.push(...shared.map((page) => ({ ...page, path: `brian/${brian.mount}/${page.path}` })));
		}
		return pages;
	}

	/**
	 * Revokes every connected app, erases the personal brian and the brians the user owns, and
	 * leaves the others. The website deletes the user rows.
	 */
	async deleteAccount(userId: string): Promise<void> {
		// No client lookups here: a CIMD client's metadata fetch must not be able to slow deletion.
		const oauth = getOAuthApi(oauthOptions, this.env);
		for (const grant of await this.grants(userId)) await oauth.revokeGrant(grant.id, userId);
		await members.removeUserFromBrians(this.env, userId);
		await this.env.VAULT.getByName(userId).destroy();
	}

	/** After the username is chosen: writes the starting brian/BRIAN.md. */
	setUp(userId: string): Promise<void> {
		return members.setUp(this.env, userId);
	}

	brians(userId: string): Promise<BrianSummary[]> {
		return members.membershipsOf(this.env.DB, userId);
	}

	viewBrian(userId: string, brianId: string): Promise<BrianView | null> {
		return members.viewBrian(this.env.DB, userId, brianId);
	}

	createBrian(userId: string, name: string, visibility: Visibility): Promise<Outcome<BrianSummary>> {
		return members.createBrian(this.env, userId, name, visibility);
	}

	setVisibility(userId: string, brianId: string, visibility: Visibility): Promise<Outcome> {
		return members.setVisibility(this.env.DB, userId, brianId, visibility);
	}

	addMember(userId: string, brianId: string, username: string, role: Exclude<Role, 'owner'>): Promise<Outcome> {
		return members.addMember(this.env, userId, brianId, username, role);
	}

	setRole(userId: string, brianId: string, username: string, role: Exclude<Role, 'owner'>): Promise<Outcome> {
		return members.setRole(this.env, userId, brianId, username, role);
	}

	removeMember(userId: string, brianId: string, username: string): Promise<Outcome> {
		return members.removeMember(this.env, userId, brianId, username);
	}

	join(userId: string, brianId: string): Promise<Outcome<BrianSummary>> {
		return members.join(this.env, userId, brianId);
	}

	leave(userId: string, brianId: string): Promise<Outcome> {
		return members.leave(this.env, userId, brianId);
	}

	deleteBrian(userId: string, brianId: string): Promise<Outcome> {
		return members.deleteBrian(this.env, userId, brianId);
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
