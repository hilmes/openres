CREATE TABLE IF NOT EXISTS openres_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS openres_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS openres_sessions_expires_idx ON openres_sessions (expires);
CREATE TABLE IF NOT EXISTS openres_reservations (
  id text PRIMARY KEY,
  service_date text NOT NULL,
  email text NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS openres_reservations_date_idx ON openres_reservations (service_date);
CREATE INDEX IF NOT EXISTS openres_reservations_email_idx ON openres_reservations (email);
CREATE TABLE IF NOT EXISTS openres_limits (
  key text PRIMARY KEY,
  hits integer NOT NULL,
  expires bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS openres_access_audit (
  id text PRIMARY KEY,
  recorded_at text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  scope text NOT NULL
);
