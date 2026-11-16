-- Invitations to an email address with no Brian account behind it yet. When someone signs in with a
-- matching verified email, each one becomes a normal invitation (invites) for them to accept.
CREATE TABLE email_invites (
	brian_id TEXT NOT NULL REFERENCES brians (id) ON DELETE CASCADE,
	-- Lowercase.
	email TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
	invited_by TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (brian_id, email)
);

CREATE INDEX email_invites_email ON email_invites (email);

-- Deleted brians stay in the trash for LIMITS.trashDays: the row keeps its id and name, the
-- memberships move to deleted_members (freeing everyone's folder names), and the pages stay in the
-- brian's Vault until the daily purge erases them. Restoring puts the members back.
ALTER TABLE brians ADD COLUMN deleted_at INTEGER;

CREATE TABLE deleted_members (
	brian_id TEXT NOT NULL REFERENCES brians (id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
	mount TEXT NOT NULL,
	PRIMARY KEY (brian_id, user_id)
);

CREATE INDEX deleted_members_user_id ON deleted_members (user_id);

-- 1: the user's agents (MCP apps) may create, share, change and delete brians, as the user can on
-- the website. 0: they can't. One switch for all agents, on /account.
ALTER TABLE users ADD COLUMN agents_manage_brians INTEGER NOT NULL DEFAULT 1;

-- The address an invitation was sent to, when it was sent by email (lowercase), so the owner sees
-- what they typed rather than the invitee's other addresses.
ALTER TABLE invites ADD COLUMN email TEXT;
