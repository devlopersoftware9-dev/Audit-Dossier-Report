"""
Audit Dossier Portal — Flask web app.

    pip install -r requirements.txt
    python app.py                      ->  http://localhost:5000   (other PCs: http://<this-PC-IP>:5000)
"""
import io
import os
import secrets
import tempfile
from datetime import date, timedelta
from functools import wraps

from flask import (Flask, abort, flash, g, jsonify, redirect, render_template, request, send_file, session,
                   url_for)
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from werkzeug.security import generate_password_hash

import core
from schedule import norm

app = Flask(__name__)


def _secret():
    p = os.path.join(os.path.dirname(core.DB_PATH), 'secret.key')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if not os.path.exists(p):
        with open(p, 'w') as f:
            f.write(secrets.token_hex(32))
    return open(p).read().strip()


app.secret_key = _secret()
app.config.update(PERMANENT_SESSION_LIFETIME=timedelta(hours=12), MAX_CONTENT_LENGTH=30 * 1024 * 1024)
_LAST_JOBS = {'day': None}


# ------------------------------------------------------------------ request lifecycle
def db():
    if 'con' not in g:
        g.con = core.connect()
    return g.con


@app.teardown_appcontext
def _close(_):
    con = g.pop('con', None)
    if con:
        con.close()


@app.before_request
def _daily_jobs():
    """Once a day (first visit): save FALSE for yesterday's unmarked tasks, and last month's snapshot."""
    con = db()
    t = core.today(con)
    if _LAST_JOBS['day'] != t:
        core.auto_close(con)
        core.auto_monthly(con)
        _LAST_JOBS['day'] = t


@app.context_processor
def _ctx():
    s = core.settings(db())
    return dict(app_title=s.get('APP_TITLE') or 'Audit Dossier Portal', me=session.get('user'),
                is_admin=session.get('role') == 'Admin', today=core.today(db()))


def login_required(fn):
    @wraps(fn)
    def w(*a, **k):
        if not session.get('user'):
            if request.path.startswith('/api/'):
                return jsonify(error='Session expired — please login again.'), 401
            return redirect(url_for('login', next=request.full_path))
        if session.get('must_change') and request.endpoint not in ('password', 'logout', 'static'):
            if request.path.startswith('/api/'):
                return jsonify(error='Please change your default password first.'), 403
            return redirect(url_for('password'))
        return fn(*a, **k)
    return w


def admin_required(fn):
    @wraps(fn)
    @login_required
    def w(*a, **k):
        if session.get('role') != 'Admin':
            abort(403)
        return fn(*a, **k)
    return w


def view_user():
    """Officer: always himself. Admin: ?user= (blank = everybody)."""
    if session.get('role') == 'Admin':
        return request.values.get('user') or None
    return session['user']


def xlsx(name, headers, rows):
    wb = Workbook()
    ws = wb.active
    ws.title = 'Report'
    ws.append(headers)
    for c in ws[1]:
        c.font = Font(bold=True, color='FFFFFF')
        c.fill = PatternFill('solid', fgColor='212529')
    for r in rows:
        ws.append(list(r))
    for i, h in enumerate(headers, 1):
        width = max([len(str(h))] + [len(str(r[i - 1] or '')) for r in rows[:500]])
        ws.column_dimensions[ws.cell(1, i).column_letter].width = min(60, width + 2)
    ws.freeze_panes = 'A2'
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return send_file(buf, as_attachment=True, download_name=f'{name}.xlsx',
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


def report_filters():
    t = core.today(db()).isoformat()
    a = request.args
    return dict(start=a.get('start') or t, end=a.get('end') or t, status=a.get('status') or 'ALL',
                user=a.get('user') or '', department=a.get('department') or '', branch=a.get('branch') or '',
                task_type=a.get('task_type') or '', checklist=(a.get('checklist') or '').strip(),
                source=a.get('source') or '', group_by=a.get('group_by') or 'user')


def filter_options():
    con = db()
    me = None if session.get('role') == 'Admin' else session['user']
    q = 'SELECT DISTINCT {c} FROM tasks' + (' WHERE user=? COLLATE NOCASE' if me else '') + ' ORDER BY {c}'
    col = lambda c: [r[0] for r in con.execute(q.format(c=c), (me,) if me else ()) if r[0]]
    return dict(users=core.user_names(con, False) if not me else [me], departments=col('depart'),
                branches=col('branch'), task_types=col('task'))


# ------------------------------------------------------------------ auth
@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        u = core.authenticate(db(), request.form.get('username', ''), request.form.get('password', ''))
        if u:
            session.clear()
            session.permanent = True
            session.update(user=u['username'], role=u['role'])
            if request.form.get('password') in ('admin123', '1234'):
                session['must_change'] = True
                flash('You are using the default password — please set your own password now.', 'warning')
                return redirect(url_for('password'))
            nxt = request.args.get('next') or ''
            return redirect(nxt if nxt.startswith('/') and not nxt.startswith('//') else url_for('tasks'))
        flash('Invalid username or password.', 'danger')
    return render_template('login.html')


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


@app.route('/password', methods=['GET', 'POST'])
@login_required
def password():
    if request.method == 'POST':
        con = db()
        if not core.authenticate(con, session['user'], request.form.get('old', '')):
            flash('Old password is wrong.', 'danger')
        elif len(request.form.get('new', '')) < 6:
            flash('New password must be at least 6 characters.', 'danger')
        elif request.form.get('new') in ('admin123', '1234', '123456'):
            flash('Choose a stronger password.', 'danger')
        else:
            con.execute('UPDATE users SET password_hash=? WHERE username=?',
                        (generate_password_hash(request.form['new']), session['user']))
            con.commit()
            session.pop('must_change', None)
            flash('Password changed.', 'success')
            return redirect(url_for('tasks'))
    return render_template('password.html')


# ------------------------------------------------------------------ tasks portal
@app.route('/')
@login_required
def home():
    return redirect(url_for('tasks'))


def _tab_rows():
    con = db()
    tab, val, user = request.args.get('tab', 'today'), request.args.get('v', ''), view_user()
    if tab in ('dept', 'branch') and val:
        return tab, val, user, core.category_tasks(con, tab, val, user)
    return 'today', '', user, core.today_tasks(con, user)


@app.route('/tasks')
@login_required
def tasks():
    con = db()
    tab, val, user, rows = _tab_rows()
    depts, branches = core.tabs(con, None if session['role'] == 'Admin' else session['user'])
    return render_template('tasks.html', tab=tab, val=val, rows=rows, depts=depts, branches=branches,
                           view_as=user or '', officers=core.user_names(con), dash=core.dashboard(con, user))


@app.route('/tasks.xlsx')
@login_required
def tasks_xlsx():
    tab, val, _, rows = _tab_rows()
    name = 'Todays_Task_' + core.today(db()).isoformat() if tab == 'today' else f'{val}_Tasks'
    return xlsx(name, ['Group', 'Company', 'Branch', 'Department', 'Check List', 'Details', 'Task', 'Recurrence',
                       'Target Day / Date', 'SOP', 'SOP Link', 'User', 'Status', 'Remarks'],
                [[r['bucket'], r['company'], r['branch'], r['depart'], r['checklist'],
                  '\n'.join(f'{i}. {d}' for i, d in enumerate(r['details'], 1)), r['task'], r['recurrence'], r['target'],
                  r['sop_name'], r['sop_url'], r['user'],
                  '' if r['status'] is None else ('TRUE' if r['status'] else 'FALSE'), r['remarks']] for r in rows])


@app.route('/api/mark', methods=['POST'])
@login_required
def api_mark():
    p = request.get_json(force=True)
    try:
        res = core.mark(db(), p.get('key'), None, bool(p.get('status')), p.get('remarks', ''),
                        session['user'], session['role'] == 'Admin')
    except ValueError as e:
        return jsonify(error=str(e)), 400
    res['dash'] = core.dashboard(db(), view_user() if session['role'] == 'Admin' else session['user'])['today']
    return jsonify(res)


# ------------------------------------------------------------------ reports
@app.route('/report')
@login_required
def report():
    f = report_filters()
    data = core.detail_report(db(), f, None if session['role'] == 'Admin' else session['user']) if request.args else None
    return render_template('report.html', f=f, data=data, opts=filter_options())


@app.route('/report.xlsx')
@login_required
def report_xlsx():
    f = report_filters()
    data = core.detail_report(db(), f, None if session['role'] == 'Admin' else session['user'])
    return xlsx(f"Report_{f['start']}_to_{f['end']}",
                ['Date', 'User', 'Company', 'Branch', 'Department', 'Check List', 'To-Do', 'Task Type', 'Status',
                 'Remarks', 'Timestamp', 'Source'],
                [[r['date'], r['user'], r['company'], r['branch'], r['department'], r['checklist'], r['todo'],
                  r['task_type'], 'TRUE' if r['status'] else 'FALSE', r['remarks'], r['timestamp'], r['source']]
                 for r in data['rows']])


@app.route('/admin/record/<int:rid>', methods=['POST'])
@admin_required
def admin_record(rid):
    con = db()
    con.execute("UPDATE records SET status=?, remarks=?, source='Admin', timestamp=? WHERE id=?",
                (1 if request.form.get('status') == '1' else 0, request.form.get('remarks', ''), core.now_text(con), rid))
    core.log(con, session['user'], 'EDIT_RECORD', rid)
    con.commit()
    flash('Record updated.', 'success')
    return redirect(request.referrer or url_for('report'))


@app.route('/efficiency')
@login_required
def efficiency():
    f = report_filters()
    if not request.args.get('start'):
        f['start'] = core.today(db()).replace(day=1).isoformat()
    data = core.efficiency(db(), f, None if session['role'] == 'Admin' else session['user'])
    return render_template('efficiency.html', f=f, data=data, opts=filter_options())


@app.route('/efficiency.xlsx')
@login_required
def efficiency_xlsx():
    f = report_filters()
    d = core.efficiency(db(), f, None if session['role'] == 'Admin' else session['user'])
    return xlsx(f"Efficiency_{f['start']}_to_{f['end']}",
                [d['group_by'].title(), 'Scheduled', 'Done (TRUE)', 'Missed (FALSE)', 'Efficiency %', 'Grade',
                 'Per-task Fine', 'Salary', 'Deduct %', '% Fine', 'Total Fine'],
                [[r['key'], r['total'], r['done'], r['missed'], r['pct'], r['grade'], r['task_fine'], r['salary'],
                  r['deduct_pct'], r['pct_fine'], r['total_fine']] for r in d['rows']])


@app.route('/monthly')
@login_required
def monthly():
    ym = request.args.get('month') or core.today(db()).strftime('%Y-%m')
    data = core.monthly(db(), ym, view_user())
    return render_template('monthly.html', ym=ym, data=data, opts=filter_options(), view_as=view_user() or '')


@app.route('/monthly.xlsx')
@login_required
def monthly_xlsx():
    ym = request.args.get('month') or core.today(db()).strftime('%Y-%m')
    data = core.monthly(db(), ym, view_user())
    rows = []
    for u in data['rows']:
        rows.append([ym, u['key'], 'ALL', u['total'], u['done'], u['missed'], u['pct'], u['grade'], u['salary'],
                     u['task_fine'], u['deduct_pct'], u['pct_fine'], u['total_fine']])
        for d in u['departments']:
            rows.append([ym, u['key'], d['department'], d['total'], d['done'], d['missed'], d['pct'], '', '', '', '', '', ''])
    return xlsx(f'Monthly_Performance_{ym}', ['Month', 'User', 'Department', 'Scheduled', 'Done', 'Missed',
                                              'Efficiency %', 'Grade', 'Salary', 'Per-task Fine', 'Deduct %',
                                              '% Fine', 'Total Fine'], rows)


@app.route('/monthly/save', methods=['POST'])
@admin_required
def monthly_save():
    ym = request.form['month']
    n = core.save_monthly(db(), ym)
    flash(f'Month-end snapshot of {ym} saved for {n} users.', 'success')
    return redirect(url_for('monthly', month=ym))


# ------------------------------------------------------------------ admin: tasks
@app.route('/admin/tasks')
@admin_required
def admin_tasks():
    con = db()
    a = request.args
    show = a.get('show', 'active')
    rows = [dict(r) for r in con.execute('SELECT * FROM tasks ORDER BY sort_order, id')]
    s = core.settings(con)
    opts = core.sched_opts(s)
    t = core.today(con)
    from schedule import is_scheduled
    out = []
    q = norm(a.get('q'))
    for r in rows:
        r['due_today'] = is_scheduled(r, t, **opts)
        if show == 'active' and r['hidden'] or show == 'hidden' and not r['hidden']:
            continue
        if show == 'today' and (r['hidden'] or not r['due_today']):
            continue
        if a.get('dept') and r['depart'] != a['dept'] or a.get('branch') and r['branch'] != a['branch']:
            continue
        if a.get('user') and norm(r['user']) != norm(a['user']):
            continue
        if q and q not in norm(' '.join(str(r[k]) for k in ('checklist', 'detail', 'task', 'user', 'depart', 'sop_name'))):
            continue
        out.append(r)
    return render_template('admin_tasks.html', rows=out, total=len(rows), a=a, show=show, L=core.listings(con))


@app.route('/admin/tasks/new', methods=['GET', 'POST'])
@app.route('/admin/tasks/<int:tid>/edit', methods=['GET', 'POST'])
@admin_required
def admin_task_form(tid=None):
    con = db()
    copy_of = request.args.get('copy', type=int)
    if request.method == 'POST':
        try:
            new_id = core.save_task(con, request.form, session['user'], tid)
            flash(f'Task saved (#{new_id}).', 'success')
            if request.form.get('again'):
                return redirect(url_for('admin_task_form', copy=new_id))
            return redirect(request.form.get('back') or url_for('admin_tasks'))
        except ValueError as e:
            flash(str(e), 'danger')
            t = dict(request.form)
    else:
        src = tid or copy_of
        t = dict(con.execute('SELECT * FROM tasks WHERE id=?', (src,)).fetchone() or {}) if src else {}
        if tid and not t:
            abort(404)
        if copy_of:
            t['detail'] = ''
        if not t:
            t = dict(company='RC', branch='RC', recurrence='Daily', target='Daily', audit_type='Post-Audit')
    return render_template('task_form.html', t=t, tid=tid, L=core.listings(con),
                           back=request.args.get('back') or request.form.get('back') or url_for('admin_tasks'))


@app.route('/admin/tasks/action', methods=['POST'])
@admin_required
def admin_task_action():
    con = db()
    ids = [int(x) for x in request.form.getlist('ids') if x.isdigit()]
    act = request.form.get('action')
    if ids and act in ('hide', 'unhide', 'delete'):
        marks = ','.join('?' * len(ids))
        if act == 'delete':
            con.execute(f'DELETE FROM tasks WHERE id IN ({marks})', ids)
        else:
            con.execute(f'UPDATE tasks SET hidden=? WHERE id IN ({marks})', [1 if act == 'hide' else 0] + ids)
        core.log(con, session['user'], act.upper() + '_TASK', ids)
        con.commit()
        flash(f'{len(ids)} task row(s): {act}.', 'success')
    return redirect(request.referrer or url_for('admin_tasks'))


# ------------------------------------------------------------------ admin: users & settings
@app.route('/admin/users', methods=['GET', 'POST'])
@admin_required
def admin_users():
    con = db()
    if request.method == 'POST':
        f = request.form
        name = (f.get('username') or '').strip()
        role = 'Admin' if f.get('role') == 'Admin' else 'Officer'
        try:
            salary = float(f.get('salary') or 0)
        except ValueError:
            salary = 0
        active = 1 if f.get('active') else 0
        u = con.execute('SELECT id FROM users WHERE username=?', (name,)).fetchone()
        if not name:
            flash('Username is required.', 'danger')
        elif u:
            con.execute('UPDATE users SET role=?, salary=?, active=? WHERE id=?', (role, salary, active, u['id']))
            if f.get('password'):
                con.execute('UPDATE users SET password_hash=? WHERE id=?', (generate_password_hash(f['password']), u['id']))
            flash(f'User {name} updated.', 'success')
        elif not f.get('password'):
            flash('Password is required for a new user.', 'danger')
        else:
            con.execute('INSERT INTO users(username, password_hash, role, salary, active, created_at) VALUES (?,?,?,?,?,?)',
                        (name, generate_password_hash(f['password']), role, salary, active, core.now_text(con)))
            flash(f'User {name} created.', 'success')
        core.log(con, session['user'], 'SAVE_USER', name)
        con.commit()
        return redirect(url_for('admin_users'))
    users = [dict(r) for r in con.execute(
        'SELECT u.*, (SELECT COUNT(*) FROM tasks t WHERE t.user=u.username COLLATE NOCASE AND t.hidden=0) n '
        'FROM users u ORDER BY role, username')]
    known = {norm(u['username']) for u in users}
    missing = sorted({r[0] for r in con.execute('SELECT DISTINCT user FROM tasks') if norm(r[0]) not in known})
    return render_template('users.html', users=users, missing=missing)


@app.route('/admin/settings', methods=['GET', 'POST'])
@admin_required
def admin_settings():
    con = db()
    if request.method == 'POST':
        for k, v in request.form.items():
            if k.startswith('s_') and k != 's_AUTO_CLOSE_LAST_DATE':
                core.set_setting(con, k[2:], v.strip())
        core.log(con, session['user'], 'SAVE_SETTINGS', dict(request.form))
        con.commit()
        flash('Settings saved.', 'success')
        return redirect(url_for('admin_settings'))
    rows = [dict(r) for r in con.execute('SELECT * FROM settings ORDER BY rowid')]
    return render_template('settings.html', rows=rows,
                           counts=dict(tasks=con.execute('SELECT COUNT(*) FROM tasks').fetchone()[0],
                                       records=con.execute('SELECT COUNT(*) FROM records').fetchone()[0]))


@app.route('/admin/close-day', methods=['POST'])
@admin_required
def admin_close_day():
    try:
        d = date.fromisoformat(request.form.get('date', ''))
    except ValueError:
        flash('Pick a date.', 'danger')
        return redirect(url_for('admin_settings'))
    if d >= core.today(db()):
        flash('Only past dates can be closed — today closes automatically tomorrow.', 'danger')
    else:
        n = core.close_day(db(), d)
        core.log(db(), session['user'], 'CLOSE_DAY', f'{d} {n}')
        db().commit()
        flash(f'{n} FALSE record(s) added for {d}.', 'success')
    return redirect(url_for('admin_settings'))


@app.route('/admin/import', methods=['POST'])
@admin_required
def admin_import():
    from import_excel import import_workbook
    f = request.files.get('file')
    if not f or not f.filename.lower().endswith('.xlsx'):
        flash('Choose the .xlsx file (Google Sheet → File → Download → Microsoft Excel).', 'danger')
        return redirect(url_for('admin_settings'))
    tmp = os.path.join(tempfile.gettempdir(), 'audit_import.xlsx')
    f.save(tmp)
    try:
        res = import_workbook(db(), tmp, replace=bool(request.form.get('replace')), by=session['user'])
        flash(f"Imported {res['tasks']} task rows, {res['users']} new users (password 1234), "
              f"{res['records']} history records.", 'success')
    except Exception as e:  # noqa: BLE001 — show any import problem to the admin
        db().rollback()
        flash(f'Import failed: {e}', 'danger')
    return redirect(url_for('admin_settings'))


@app.route('/admin/backup')
@admin_required
def admin_backup():
    con = db()
    con.execute('PRAGMA wal_checkpoint(FULL)')
    return send_file(core.DB_PATH, as_attachment=True, download_name=f'audit_backup_{core.today(con)}.db')


# ------------------------------------------------------------------ start
with app.app_context():
    _c = core.connect()
    core.init_db(_c)
    _c.close()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f'\n  Audit Dossier Portal running:  http://localhost:{port}\n'
          f'  Other computers on the network: http://<this-computer-IP>:{port}\n')
    try:
        from waitress import serve
        serve(app, host='0.0.0.0', port=port, threads=8)
    except ImportError:
        app.run(host='0.0.0.0', port=port, threaded=True)
