-- Shared brians: folders of pages that several people can be members of.
-- A user's personal brian is not a row here. It is the vault named by their user ID, and it can
-- never be shared.
CREATE TABLE brians (
	-- "b_" + UUID. Also names the brian's Vault Durable Object, so it can't collide with a user ID.
	id TEXT PRIMARY KEY,
	-- Same rules as usernames. The folder name new members get, unless it's taken in their Brian.
	name TEXT NOT NULL,
	-- private: invite only, even to see it. public: anyone can join as a viewer.
	visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
	created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE members (
	brian_id TEXT NOT NULL REFERENCES brians (id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	-- owner: one per brian, manages members. editor: edits reach every member. viewer: read-only.
	role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
	-- The folder this brian appears as in this user's Brian: brian/<mount>/.
	mount TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (brian_id, user_id),
	UNIQUE (user_id, mount)
);

CREATE UNIQUE INDEX members_one_owner ON members (brian_id) WHERE role = 'owner';
