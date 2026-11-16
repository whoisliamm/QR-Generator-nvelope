-- State percakapan per pengguna (pengganti dictionary user_mode / user_urls / user_filenames di bot.py)
CREATE TABLE IF NOT EXISTS sessions (
  user_id    INTEGER PRIMARY KEY,
  mode       TEXT,
  url        TEXT,
  updated_at INTEGER NOT NULL
);

-- Job QR yang siap dirender oleh Mini App (dibuka dari tombol ukuran di chat)
CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,        -- 'single' | 'batch'
  urls       TEXT NOT NULL,        -- JSON array
  filename   TEXT,                 -- hanya untuk single
  created_at INTEGER NOT NULL,
  used_at    INTEGER               -- terakhir benar-benar dibuat & dikirim (untuk riwayat)
);

-- Anggota tim yang boleh memakai bot (admin diatur lewat secret ADMIN_USER_IDS)
CREATE TABLE IF NOT EXISTS allowed_users (
  user_id    INTEGER PRIMARY KEY,
  note       TEXT,
  added_by   INTEGER NOT NULL,
  added_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_created_at ON jobs (created_at);
CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions (updated_at);
