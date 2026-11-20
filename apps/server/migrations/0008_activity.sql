-- What happened to shared brians themselves: created, shared, roles changed, deleted… (Page changes
-- are recorded by each brian's Durable Object, in its history table.) Kept for as long as the
-- brian exists; erased with it when it's purged or its owner's account is deleted.
CREATE TABLE activity (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	brian_id TEXT NOT NULL,
	-- Who did it, and with what ("website", or the app's self-declared name).
	user_id TEXT NOT NULL,
	source TEXT NOT NULL,
	-- brian.create, brian.invite, brian.role… (ActivityAction in @brian/shared).
	action TEXT NOT NULL,
	-- Who it was about: their user id when they have an account, and the username or email address
	-- to show (and to pass to cancelInvite / invite / setRole when undoing).
	target_user TEXT,
	target TEXT,
	-- The role given, and the earlier role, visibility or name it replaced.
	role TEXT,
	from_value TEXT,
	-- Milliseconds, like page history.
	at INTEGER NOT NULL
);

CREATE INDEX activity_brian_at ON activity (brian_id, at);
