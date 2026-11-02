-- One row per person.
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	name TEXT,
	created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX users_email ON users (email);

-- One row per login method (Google, GitHub, Apple) linked to a user.
CREATE TABLE accounts (
	provider TEXT NOT NULL,
	provider_user_id TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	email TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (provider, provider_user_id)
);

CREATE INDEX accounts_user_id ON accounts (user_id);

-- Website sessions. Only the SHA-256 of the session token is stored.
CREATE TABLE sessions (
	id_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	expires_at INTEGER NOT NULL
);

CREATE INDEX sessions_user_id ON sessions (user_id);
