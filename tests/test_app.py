"""
End-to-end test with the real sheet export.
    AUDIT_XLSX=path/to/Audit_Dossier_Web.xlsx python tests/test_app.py
"""
import os
import sys
import tempfile
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ['AUDIT_DB'] = os.path.join(tempfile.mkdtemp(), 'test.db')
os.environ['AUDIT_FAKE_NOW'] = '2026-11-21T10:00:00'
XLSX = os.environ.get('AUDIT_XLSX')

import openpyxl  # noqa: E402

import core  # noqa: E402
from app import app  # noqa: E402
from import_excel import import_workbook  # noqa: E402

ok = lambda m: print('  ✔', m)  # noqa: E731
con = core.connect()
core.init_db(con)
res = import_workbook(con, XLSX)
print('import', res)

# 1. Today's list == the sheet's column-B "Y" check lists
ws = openpyxl.load_workbook(XLSX, data_only=True)['Sort_List']
y = {(ws.cell(r, 15).value, ws.cell(r, 16).value, ws.cell(r, 3).value, ws.cell(r, 4).value, ws.cell(r, 6).value)
     for r in range(7, ws.max_row + 1) if ws.cell(r, 2).value == 'Y' and ws.cell(r, 4).value}
t = core.today_tasks(con, 'Amjad')
assert len(t) == len(y), (len(t), len(y))
ok(f'Today = {len(t)} check lists = column B "Y"')
assert any(g['sop_url'] for g in t)
ok('SOP link imported from the sheet')

c = app.test_client()
r = c.get('/tasks')
assert r.status_code == 302
c.post('/login', data=dict(username='amjad', password='1234'))
assert c.get('/tasks').status_code == 302
ok('default password -> forced to change it')
c.post('/password', data=dict(old='1234', new='amjad@2026'))
r = c.get('/tasks')
html = r.get_data(as_text=True)
assert r.status_code == 200 and '2-Bilty receiving (WH)' in html and 'Bilty receiving (WH / Receipt room)' in html
ok('officer portal renders (with SOP link)')

key = t[0]['key']
r = c.post('/api/mark', json=dict(key=key, status=True, remarks='ok'))
assert r.status_code == 200 and r.json['status'] is True and r.json['dash']['done'] == 1, r.json
c.post('/api/mark', json=dict(key=key, status=False, remarks='changed'))
c.post('/api/mark', json=dict(key=key, status=True, remarks='done'))
n = con.execute("SELECT COUNT(*) FROM records WHERE date='2026-11-21'").fetchone()[0]
assert n == 1
ok('mark TRUE/FALSE saves date-wise, re-marking updates the same row')

for url in ['/tasks?tab=branch&v=Zioso', '/tasks?tab=dept&v=Accounts', '/report?start=2026-11-01&end=2026-11-21&status=FALSE',
            '/efficiency?start=2026-11-01&end=2026-11-20', '/efficiency?start=2026-11-01&end=2026-11-20&group_by=department',
            '/monthly?month=2026-11', '/tasks.xlsx', '/report.xlsx?start=2026-11-01&end=2026-11-21', '/monthly.xlsx?month=2026-11',
            '/efficiency.xlsx?start=2026-11-01&end=2026-11-20', '/password']:
    r = c.get(url)
    assert r.status_code == 200, (url, r.status_code)
ok('officer pages + Excel exports work')
z = c.get('/tasks?tab=branch&v=Zioso').get_data(as_text=True)
assert z.count('data-key=') == 8
ok('Branch: Zioso shows 8 check lists (same as old portal)')
assert c.get('/admin/tasks').status_code == 403
ok('officer cannot open admin pages')
r = c.get('/report?start=2026-11-01&end=2026-11-21&user=SomeoneElse')
assert 'SomeoneElse' not in r.get_data(as_text=True).split('<tbody>')[-1]

# admin
a = app.test_client()
a.post('/login', data=dict(username='admin', password='admin123'))
a.post('/password', data=dict(old='admin123', new='Admin@2026'))
for url in ['/tasks', '/tasks?user=Amjad', '/admin/tasks', '/admin/tasks?show=today', '/admin/tasks/new', '/admin/users',
            '/admin/settings', '/monthly?month=2026-11', '/admin/backup']:
    assert a.get(url).status_code == 200, url
ok('admin pages work')

# add task WITHOUT SOP (optional) and WITH SOP
r = a.post('/admin/tasks/new', data=dict(depart='IT', checklist='Test Backup Check', detail='Check NAS log', task='Daily Followup',
                                         user='Amjad', company='RC', branch='RC', recurrence='Daily', target='Daily'))
assert r.status_code == 302
r = a.post('/admin/tasks/new', data=dict(depart='IT', checklist='Test Backup Check', detail='Second point', task='Daily Followup',
                                         user='Amjad', company='RC', branch='RC', recurrence='Daily', target='Daily',
                                         sop_name='Backup SOP', sop_url='docs.google.com/x'))
g = [x for x in core.today_tasks(con, 'Amjad') if x['checklist'] == 'Test Backup Check'][0]
assert len(g['details']) == 2 and g['sop_url'] == 'https://docs.google.com/x'
ok('new tasks (SOP optional) go into Today; 2 points grouped; link fixed to https://')
r = a.post('/admin/tasks/new', data=dict(depart='IT'), follow_redirects=True)
assert 'is required' in r.get_data(as_text=True)
ok('validation message')
ids = [str(r[0]) for r in con.execute("SELECT id FROM tasks WHERE checklist='Test Backup Check'")]
a.post('/admin/tasks/action', data=dict(action='hide', ids=ids))
assert not [x for x in core.today_tasks(con, 'Amjad') if x['checklist'] == 'Test Backup Check']
ok('hide works')
tid = int(ids[0])
r = a.post(f'/admin/tasks/{tid}/edit', data=dict(depart='IT', checklist='Test Backup Check', detail='Edited', task='Monthly Report',
                                                  user='Amjad', company='RC', branch='RC', recurrence='Monthly', target='21'))
assert any(x['checklist'] == 'Test Backup Check' and x['task'] == 'Monthly Report' for x in core.today_tasks(con, 'Amjad'))
ok('edit: monthly target 21 is due on 21 Nov, unhidden by the form')

# auto-close + fines
assert core.close_day(con, date(2026, 11, 19)) == 0
ok('old history matched — no duplicate FALSE for 19 Nov')
os.environ['AUDIT_FAKE_NOW'] = '2026-11-23T09:00:00'
n = core.auto_close(con)
added = con.execute("SELECT COUNT(*) FROM records WHERE source='Auto-Closed' AND date='2026-11-21'").fetchone()[0]
due21 = len(core.today_tasks(con, 'Amjad', date(2026, 11, 21))) - 1   # one was marked
assert added == due21, (added, due21)
ok(f'auto-close on 23 Nov added {n} FALSE rows (unmarked tasks of 21 + 22 Nov)')
assert core.auto_close(con) == 0
a.post('/admin/users', data=dict(username='Amjad', role='Officer', salary='50000', active='1'))
a.post('/admin/settings', data=dict(s_FINE_PER_TASK='50', s_FINE_MODE='BOTH', s_DEPT_FINES='Accounts:200'))
m = core.monthly(con, '2026-11')['rows'][0]
print(f"    Nov: sched {m['total']} done {m['done']} missed {m['missed']} {m['pct']}% grade {m['grade']} "
      f"task fine {m['task_fine']} pct fine {m['pct_fine']} ({m['deduct_pct']}%) total {m['total_fine']}")
acc = con.execute("SELECT COUNT(*) FROM records WHERE status=0 AND department='Accounts' AND source<>'Extra' AND date LIKE '2026-11%'").fetchone()[0]
oth = m['missed'] - acc
assert m['task_fine'] == acc * 200 + oth * 50
assert m['pct_fine'] == round(50000 * m['deduct_pct'] / 100)
ok('fines: department override + per-task + salary %')
a.post('/monthly/save', data=dict(month='2026-11'))
a.post('/monthly/save', data=dict(month='2026-11'))
assert con.execute("SELECT COUNT(*) FROM monthly_snapshots WHERE month='2026-11'").fetchone()[0] == 1
ok('monthly snapshot saved (no duplicates)')
rid = con.execute("SELECT id FROM records WHERE status=0 LIMIT 1").fetchone()[0]
a.post(f'/admin/record/{rid}', data=dict(status='1', remarks='verified'))
assert con.execute('SELECT status, source FROM records WHERE id=?', (rid,)).fetchone()[0] == 1
ok('admin corrected a record')
print('\nALL TESTS PASSED')
