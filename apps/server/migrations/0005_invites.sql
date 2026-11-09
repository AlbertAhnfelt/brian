-- Invitations to shared brians. An owner invites a friend; the friend becomes a member only when
-- they accept. Nobody can be put in a brian without saying yes.
CREATE TABLE invites (
	brian_id TEXT NOT NULL REFERENCES brians (id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	-- The role they get on accepting. Owners are never invited.
	role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
	invited_by TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (brian_id, user_id)
);

CREATE INDEX invites_user_id ON invites (user_id);
