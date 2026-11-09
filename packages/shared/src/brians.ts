/** A member's role in a shared brian. Each brian has exactly one owner. */
export type Role = 'owner' | 'editor' | 'viewer';
/** private: invite only, even to see it. public: anyone can join as a viewer. */
export type Visibility = 'private' | 'public';

export const ROLES: readonly Role[] = ['owner', 'editor', 'viewer'];
export const VISIBILITIES: readonly Visibility[] = ['private', 'public'];

/** A shared brian as one of its members sees it. */
export interface BrianSummary {
	id: string;
	name: string;
	visibility: Visibility;
	role: Role;
	/** Its folder in this member's Brian: brian/<mount>/. */
	mount: string;
}

export interface Member {
	username: string;
	role: Role;
}

/** An invitation the owner has sent and the person hasn't answered yet. */
export interface SentInvite {
	username: string;
	role: Exclude<Role, 'owner'>;
}

/** An invitation waiting for the signed-in user to accept or decline. */
export interface Invite {
	brianId: string;
	brianName: string;
	role: Exclude<Role, 'owner'>;
	/** Username of the owner who invited them. */
	from: string;
	createdAt: number;
}

/**
 * One brian, for its page on the website. Members see everything (owners also see the invites they
 * have sent); anyone else sees a public brian's name only, and a private brian not at all (null, as
 * if it didn't exist).
 */
export type BrianView =
	| { member: true; brian: BrianSummary; members: Member[]; invites: SentInvite[] }
	| { member: false; brian: { id: string; name: string; visibility: 'public' } };

/** Result of a membership change. `message` is safe to show the user. */
export type Outcome<T = undefined> = { ok: true; value: T } | { ok: false; message: string };
