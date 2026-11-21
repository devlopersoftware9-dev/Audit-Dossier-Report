"""
Test-only stand-in for psycopg that runs SQL through the `psql` command line.
Lets the test suite check every SQL statement against a real PostgreSQL server
where the psycopg package cannot be installed.  Not used in production.
"""
import csv
import io
import subprocess

NUMERIC = {'id', 'salary', 'active', 'hidden', 'sort_order', 'status', 'total', 'done', 'missed', 'pct', 'task_fine',
           'pct_fine', 'total_fine', 'n', 'count', 'coalesce', '?column?'}


def _lit(v):
    if v is None:
        return 'NULL'
    if isinstance(v, bool):
        return '1' if v else '0'
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def _bind(sql, params):
    if params is None:
        return sql
    out, i, it = [], 0, iter(params)
    while i < len(sql):
        if sql.startswith('%%', i):
            out.append('%'); i += 2
        elif sql.startswith('%s', i):
            out.append(_lit(next(it))); i += 2
        else:
            out.append(sql[i]); i += 1
    return ''.join(out)


def _conv(col, v):
    if col in ('g', 'max') and v == '':
        return None
    if col in NUMERIC:
        if v == '':
            return None
        try:
            return int(v)
        except ValueError:
            return float(v)
    return v


class Cursor:
    def __init__(self, dsn):
        self.dsn, self.description, self.rows, self.rowcount = dsn, None, [], -1

    def _run(self, sql):
        p = subprocess.run(['psql', self.dsn, '-X', '-q', '--csv', '-v', 'ON_ERROR_STOP=1', '-c', sql],
                           capture_output=True, text=True)
        if p.returncode:
            raise RuntimeError(f'Postgres error: {p.stderr.strip()}\nSQL: {sql[:500]}')
        data = list(csv.reader(io.StringIO(p.stdout)))
        if data:
            cols = data[0]
            self.description = [(c,) for c in cols]
            self.rows = [tuple(_conv(c, v) for c, v in zip(cols, r or [''] * len(cols))) for r in data[1:]]
        else:
            self.description, self.rows = None, []

    def execute(self, sql, params=None):
        self._run(_bind(sql, params))

    def executemany(self, sql, seq):
        stmts = [_bind(sql, p) for p in seq]
        for i in range(0, len(stmts), 200):
            self._run(';\n'.join(stmts[i:i + 200]))
        self.description = None

    def fetchone(self):
        return self.rows.pop(0) if self.rows else None

    def fetchall(self):
        r, self.rows = self.rows, []
        return r


class Connection:
    def __init__(self, dsn):
        self.dsn = dsn

    def cursor(self):
        return Cursor(self.dsn)

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


def connect(dsn):
    return Connection(dsn)
