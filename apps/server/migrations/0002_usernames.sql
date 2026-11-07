-- Chosen once, after the first login (see packages/shared/src/usernames.ts). NULL until then.
ALTER TABLE users ADD COLUMN username TEXT;

CREATE UNIQUE INDEX users_username ON users (username);
