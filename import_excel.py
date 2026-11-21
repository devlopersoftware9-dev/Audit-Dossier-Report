"""
Import the old "Audit Dossier Web" Google Sheet (downloaded as .xlsx) into the new database.

    python import_excel.py "Audit_Dossier_Web.xlsx"            # first time (empty database)
    python import_excel.py "Audit_Dossier_Web.xlsx" --replace  # wipe tasks + records and import again

Reads:  Sort_List (tasks, row 7 onwards)  and  Officer_Master_DB (old TRUE/FALSE history).
Users:  every name in Sort_List column G gets a login with password 1234 (change it after first login).
"""
import sys
from datetime import date, datetime, time, timedelta

import openpyxl
from werkzeug.security import generate_password_hash

import core
from schedule import norm

DEFAULT_PASSWORD = '1234'


def _txt(v):
    if v is None:
        return ''
    if isinstance(v, datetime):
        if v.year < 1901:
            return v.strftime('%H:%M')
        return v.strftime('%Y-%m-%d')
    if isinstance(v, time):
        return v.strftime('%H:%M')
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def _link(cell):
    try:
        return cell.hyperlink.target if cell.hyperlink and cell.hyperlink.target else ''
    except AttributeError:
        return ''


def import_workbook(con, path, replace=False, by='import'):
    wb = openpyxl.load_workbook(path, data_only=True)
    if 'Sort_List' not in wb.sheetnames:
        raise ValueError('Sheet "Sort_List" not found in the file.')
    have = con.execute('SELECT COUNT(*) FROM tasks').fetchone()[0]
    if have and not replace:
        raise ValueError(f'Database already has {have} task rows. Use "replace" to import again.')
    if replace:
        con.execute('DELETE FROM tasks')
        con.execute('DELETE FROM records')

    ws = wb['Sort_List']
    ts = core.now_text(con)
    n_tasks, names = 0, {}
    branch_of = {}
    for r in range(7, ws.max_row + 1):
        c = lambda col: ws.cell(r, col)
        checklist = _txt(c(4).value)
        if not checklist:
            continue
        user = _txt(c(7).value) or 'Unassigned'
        names.setdefault(norm(user), user)
        sop_name, sop_url = _txt(c(26).value), _link(c(26))
        if sop_name.lower().startswith('http') and not sop_url:
            sop_url = sop_name
        hidden = 1 if norm(c(29).value) in ('y', 'yes', 'true', '1') else 0
        row = dict(depart=_txt(c(3).value), checklist=checklist, checklist_url=_link(c(4)), detail=_txt(c(5).value),
                   task=_txt(c(6).value), user=user, audit_type=_txt(c(11).value), recurrence=_txt(c(12).value),
                   target=_txt(c(13).value), target_month=_txt(c(14).value), company=_txt(c(15).value),
                   branch=_txt(c(16).value), start_time=_txt(c(17).value), end_time=_txt(c(18).value),
                   sop_name=sop_name, sop_url=sop_url, remarks=_txt(c(21).value), ordered_by=_txt(c(22).value))
        cols = core.TASK_FIELDS + ['hidden', 'sort_order', 'created_by', 'created_at']
        con.execute(f'INSERT INTO tasks({",".join(cols)}) VALUES ({",".join("?" * len(cols))})',
                    [row[k] for k in core.TASK_FIELDS] + [hidden, r, by, ''])   # '' = existed before
        branch_of.setdefault((norm(row['depart']), norm(checklist), norm(row['task'])), row['branch'])
        n_tasks += 1

    n_users = 0
    for u in names.values():
        if not con.execute('SELECT 1 FROM users WHERE username=?', (u,)).fetchone():
            con.execute('INSERT INTO users(username, password_hash, role, created_at) VALUES (?,?,?,?)',
                        (u, generate_password_hash(DEFAULT_PASSWORD), 'Officer', ts))
            n_users += 1

    n_recs, last = 0, None
    if 'Officer_Master_DB' in wb.sheetnames:
        ws = wb['Officer_Master_DB']
        for r in range(2, ws.max_row + 1):
            v = [ws.cell(r, i).value for i in range(1, 12)]
            if not v[2] or not v[9]:
                continue
            d = v[8]
            d = d.date() if isinstance(d, datetime) else d
            if not isinstance(d, date):
                try:
                    d = date.fromisoformat(str(d)[:10])
                except ValueError:
                    continue
            dept, cl, tt, user = _txt(v[1]), _txt(v[2]), _txt(v[4]), _txt(v[9])
            branch = _txt(v[10]) or branch_of.get((norm(dept), norm(cl), norm(tt))) or _txt(v[0])
            status = 1 if v[5] is True or norm(v[5]) == 'true' else 0
            stamp = v[6].strftime('%Y-%m-%d %H:%M:%S') if isinstance(v[6], datetime) else _txt(v[6])
            rk = core.record_key(d, user, branch, dept, cl, tt)
            cur = con.execute("""INSERT OR IGNORE INTO records(rkey, date, user, company, branch, department, checklist,
                                 todo, task_type, status, remarks, source, timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                              (rk, d.isoformat(), user, _txt(v[0]), branch, dept, cl, _txt(v[3]), tt, status,
                               _txt(v[7]), 'Imported', stamp))
            n_recs += cur.rowcount
            last = max(last, d) if last else d

    yesterday = core.today(con) - timedelta(days=1)
    core.set_setting(con, 'AUTO_CLOSE_LAST_DATE', min(last or yesterday, yesterday).isoformat())
    core.log(con, by, 'IMPORT', f'{path}: {n_tasks} task rows, {n_users} users, {n_recs} records')
    con.commit()
    return dict(tasks=n_tasks, users=n_users, records=n_recs)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    con = core.connect()
    core.init_db(con)
    res = import_workbook(con, sys.argv[1], replace='--replace' in sys.argv)
    print(f"Imported {res['tasks']} task rows, {res['users']} new users (password {DEFAULT_PASSWORD}), "
          f"{res['records']} history records.")
