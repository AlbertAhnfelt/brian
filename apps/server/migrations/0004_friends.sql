-- People a user has added as friends, to find them again when sharing a brian. One-way: adding
-- someone doesn't add you to their list, and tells them nothing.
CREATE TABLE friends (
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	friend_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (user_id, friend_id)
);

CREATE INDEX friends_friend_id ON friends (friend_id);
