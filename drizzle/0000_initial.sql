CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE auth_limits (username TEXT PRIMARY KEY NOT NULL, failures INTEGER NOT NULL, window_start INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE scenarios (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), route TEXT NOT NULL, date TEXT NOT NULL, price REAL NOT NULL, created_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX scenarios_user_created ON scenarios(user_id, created_at);
