-- How much each brian stores, reported by its Durable Object, so a user's total can be capped
-- (LIMITS.storageBytesPerUser). `vault` is the Durable Object's name: a user id for a personal
-- brian, "b_…" for a shared one. `owner` is whose storage it counts against.
CREATE TABLE storage (
	vault TEXT PRIMARY KEY,
	owner TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	bytes INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX storage_owner ON storage (owner);
