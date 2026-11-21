"""
Database (SQLite) + business logic for the Audit Dossier system.
Each task (check list) belongs to ONE user. The user marks it TRUE / FALSE once per day.
"""
import hashlib
import os
from datetime import date, datetime, timedelta, timezone

from werkzeug.security import check_password_hash, generate_password_hash

from schedule import BUCKET_ORDER, bucket, is_scheduled, norm

from db import DB_PATH, IS_PG, connect, schema  # noqa: F401  (re-exported)

DEFAULT_SETTINGS = [
    ('APP_TITLE', 'Audit Dossier Portal', 'Portal title'),
    ('FINE_MODE', 'BOTH', 'NONE / PER_TASK / PERCENT / BOTH'),
    ('FINE_PER_TASK', '100', 'Rs fine for every task left FALSE'),
    ('FINE_PCT_SLABS', '95:0,85:2,75:5,60:10,0:15', 'Efficiency >= X% -> cut Y% of monthly salary (X:Y)'),
    ('GRADE_SLABS', '95:A+,85:A,75:B,60:C,0:D', 'Efficiency >= X% -> grade'),
    ('DEPT_FINES', '', 'Optional per-department fine, e.g. Accounts:200,IT:50'),
    ('WEEKLY_OFF', 'Fri', 'Off day (no tasks)'),
    ('WORK_ON_OFF_DAY_COMPANIES', 'RCG', 'Companies that still work on the off day (comma separated)'),
    ('HIDE_BRANCH_TABS', 'RC', 'Branches without their own "Branch:" tab (comma separated)'),
    ('UTC_OFFSET_HOURS', '5', 'Time zone (Pakistan = 5)'),
    ('AUTO_CLOSE_LAST_DATE', '', 'System: last day whose unmarked tasks were saved as FALSE'),
]


def init_db(con):
    con.executescript(schema())
    for k, v, n in DEFAULT_SETTINGS:
        con.execute('INSERT INTO settings(key, value, note) VALUES (?,?,?) ON CONFLICT DO NOTHING', (k, v, n))
    if not con.execute("SELECT 1 FROM users WHERE role='Admin'").fetchone():
        con.execute('INSERT INTO users(username, password_hash, role, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
                    ('admin', generate_password_hash(os.environ.get('ADMIN_PASSWORD') or 'admin123'), 'Admin', now_text(con)))
    con.commit()


# ---------------------------------------------------------------- settings / time
_SETTINGS_CACHE = {'at': 0.0, 'val': None}


def settings(con):
    # cached for a few seconds: settings are read many times per page (time zone, fines ...)
    import time
    if _SETTINGS_CACHE['val'] is None or time.monotonic() - _SETTINGS_CACHE['at'] > 5:
        _SETTINGS_CACHE['val'] = {r['key']: r['value'] or '' for r in con.execute('SELECT key, value FROM settings')}
        _SETTINGS_CACHE['at'] = time.monotonic()
    return dict(_SETTINGS_CACHE['val'])


def set_setting(con, key, value):
    _SETTINGS_CACHE['val'] = None
    con.execute("INSERT INTO settings(key, value, note) VALUES (?,?,'') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, str(value)))


def tz(con=None):
    try:
        h = float(settings(con)['UTC_OFFSET_HOURS']) if con else 5
    except (KeyError, ValueError):
        h = 5
    return timezone(timedelta(hours=h))


def now(con=None):
    if os.environ.get('AUDIT_FAKE_NOW'):                     # used by tests only
        return datetime.fromisoformat(os.environ['AUDIT_FAKE_NOW'])
    return datetime.now(tz(con)).replace(tzinfo=None)


def today(con=None):
    return now(con).date()


def now_text(con=None):
    return now(con).strftime('%Y-%m-%d %H:%M:%S')


def setting_list(s, key):
    return [x.strip() for x in str(s.get(key, '')).split(',') if x.strip()]


def sched_opts(s):
    return dict(off_day=(s.get('WEEKLY_OFF') or 'Fri').strip(),
                work_on_off_day=setting_list(s, 'WORK_ON_OFF_DAY_COMPANIES'))


def parse_slabs(text):
    out = []
    for p in str(text or '').split(','):
        if ':' in p:
            a, b = p.split(':', 1)
            try:
                out.append((float(a), b.strip()))
            except ValueError:
                pass
    return sorted(out, key=lambda x: -x[0])


def slab_for(slabs, pct):
    for m, v in slabs:
        if pct >= m:
            return v
    return slabs[-1][1] if slabs else ''


def log(con, user, action, detail=''):
    con.execute('INSERT INTO audit_log(ts, "user", action, detail) VALUES (?,?,?,?)', (now_text(con), user, action, str(detail)[:2000]))


# ---------------------------------------------------------------- users
def authenticate(con, username, password):
    u = con.execute('SELECT * FROM users WHERE LOWER(username)=LOWER(?) AND active=1', (username.strip(),)).fetchone()
    if u and check_password_hash(u['password_hash'], password):
        con.execute('UPDATE users SET last_login=? WHERE id=?', (now_text(con), u['id']))
        con.commit()
        return u
    return None


def user_names(con, active_only=True):
    q = 'SELECT username FROM users' + (' WHERE active=1' if active_only else '') + ' ORDER BY username'
    return [r['username'] for r in con.execute(q)]


# ---------------------------------------------------------------- tasks & groups
def group_key(t):
    raw = '|'.join(norm(t[k]) for k in ('company', 'branch', 'depart', 'checklist', 'task', 'recurrence', 'target', 'user'))
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def load_groups(con, include_hidden=False):
    """Check-list groups: rows with same company/branch/dept/checklist/task/recurrence/target/user = one portal line."""
    rows = con.execute('SELECT * FROM tasks ' + ('' if include_hidden else 'WHERE hidden=0 ') + 'ORDER BY sort_order, id').fetchall()
    groups, order = {}, []
    for r in rows:
        t = dict(r)
        k = group_key(t)
        g = groups.get(k)
        if not g:
            g = groups[k] = dict(key=k, company=t['company'], branch=t['branch'], depart=t['depart'],
                                 checklist=t['checklist'], checklist_url=t['checklist_url'] or '', task=t['task'],
                                 user=t['user'], recurrence=t['recurrence'], target=t['target'],
                                 target_month=t['target_month'], audit_type=t['audit_type'], bucket=bucket(t),
                                 sop_name=t['sop_name'] or '', sop_url=t['sop_url'] or '',
                                 start_time=t['start_time'], end_time=t['end_time'], details=[], ids=[],
                                 since=(t['created_at'] or '')[:10])
            order.append(k)
        if t['detail']:
            g['details'].append(t['detail'])
        g['ids'].append(t['id'])
        c = (t['created_at'] or '')[:10]
        g['since'] = '' if not c or not g['since'] else min(g['since'], c)   # '' = no start limit (imported)
        if not g['sop_url'] and t['sop_url']:
            g['sop_url'] = t['sop_url']
        if not g['sop_name'] and t['sop_name']:
            g['sop_name'] = t['sop_name']
        if not g['checklist_url'] and t['checklist_url']:
            g['checklist_url'] = t['checklist_url']
    return [groups[k] for k in order]


def sort_groups(lst):
    return sorted(lst, key=lambda g: BUCKET_ORDER.get(g['bucket'], 9))


def record_key(d, user, branch, dept, checklist, task_type):
    return '|'.join(norm(x) for x in (str(d), user, branch, dept, checklist, task_type))


def records_for_day(con, d):
    return {r['rkey']: r for r in con.execute('SELECT * FROM records WHERE "date"=?', (str(d),))}


def attach_status(g, recs, d):
    r = recs.get(record_key(d, g['user'], g['branch'], g['depart'], g['checklist'], g['task']))
    g['status'] = None if r is None else bool(r['status'])
    g['remarks'] = r['remarks'] if r else ''
    g['marked_at'] = r['timestamp'] if r else ''
    return g


def today_tasks(con, user=None, d=None):
    """Tasks due on day d (Today's Task). user=None -> every user (admin view)."""
    s = settings(con)
    d = d or today(con)
    opts = sched_opts(s)
    recs = records_for_day(con, d)
    out = [attach_status(g, recs, d) for g in load_groups(con)
           if is_scheduled(g, d, **opts) and (user is None or norm(g['user']) == norm(user))]
    return sort_groups(out)


def category_tasks(con, kind, value, user=None):
    """All tasks of one department / branch — column-B (today) does not matter here."""
    s = settings(con)
    d = today(con)
    opts = sched_opts(s)
    recs = records_for_day(con, d)
    out = []
    for g in load_groups(con):
        if norm(g['branch' if kind == 'branch' else 'depart']) != norm(value):
            continue
        if user is not None and norm(g['user']) != norm(user):
            continue
        g['due_today'] = is_scheduled(g, d, **opts)
        out.append(attach_status(g, recs, d))
    return sort_groups(out)


def tabs(con, user=None):
    s = settings(con)
    hide = [norm(x) for x in setting_list(s, 'HIDE_BRANCH_TABS')]
    groups = [g for g in load_groups(con) if user is None or norm(g['user']) == norm(user)]
    depts = sorted({g['depart'] for g in groups if g['depart']})
    branches = sorted({g['branch'] for g in groups if g['branch'] and norm(g['branch']) not in hide})
    return depts, branches


def stats(rows):
    done = sum(1 for r in rows if r.get('status') is True)
    total = len(rows)
    return dict(total=total, done=done, pending=total - done, pct=round(done * 100 / total) if total else 0)


# ---------------------------------------------------------------- marking
def mark(con, key, user, status, remarks, by_user, by_admin):
    g = next((x for x in load_groups(con) if x['key'] == key), None)
    if not g:
        raise ValueError('Task not found — it may have been edited or hidden. Refresh the page.')
    if not by_admin and norm(g['user']) != norm(by_user):
        raise ValueError('This task is not assigned to you.')
    d = today(con)
    s = settings(con)
    due = is_scheduled(g, d, **sched_opts(s))
    source = 'Admin' if by_admin and norm(by_user) != norm(g['user']) else ('Portal' if due else 'Extra')
    rk = record_key(d, g['user'], g['branch'], g['depart'], g['checklist'], g['task'])
    ts = now_text(con)
    con.execute("""INSERT INTO records(rkey, "date", "user", company, branch, department, checklist, todo, task_type,
                       status, remarks, source, "timestamp") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(rkey) DO UPDATE SET status=excluded.status, remarks=excluded.remarks,
                       source=excluded.source, "timestamp"=excluded."timestamp\"""",
                (rk, str(d), g['user'], g['company'], g['branch'], g['depart'], g['checklist'],
                 ', '.join(g['details']), g['task'], 1 if status else 0, (remarks or '')[:1000], source, ts))
    con.commit()
    return dict(status=bool(status), remarks=remarks or '', marked_at=ts, source=source)


# ---------------------------------------------------------------- auto-close (missed = FALSE)
def close_day(con, d):
    """Save FALSE for every task due on day d that has no record. Safe to run again."""
    s = settings(con)
    opts = sched_opts(s)
    active = {norm(u) for u in user_names(con)}
    recs = records_for_day(con, d)
    ts = now_text(con)
    n = 0
    for g in load_groups(con):
        if not is_scheduled(g, d, **opts) or norm(g['user']) not in active:
            continue
        if g['since'] and g['since'] > d.isoformat():      # task did not exist yet on that day
            continue
        rk = record_key(d, g['user'], g['branch'], g['depart'], g['checklist'], g['task'])
        if rk in recs:
            continue
        con.execute("""INSERT INTO records(rkey, "date", "user", company, branch, department, checklist, todo,
                       task_type, status, remarks, source, "timestamp") VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)
                       ON CONFLICT DO NOTHING""",
                    (rk, str(d), g['user'], g['company'], g['branch'], g['depart'], g['checklist'],
                     ', '.join(g['details']), g['task'], 'Not marked (auto-closed)', 'Auto-Closed', ts))
        recs[rk] = True
        n += 1
    con.commit()
    return n


def auto_close(con):
    """Close every day from the last closed day up to yesterday (runs automatically on page visits)."""
    s = settings(con)
    yesterday = today(con) - timedelta(days=1)
    try:
        last = date.fromisoformat(s.get('AUTO_CLOSE_LAST_DATE') or '')
    except ValueError:
        last = yesterday - timedelta(days=1)
    d, total, guard = last + timedelta(days=1), 0, 0
    while d <= yesterday and guard < 92:
        total += close_day(con, d)
        set_setting(con, 'AUTO_CLOSE_LAST_DATE', d.isoformat())
        con.commit()
        d += timedelta(days=1)
        guard += 1
    return total


# ---------------------------------------------------------------- reports
def _where(f, user_lock=None):
    w, p = ['"date" BETWEEN ? AND ?'], [f['start'], f['end']]
    user = user_lock or f.get('user')
    if user:
        w.append('LOWER("user") = LOWER(?)'); p.append(user)
    st = (f.get('status') or 'ALL').upper()
    if st in ('TRUE', 'FALSE'):
        w.append('status = ?'); p.append(1 if st == 'TRUE' else 0)
    for col, k in (('department', 'department'), ('branch', 'branch'), ('task_type', 'task_type'), ('source', 'source')):
        if f.get(k):
            w.append(f'LOWER({col}) = LOWER(?)'); p.append(f[k])
    if f.get('checklist'):
        w.append('LOWER(checklist) LIKE LOWER(?)'); p.append('%' + f['checklist'] + '%')
    return ' AND '.join(w), p


def detail_report(con, f, user_lock=None):
    w, p = _where(f, user_lock)
    rows = [dict(r) for r in con.execute(f'SELECT * FROM records WHERE {w} ORDER BY "date" DESC, "user", department, checklist', p)]
    t = sum(r['status'] for r in rows)
    return dict(rows=rows, count=len(rows), true=t, false=len(rows) - t)


def _fine_ctx(con):
    s = settings(con)
    mode = (s.get('FINE_MODE') or 'BOTH').upper()
    dept = {}
    for part in str(s.get('DEPT_FINES') or '').split(','):
        if ':' in part:
            a, b = part.rsplit(':', 1)
            try:
                dept[norm(a)] = float(b)
            except ValueError:
                pass
    try:
        per = float(s.get('FINE_PER_TASK') or 0)
    except ValueError:
        per = 0
    return dict(mode=mode, per_task_on=mode in ('PER_TASK', 'BOTH'), pct_on=mode in ('PERCENT', 'BOTH'),
                per=per, dept=dept, slabs=parse_slabs(s.get('FINE_PCT_SLABS')), grades=parse_slabs(s.get('GRADE_SLABS')))


GROUP_COLS = {'user': '"user"', 'department': 'department', 'checklist': "department || ' › ' || checklist",
              'branch': 'branch', 'task_type': 'task_type', 'date': 'date'}


def efficiency(con, f, user_lock=None):
    by = f.get('group_by') if f.get('group_by') in GROUP_COLS else 'user'
    w, p = _where(dict(f, status='ALL'), user_lock)
    w += " AND COALESCE(source,'') <> 'Extra'"
    fc = _fine_ctx(con)
    salaries = {norm(r['username']): r['salary'] for r in con.execute('SELECT username, salary FROM users')}
    agg = {}
    for r in con.execute(f'SELECT {GROUP_COLS[by]} AS k, department, COUNT(*) AS total, SUM(status) AS done '
                         f'FROM records WHERE {w} GROUP BY k, department', p):
        g = agg.setdefault(r['k'] or '(blank)', dict(key=r['k'] or '(blank)', total=0, done=0, missed=0, task_fine=0.0))
        missed = r['total'] - r['done']
        g['total'] += r['total']; g['done'] += r['done']; g['missed'] += missed
        if fc['per_task_on']:
            g['task_fine'] += missed * fc['dept'].get(norm(r['department']), fc['per'])
    rows = []
    for g in agg.values():
        g['pct'] = round(g['done'] * 100 / g['total'], 1) if g['total'] else 0
        g['grade'] = slab_for(fc['grades'], g['pct'])
        g['salary'] = salaries.get(norm(g['key']), 0) if by == 'user' else 0
        g['deduct_pct'] = float(slab_for(fc['slabs'], g['pct']) or 0) if (fc['pct_on'] and by == 'user') else 0
        g['pct_fine'] = round(g['salary'] * g['deduct_pct'] / 100)
        g['total_fine'] = round(g['task_fine'] + g['pct_fine'])
        rows.append(g)
    rows.sort(key=(lambda g: g['key']) if by == 'date' else (lambda g: (g['pct'], -g['missed'])))
    tot = dict(total=sum(g['total'] for g in rows), done=sum(g['done'] for g in rows),
               missed=sum(g['missed'] for g in rows), total_fine=sum(g['total_fine'] for g in rows))
    tot['pct'] = round(tot['done'] * 100 / tot['total'], 1) if tot['total'] else 0
    return dict(rows=rows, totals=tot, group_by=by, mode=fc['mode'], show_pct=fc['pct_on'] and by == 'user')


def month_bounds(ym):
    y, m = int(ym[:4]), int(ym[5:7])
    start = date(y, m, 1)
    end = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1))
    return start.isoformat(), end.isoformat()


def monthly(con, ym, user=None):
    start, end = month_bounds(ym)
    eff = efficiency(con, dict(start=start, end=end, user=user, group_by='user'))
    out = []
    for u in sorted(eff['rows'], key=lambda g: -g['pct']):
        p = [start, end, u['key']]
        u['departments'] = [dict(r) for r in con.execute(
            "SELECT department, COUNT(*) total, SUM(status) done, COUNT(*)-SUM(status) missed, "
            "ROUND(SUM(status)*100.0/COUNT(*),1) pct FROM records WHERE \"date\" BETWEEN ? AND ? AND LOWER(\"user\")=LOWER(?) "
            "AND COALESCE(source,'')<>'Extra' GROUP BY department ORDER BY pct", p)]
        u['missed_list'] = [dict(r) for r in con.execute(
            'SELECT "date", department, checklist, task_type, remarks FROM records WHERE "date" BETWEEN ? AND ? '
            "AND LOWER(\"user\")=LOWER(?) AND status=0 AND COALESCE(source,'')<>'Extra' ORDER BY \"date\"", p)]
        out.append(u)
    snap = con.execute('SELECT MAX(generated_at) g FROM monthly_snapshots WHERE month=?', (ym,)).fetchone()['g']
    return dict(month=ym, rows=out, mode=eff['mode'], saved_on=snap or '')


def save_monthly(con, ym):
    data = monthly(con, ym)
    con.execute('DELETE FROM monthly_snapshots WHERE month=?', (ym,))
    ts = now_text(con)
    for u in data['rows']:
        con.execute('INSERT INTO monthly_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                    (ym, u['key'], u['total'], u['done'], u['missed'], u['pct'], u['grade'], u['task_fine'],
                     u['pct_fine'], u['total_fine'], u['salary'], ts))
    con.commit()
    return len(data['rows'])


def auto_monthly(con):
    """On/after the 1st, save last month's snapshot once."""
    t = today(con)
    prev = (date(t.year, t.month, 1) - timedelta(days=1)).strftime('%Y-%m')
    if not con.execute('SELECT 1 FROM monthly_snapshots WHERE month=?', (prev,)).fetchone():
        if con.execute('SELECT 1 FROM records WHERE substr("date",1,7)=?', (prev,)).fetchone():
            save_monthly(con, prev)


def dashboard(con, user=None):
    t = today(con)
    st = stats(today_tasks(con, user))
    start = t.replace(day=1)
    mtd = dict(total=0, pct=0, total_fine=0)
    if t > start:
        mtd = efficiency(con, dict(start=start.isoformat(), end=(t - timedelta(days=1)).isoformat(),
                                   user=user, group_by='user'))['totals']
    return dict(today=st, mtd=mtd)


# ---------------------------------------------------------------- task admin
TASK_FIELDS = ['depart', 'checklist', 'checklist_url', 'detail', 'task', 'user', 'audit_type', 'recurrence', 'target',
               'target_month', 'company', 'branch', 'start_time', 'end_time', 'sop_name', 'sop_url', 'remarks', 'ordered_by']
REQUIRED = {'depart': 'Department', 'checklist': 'Check List', 'task': 'Task', 'user': 'User',
            'recurrence': 'Recurrence', 'target': 'Target Day / Date', 'company': 'Company', 'branch': 'Branch'}


def clean_task(form):
    t = {k: (form.get(k) or '').strip() for k in TASK_FIELDS}
    for k, label in REQUIRED.items():
        if not t[k]:
            raise ValueError(f'{label} is required.')
    if t['target'].isdigit() and not 1 <= int(t['target']) <= 31:
        raise ValueError('Target date must be 1 – 31.')
    if norm(t['recurrence']) in ('quarterly', 'twice a year', 'yearly') and t['target'].isdigit() and not t['target_month']:
        raise ValueError('Quarterly / Yearly tasks need a Target Month (1 – 12).')
    for k in ('sop_url', 'checklist_url'):
        if t[k] and not t[k].lower().startswith(('http://', 'https://')):
            t[k] = 'https://' + t[k]
    t['hidden'] = 1 if form.get('hidden') in ('1', 'on', 'true', True) else 0
    return t


def save_task(con, form, by, task_id=None):
    t = clean_task(form)
    ts = now_text(con)
    if task_id:
        sets = ', '.join(f'"{k}"=?' for k in TASK_FIELDS)
        con.execute(f'UPDATE tasks SET {sets}, hidden=?, updated_by=?, updated_at=? WHERE id=?',
                    [t[k] for k in TASK_FIELDS] + [t['hidden'], by, ts, task_id])
        log(con, by, 'EDIT_TASK', f'{task_id} {t["checklist"]}')
    else:
        order = con.execute('SELECT COALESCE(MAX(sort_order),0)+1 FROM tasks').fetchone()[0]
        cols = TASK_FIELDS + ['hidden', 'sort_order', 'created_by', 'created_at', 'updated_by', 'updated_at']
        task_id = con.execute(f'INSERT INTO tasks({",".join(chr(34) + c + chr(34) for c in cols)}) '
                              f'VALUES ({",".join("?" * len(cols))}) RETURNING id',
                              [t[k] for k in TASK_FIELDS] + [t['hidden'], order, by, ts, by, ts]).fetchone()[0]
        log(con, by, 'ADD_TASK', f'{task_id} {t["checklist"]}')
    con.commit()
    return task_id


def listings(con):
    def col(c):
        q = f'"{c}"'
        return [r[0] for r in con.execute(f"SELECT DISTINCT {q} FROM tasks WHERE COALESCE({q},'') <> '' ORDER BY {q}")]
    return dict(depart=col('depart'), checklist=col('checklist'), task=col('task'), audit_type=col('audit_type'),
                company=col('company'), branch=col('branch'),
                user=sorted(set(col('user')) | set(user_names(con)), key=str.lower),
                recurrence=sorted(set(col('recurrence')) | {'Daily', 'Weekly', 'Fornightly', 'Monthly', 'Quarterly',
                                                             'Twice a Year', 'Yearly', 'Trigger'}),
                target=['Daily', 'Triggered', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'] + [str(i) for i in range(1, 32)])
