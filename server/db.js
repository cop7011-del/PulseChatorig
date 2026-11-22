const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const AVATARS_DIR = path.join(UPLOADS_DIR, 'avatars');
const BANNERS_DIR = path.join(UPLOADS_DIR, 'banners');
const ATTACH_DIR = path.join(UPLOADS_DIR, 'attachments');
const DB_PATH = path.join(DATA_DIR, 'pulsechat.db');

for (const d of [DATA_DIR, UPLOADS_DIR, AVATARS_DIR, BANNERS_DIR, ATTACH_DIR]) fs.mkdirSync(d, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  custom_status TEXT NOT NULL DEFAULT '',
  custom_status_emoji TEXT NOT NULL DEFAULT '',
  presence TEXT NOT NULL DEFAULT 'offline',
  last_seen INTEGER NOT NULL,
  avatar_file TEXT,
  avatar_version INTEGER NOT NULL DEFAULT 1,
  banner_file TEXT,
  banner_version INTEGER NOT NULL DEFAULT 1,
  banner_gradient TEXT NOT NULL DEFAULT 'sunset',
  accent_color TEXT NOT NULL DEFAULT '#5b8cff',
  bubble_style TEXT NOT NULL DEFAULT 'rounded',
  theme TEXT NOT NULL DEFAULT 'dark',
  chat_bg TEXT NOT NULL DEFAULT 'default',
  privacy_last_seen TEXT NOT NULL DEFAULT 'all',
  privacy_avatar TEXT NOT NULL DEFAULT 'all',
  privacy_online TEXT NOT NULL DEFAULT 'all',
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  banned_reason TEXT NOT NULL DEFAULT '',
  is_premium INTEGER NOT NULL DEFAULT 0,
  premium_until INTEGER NOT NULL DEFAULT 0,
  tag TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT,
  description TEXT NOT NULL DEFAULT '',
  username TEXT UNIQUE COLLATE NOCASE,
  avatar_file TEXT,
  avatar_version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  pinned INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  last_read_message_id TEXT,
  last_read_at INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(chat_id, user_id),
  FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  reply_to_id TEXT,
  forwarded_from TEXT,
  edited_at INTEGER,
  deleted_for_all INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY(sender_id) REFERENCES users(id),
  FOREIGN KEY(reply_to_id) REFERENCES messages(id)
);

CREATE TABLE IF NOT EXISTS message_deletions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY(message_id, user_id),
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(message_id, user_id, emoji),
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(blocker_id, blocked_id),
  FOREIGN KEY(blocker_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(blocked_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gifts_catalog (
  id TEXT PRIMARY KEY,
  emoji TEXT NOT NULL,
  name TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  bg TEXT NOT NULL DEFAULT 'linear-gradient(135deg,#5b8cff,#8b5cf6)'
);

CREATE TABLE IF NOT EXISTS user_gifts (
  id TEXT PRIMARY KEY,
  gift_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  transferred_at INTEGER NOT NULL DEFAULT 0,
  transferred_to_user_id TEXT,
  FOREIGN KEY(gift_id) REFERENCES gifts_catalog(id),
  FOREIGN KEY(from_user_id) REFERENCES users(id),
  FOREIGN KEY(to_user_id) REFERENCES users(id),
  FOREIGN KEY(transferred_to_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_gifts_to ON user_gifts(to_user_id, created_at DESC);
`);

function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('users', 'is_admin', 'is_admin INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'is_banned', 'is_banned INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'banned_reason', "banned_reason TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'is_premium', 'is_premium INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'premium_until', 'premium_until INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'tag', "tag TEXT NOT NULL DEFAULT ''");
ensureColumn('chats', 'description', "description TEXT NOT NULL DEFAULT ''");
ensureColumn('chats', 'username', 'username TEXT');
ensureColumn('chats', 'is_public', 'is_public INTEGER NOT NULL DEFAULT 0');
ensureColumn('user_gifts', 'transferred_at', 'transferred_at INTEGER NOT NULL DEFAULT 0');
ensureColumn('user_gifts', 'transferred_to_user_id', 'transferred_to_user_id TEXT');
ensureColumn('users', 'tag_color', "tag_color TEXT NOT NULL DEFAULT '#5b8cff'");
ensureColumn('users', 'tag_icon', "tag_icon TEXT NOT NULL DEFAULT ''");

module.exports = { db, DATA_DIR, UPLOADS_DIR, AVATARS_DIR, BANNERS_DIR, ATTACH_DIR, DB_PATH };
