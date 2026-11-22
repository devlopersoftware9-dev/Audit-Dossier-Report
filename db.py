"""
Database connection — works with two databases using the same SQL:

  * SQLite  (default)                 -> file data/audit.db   (office PC / local)
  * PostgreSQL (env DATABASE_URL)     -> e.g. a free Neon database for the live website

SQL in the app is written once, in a form both accept:
  ? placeholders, "user"/"date"/"timestamp" quoted, LOWER() for case-insensitive compares,
  INSERT ... ON CONFLICT DO NOTHING / DO UPDATE, and RETURNING id.
"""
import os
import sqlite3

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get('AUDIT_DB', os.path.join(BASE_DIR, 'data', 'audit.db'))
DATABASE_URL = os.environ.get('DATABASE_URL', '').strip()
IS_PG = DATABASE_URL.startswith(('postgres://', 'postgresql://'))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id {ID},
  username TEXT NOT NULL {NOCASE},
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Officer',
  salary REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT, last_login TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_name ON users (LOWER(username));
CREATE TABLE IF NOT EXISTS tasks (
  id {ID},
  depart TEXT NOT NULL,
  checklist TEXT NOT NULL,
  checklist_url TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  task TEXT NOT NULL,
  "user" TEXT NOT NULL {NOCASE},
  audit_type TEXT DEFAULT '',
  recurrence TEXT NOT NULL,
  target TEXT NOT NULL,
  target_month TEXT DEFAULT '',
  company TEXT NOT NULL,
  branch TEXT NOT NULL,
  start_time TEXT DEFAULT '', end_time TEXT DEFAULT '',
  sop_name TEXT DEFAULT '', sop_url TEXT DEFAULT '',
  remarks TEXT DEFAULT '', ordered_by TEXT DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_by TEXT, created_at TEXT, updated_by TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS records (
  id {ID},
  rkey TEXT NOT NULL UNIQUE,
  "date" TEXT NOT NULL,
  "user" TEXT NOT NULL {NOCASE},
  company TEXT, branch TEXT, department TEXT, checklist TEXT, todo TEXT, task_type TEXT,
  status INTEGER NOT NULL,
  remarks TEXT DEFAULT '',
  source TEXT DEFAULT 'Portal',
  "timestamp" TEXT
);
CREATE INDEX IF NOT EXISTS ix_records_date ON records("date");
CREATE INDEX IF NOT EXISTS ix_records_user ON records(LOWER("user"), "date");
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS monthly_snapshots (
  month TEXT, "user" TEXT, total INTEGER, done INTEGER, missed INTEGER, pct REAL, grade TEXT,
  task_fine REAL, pct_fine REAL, total_fine REAL, salary REAL, generated_at TEXT,
  PRIMARY KEY (month, "user")
);
CREATE TABLE IF NOT EXISTS audit_log (id {ID}, ts TEXT, "user" TEXT, action TEXT, detail TEXT);
"""


def schema():
    if IS_PG:
        return _SCHEMA.format(ID='SERIAL PRIMARY KEY', NOCASE='')
    return _SCHEMA.format(ID='INTEGER PRIMARY KEY AUTOINCREMENT', NOCASE='COLLATE NOCASE')


# ------------------------------------------------------------------ PostgreSQL wrapper
class Row(dict):
    """Row usable as r['col'] and r[0] (like sqlite3.Row)."""
    __slots__ = ('_vals',)

    def __init__(self, cols, vals):
        super().__init__(zip(cols, vals))
        self._vals = list(vals)

    def __getitem__(self, k):
        return self._vals[k] if isinstance(k, int) else dict.__getitem__(self, k)


def _pg_value(v):
    # SUM()/ROUND() come back as Decimal in Postgres — use int/float like SQLite does
    try:
        from decimal import Decimal
        if isinstance(v, Decimal):
            return int(v) if v == v.to_integral_value() else float(v)
    except Exception:  # noqa: BLE001
        pass
    return v


class PgCursor:
    def __init__(self, cur):
        self.cur = cur
        self.rowcount = cur.rowcount
        self.cols = [d[0] for d in cur.description] if cur.description else []

    def _row(self, r):
        return None if r is None else Row(self.cols, [_pg_value(v) for v in r])

    def fetchone(self):
        return self._row(self.cur.fetchone()) if self.cols else None

    def fetchall(self):
        return [self._row(r) for r in self.cur.fetchall()] if self.cols else []

    def __iter__(self):
        return iter(self.fetchall())


class PgConnection:
    def __init__(self, url, driver=None):
        if driver is None:
            import psycopg as driver   # pip install "psycopg[binary]"
        if url.startswith('postgres://'):
            url = 'postgresql://' + url[len('postgres://'):]
        self.con = driver.connect(url)

    @staticmethod
    def _sql(sql):
        return sql.replace('%', '%%').replace('?', '%s')

    def execute(self, sql, params=()):
        cur = self.con.cursor()
        if params:
            cur.execute(self._sql(sql), tuple(params))
        else:
            cur.execute(sql)
        return PgCursor(cur)

    def executemany(self, sql, seq):
        cur = self.con.cursor()
        cur.executemany(self._sql(sql), [tuple(p) for p in seq])
        return PgCursor(cur)

    def executescript(self, script):
        for stmt in script.split(';'):
            if stmt.strip():
                self.con.cursor().execute(stmt)
        self.con.commit()

    def commit(self):
        self.con.commit()

    def rollback(self):
        self.con.rollback()

    def close(self):
        try:
            self.con.rollback()
        finally:
            self.con.close()


PG_DRIVER = None   # tests can inject a driver module here


def connect():
    if IS_PG:
        return PgConnection(DATABASE_URL, PG_DRIVER)
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA journal_mode = WAL')
    return con
