// Schema migrations (embedded as strings so they are bundled with the serverless function).
// Tokens: {{PK}} auto-increment primary key, {{TS}} timestamp type (TEXT ISO-8601 on SQLite, TIMESTAMPTZ on Postgres).
// Statements are separated by ";" followed by a newline. Never edit an applied migration; add a new one.
//
// v2 schema note: the original starter used tables named users/wishes/contributions/reports with a different
// shape and DEFAULT file ./data/wishly.sqlite. The new schema uses a NEW default file (wishly-v2.sqlite) so the
// old file is never modified; `npm run import:legacy` copies the old data across.
const MIGRATIONS = [
  {
    name: "001_init",
    sql: `
CREATE TABLE users (
  id {{PK}},
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'individual' CHECK (role IN ('individual','supporter','organization','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned','deleted')),
  email_verified_at {{TS}},
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  bio TEXT,
  notification_prefs TEXT NOT NULL DEFAULT '{}',
  created_at {{TS}} NOT NULL,
  updated_at {{TS}} NOT NULL,
  last_login_at {{TS}},
  deleted_at {{TS}}
);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(status);

CREATE TABLE organizations (
  id {{PK}},
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  org_name TEXT NOT NULL,
  description TEXT,
  website TEXT,
  created_at {{TS}} NOT NULL,
  updated_at {{TS}} NOT NULL
);

CREATE TABLE sessions (
  id {{PK}},
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at {{TS}} NOT NULL,
  expires_at {{TS}} NOT NULL,
  last_seen_at {{TS}} NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE email_tokens (
  id {{PK}},
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verify','reset')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at {{TS}} NOT NULL,
  expires_at {{TS}} NOT NULL,
  used_at {{TS}}
);
CREATE INDEX idx_email_tokens_user ON email_tokens(user_id, kind);

CREATE TABLE wishlists (
  id {{PK}},
  owner_id BIGINT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','unlisted','private')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','removed')),
  share_code TEXT NOT NULL UNIQUE,
  created_at {{TS}} NOT NULL,
  updated_at {{TS}} NOT NULL
);
CREATE INDEX idx_wishlists_owner ON wishlists(owner_id);
CREATE INDEX idx_wishlists_visibility ON wishlists(visibility, status);

CREATE TABLE wishes (
  id {{PK}},
  wishlist_id BIGINT NOT NULL REFERENCES wishlists(id),
  owner_id BIGINT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Education','Healthcare','Technology','Daily Essentials','Personal Development','Family Needs','Community Support','Bills','Other')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  target_amount BIGINT NOT NULL CHECK (target_amount >= 10000 AND target_amount <= 100000000),
  image_url TEXT,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','fulfilled','closed','removed')),
  bill_provider TEXT,
  bill_reference TEXT,
  bill_due_date TEXT,
  fulfilled_at {{TS}},
  created_at {{TS}} NOT NULL,
  updated_at {{TS}} NOT NULL
);
CREATE INDEX idx_wishes_wishlist ON wishes(wishlist_id);
CREATE INDEX idx_wishes_owner ON wishes(owner_id);
CREATE INDEX idx_wishes_status ON wishes(status, category, priority);

CREATE TABLE contributions (
  id {{PK}},
  reference TEXT NOT NULL UNIQUE,
  wish_id BIGINT NOT NULL REFERENCES wishes(id),
  supporter_id BIGINT NOT NULL REFERENCES users(id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  fee_amount BIGINT NOT NULL CHECK (fee_amount >= 0),
  net_amount BIGINT NOT NULL CHECK (net_amount > 0),
  message TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled','refunded')),
  paymongo_link_id TEXT,
  checkout_url TEXT,
  created_at {{TS}} NOT NULL,
  updated_at {{TS}} NOT NULL,
  paid_at {{TS}}
);
CREATE INDEX idx_contrib_wish ON contributions(wish_id, status);
CREATE INDEX idx_contrib_supporter ON contributions(supporter_id, created_at);
CREATE INDEX idx_contrib_link ON contributions(paymongo_link_id);

CREATE TABLE transactions (
  id {{PK}},
  contribution_id BIGINT NOT NULL REFERENCES contributions(id),
  provider TEXT NOT NULL DEFAULT 'paymongo',
  provider_event_id TEXT,
  provider_ref TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('payment','failure','refund','mismatch')),
  amount BIGINT NOT NULL,
  status TEXT NOT NULL,
  created_at {{TS}} NOT NULL
);
CREATE INDEX idx_tx_contrib ON transactions(contribution_id);

CREATE TABLE webhook_events (
  id {{PK}},
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  outcome TEXT,
  received_at {{TS}} NOT NULL
);

CREATE TABLE notifications (
  id {{PK}},
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  read_at {{TS}},
  created_at {{TS}} NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at);

CREATE TABLE reports (
  id {{PK}},
  reporter_id BIGINT REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('wishlist','wish','user')),
  target_id BIGINT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  resolved_by BIGINT REFERENCES users(id),
  resolution_note TEXT,
  created_at {{TS}} NOT NULL,
  resolved_at {{TS}}
);
CREATE UNIQUE INDEX idx_reports_once ON reports(reporter_id, target_type, target_id) WHERE reporter_id IS NOT NULL;
CREATE INDEX idx_reports_target ON reports(target_type, target_id, status);
CREATE INDEX idx_reports_status ON reports(status, created_at);

CREATE TABLE verification_requests (
  id {{PK}},
  user_id BIGINT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('identity','organization')),
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  reviewed_by BIGINT REFERENCES users(id),
  review_note TEXT,
  created_at {{TS}} NOT NULL,
  reviewed_at {{TS}}
);
CREATE INDEX idx_verif_status ON verification_requests(status, created_at);
CREATE UNIQUE INDEX idx_verif_one_pending ON verification_requests(user_id) WHERE status = 'pending';

CREATE TABLE saved_wishlists (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wishlist_id BIGINT NOT NULL REFERENCES wishlists(id) ON DELETE CASCADE,
  created_at {{TS}} NOT NULL,
  PRIMARY KEY (user_id, wishlist_id)
);

CREATE TABLE announcements (
  id {{PK}},
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at {{TS}} NOT NULL
);

CREATE TABLE audit_logs (
  id {{PK}},
  actor_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  meta TEXT,
  ip TEXT,
  created_at {{TS}} NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  count INTEGER NOT NULL
);
`,
  },
];

module.exports = { MIGRATIONS };
