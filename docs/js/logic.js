// Pure business logic (no Firebase) — same rules as the Python version and the old Google Sheet.
// Works in the browser and in Node (for tests).

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const BUCKET_ORDER = { 'Daily': 1, 'Weekly': 2, 'Fortnightly': 3, 'Monthly': 4, 'Quarterly / Yearly': 5 };

export const DEFAULT_SETTINGS = [
  ['APP_TITLE', 'Audit Dossier Portal', 'Portal title'],
  ['FINE_MODE', 'BOTH', 'NONE / PER_TASK / PERCENT / BOTH'],
  ['FINE_PER_TASK', '100', 'Rs fine for every task left FALSE'],
  ['FINE_PCT_SLABS', '95:0,85:2,75:5,60:10,0:15', 'Efficiency >= X% -> cut Y% of monthly salary (X:Y)'],
  ['GRADE_SLABS', '95:A+,85:A,75:B,60:C,0:D', 'Efficiency >= X% -> grade'],
  ['DEPT_FINES', '', 'Optional per-department fine, e.g. Accounts:200,IT:50'],
  ['WEEKLY_OFF', 'Fri', 'Off day (no tasks)'],
  ['WORK_ON_OFF_DAY_COMPANIES', 'RCG', 'Companies that still work on the off day (comma separated)'],
  ['HIDE_BRANCH_TABS', 'RC', 'Branches without their own "Branch:" tab (comma separated)'],
  ['UTC_OFFSET_HOURS', '5', 'Time zone (Pakistan = 5)'],
  ['DAY_CLOSE_HOUR', '23', 'Hour the day closes (23 = 11 PM): ticks saved to the database, unmarked = FALSE, next day starts'],
];

export const norm = (v) => (v == null ? '' : String(v)).trim().toLowerCase();
const pad = (n) => (n < 10 ? '0' : '') + n;

// ---------- dates (yyyy-mm-dd strings, calendar math in UTC) ----------
export function keyFromUTC(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
export function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return { y, m, d }; }
export function addDays(k, n) { const p = parseKey(k); return keyFromUTC(Date.UTC(p.y, p.m - 1, p.d + n)); }
export function dayName(k) { const p = parseKey(k); return DAY_NAMES[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]; }
export function todayKey(offsetHours = 5, nowMs = Date.now()) { return keyFromUTC(nowMs + offsetHours * 3600000); }
export function nowText(offsetHours = 5, nowMs = Date.now()) {
  const d = new Date(nowMs + offsetHours * 3600000);
  return keyFromUTC(nowMs + offsetHours * 3600000) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}
export function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { start: `${ym}-01`, end: keyFromUTC(Date.UTC(y, m, 0)) };
}

// ---------- schedule (old sheet column B / T) ----------
export function revisedTarget(t, dk, offDay = 'Fri') {
  if (!String(t.task ?? '').trim()) return null;
  const tg = t.target;
  let day;
  if (tg == null || String(tg).trim() === '') day = 0;
  else { day = Number(String(tg).trim()); if (Number.isNaN(day)) return null; day = Math.trunc(day); }
  const p = parseKey(dk);
  let month = p.m;
  if (['quarterly', 'twice a year', 'yearly'].includes(norm(t.recurrence))) month = Math.trunc(Number(t.target_month) || 0);
  let ms = Date.UTC(p.y, month - 1, day);
  if (DAY_NAMES[new Date(ms).getUTCDay()] === offDay) ms -= 86400000;
  return keyFromUTC(ms);
}

export function isScheduled(t, dk, opts = {}) {
  const offDay = opts.offDay || 'Fri';
  const work = (opts.workOnOffDay || ['RCG']).map(norm);
  if (!String(t.checklist ?? '').trim()) return false;
  const dn = dayName(dk);
  if (dn === offDay && !work.includes(norm(t.company))) return false;
  const target = norm(t.target);
  if (target === 'daily') return true;
  if (target === norm(dn)) return true;
  return revisedTarget(t, dk, offDay) === dk;
}

export function bucket(t) {
  const r = norm(t.recurrence), k = norm(t.task);
  if (r === 'daily') return 'Daily';
  if (r === 'weekly') return 'Weekly';
  if (r.startsWith('fort') || r.startsWith('forn')) return 'Fortnightly';
  if (r === 'monthly') return 'Monthly';
  if (['quarterly', 'yearly', 'twice a year'].includes(r)) return 'Quarterly / Yearly';
  if (k.includes('weekly')) return 'Weekly';
  if (k.includes('fort') || k.includes('forn') || k.startsWith('fn ')) return 'Fortnightly';
  if (k.includes('monthly')) return 'Monthly';
  if (k.includes('yearly') || k.includes('quarter')) return 'Quarterly / Yearly';
  return 'Daily';
}

// ---------- settings ----------
export function settingsWithDefaults(s = {}) {
  const out = {};
  DEFAULT_SETTINGS.forEach(([k, v]) => { out[k] = v; });
  Object.keys(s || {}).forEach((k) => { if (s[k] != null) out[k] = String(s[k]); });
  return out;
}
export const settingList = (s, key) => String(s[key] || '').split(',').map((x) => x.trim()).filter(Boolean);
export const schedOpts = (s) => ({ offDay: (s.WEEKLY_OFF || 'Fri').trim(), workOnOffDay: settingList(s, 'WORK_ON_OFF_DAY_COMPANIES') });
export const tzOffset = (s) => { const h = Number(s.UTC_OFFSET_HOURS); return Number.isNaN(h) ? 5 : h; };

export function parseSlabs(text) {
  return String(text || '').split(',').map((p) => {
    const i = p.indexOf(':'); if (i < 0) return null;
    const min = Number(p.slice(0, i)); return Number.isNaN(min) ? null : { min, val: p.slice(i + 1).trim() };
  }).filter(Boolean).sort((a, b) => b.min - a.min);
}
export function slabFor(slabs, pct) {
  for (const s of slabs) if (pct >= s.min) return s.val;
  return slabs.length ? slabs[slabs.length - 1].val : '';
}

// ---------- groups ----------
const GROUP_FIELDS = ['company', 'branch', 'depart', 'checklist', 'task', 'recurrence', 'target', 'user'];
export const groupKey = (t) => GROUP_FIELDS.map((k) => norm(t[k])).join('|');

/** tasks: array of task docs {id, ...}. Returns check-list groups (one portal line each). */
export function buildGroups(tasks, includeHidden = false) {
  const map = new Map();
  const list = [...tasks].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.id).localeCompare(String(b.id)));
  for (const t of list) {
    if (t.hidden && !includeHidden) continue;
    const k = groupKey(t);
    let g = map.get(k);
    if (!g) {
      g = { key: k, company: t.company, branch: t.branch, depart: t.depart, checklist: t.checklist,
        checklist_url: t.checklist_url || '', task: t.task, user: t.user, recurrence: t.recurrence, target: t.target,
        target_month: t.target_month || '', audit_type: t.audit_type || '', bucket: bucket(t),
        sop_name: t.sop_name || '', sop_url: t.sop_url || '', start_time: t.start_time || '', end_time: t.end_time || '',
        details: [], ids: [], since: (t.created_at || '').slice(0, 10) };
      map.set(k, g);
    }
    if (t.detail) g.details.push(t.detail);
    g.ids.push(t.id);
    if (!g.sop_url && t.sop_url) g.sop_url = t.sop_url;
    if (!g.sop_name && t.sop_name) g.sop_name = t.sop_name;
    if (!g.checklist_url && t.checklist_url) g.checklist_url = t.checklist_url;
    const c = (t.created_at || '').slice(0, 10);
    g.since = (!c || !g.since) ? '' : (c < g.since ? c : g.since);
  }
  return [...map.values()];
}
export const sortGroups = (l) => [...l].sort((a, b) => (BUCKET_ORDER[a.bucket] || 9) - (BUCKET_ORDER[b.bucket] || 9));

export const recordKey = (d, user, branch, dept, checklist, taskType) =>
  [d, user, branch, dept, checklist, taskType].map(norm).join('|');
export const groupRecordKey = (g, d) => recordKey(d, g.user, g.branch, g.depart, g.checklist, g.task);

export function attach(g, recIndex, d) {
  const r = recIndex.get(groupRecordKey(g, d));
  return { ...g, status: r ? !!r.status : null, remarks: r ? (r.remarks || '') : '', marked_at: r ? (r.timestamp || '') : '', source: r ? r.source : '' };
}
export const indexRecords = (recs) => new Map(recs.map((r) => [recordKey(r.date, r.user, r.branch, r.department, r.checklist, r.task_type), r]));

export function todayTasks(groups, recs, d, opts, user = null) {
  const idx = indexRecords(recs.filter((r) => r.date === d));
  return sortGroups(groups.filter((g) => isScheduled(g, d, opts) && (user == null || norm(g.user) === norm(user)))
    .map((g) => attach(g, idx, d)));
}

export function categoryTasks(groups, recs, d, opts, kind, value, user = null) {
  const idx = indexRecords(recs.filter((r) => r.date === d));
  return sortGroups(groups.filter((g) => norm(kind === 'branch' ? g.branch : g.depart) === norm(value)
    && (user == null || norm(g.user) === norm(user)))
    .map((g) => ({ ...attach(g, idx, d), due_today: isScheduled(g, d, opts) })));
}

export function tabs(groups, s, user = null) {
  const hide = settingList(s, 'HIDE_BRANCH_TABS').map(norm);
  const gs = groups.filter((g) => user == null || norm(g.user) === norm(user));
  const depts = [...new Set(gs.map((g) => g.depart).filter(Boolean))].sort();
  const branches = [...new Set(gs.map((g) => g.branch).filter((b) => b && !hide.includes(norm(b))))].sort();
  return { depts, branches };
}

export function stats(rows) {
  const done = rows.filter((r) => r.status === true).length;
  return { total: rows.length, done, pending: rows.length - done, pct: rows.length ? Math.round(done * 100 / rows.length) : 0 };
}

export function makeRecord(g, d, user, status, remarks, source, ts) {
  return { date: d, user, user_lc: norm(user), company: g.company, branch: g.branch, department: g.depart,
    checklist: g.checklist, todo: g.details.join(', '), task_type: g.task, status: status ? 1 : 0,
    remarks: (remarks || '').slice(0, 1000), source, timestamp: ts };
}

/** FALSE records for every task due on day d (for the given users) that has no record. */
export function missingForDay(groups, recsOfDay, d, opts, activeUsersLc, ts) {
  const idx = indexRecords(recsOfDay);
  const out = [];
  for (const g of groups) {
    if (!isScheduled(g, d, opts) || !activeUsersLc.has(norm(g.user))) continue;
    if (g.since && g.since > d) continue;
    const k = groupRecordKey(g, d);
    if (idx.has(k)) continue;
    idx.set(k, true);
    out.push(makeRecord(g, d, g.user, false, 'Not marked (auto-closed)', 'Auto-Closed', ts));
  }
  return out;
}

// ---------- reports ----------
export function filterRecords(recs, f, userLock = null) {
  const user = norm(userLock || f.user);
  const st = String(f.status || 'ALL').toUpperCase();
  return recs.filter((r) => {
    if (r.date < f.start || r.date > f.end) return false;
    if (user && norm(r.user) !== user) return false;
    if (st === 'TRUE' && !r.status) return false;
    if (st === 'FALSE' && r.status) return false;
    for (const [k, col] of [['department', 'department'], ['branch', 'branch'], ['task_type', 'task_type'], ['source', 'source']]) {
      if (f[k] && norm(r[col]) !== norm(f[k])) return false;
    }
    if (f.checklist && !norm(r.checklist).includes(norm(f.checklist))) return false;
    return true;
  });
}

export function fineCtx(s) {
  const mode = String(s.FINE_MODE || 'BOTH').toUpperCase();
  const dept = {};
  String(s.DEPT_FINES || '').split(',').forEach((p) => {
    const i = p.lastIndexOf(':'); if (i < 0) return;
    const v = Number(p.slice(i + 1)); if (!Number.isNaN(v)) dept[norm(p.slice(0, i))] = v;
  });
  return { mode, perTaskOn: mode === 'PER_TASK' || mode === 'BOTH', pctOn: mode === 'PERCENT' || mode === 'BOTH',
    per: Number(s.FINE_PER_TASK) || 0, dept, slabs: parseSlabs(s.FINE_PCT_SLABS), grades: parseSlabs(s.GRADE_SLABS) };
}

const round1 = (x) => Math.round(x * 10) / 10;
const KEY_OF = {
  user: (r) => r.user, department: (r) => r.department, checklist: (r) => `${r.department} › ${r.checklist}`,
  branch: (r) => r.branch, task_type: (r) => r.task_type, date: (r) => r.date,
};

/** salaries: Map(username_lc -> salary) */
export function efficiency(recs, f, s, salaries = new Map(), userLock = null) {
  const by = KEY_OF[f.group_by] ? f.group_by : 'user';
  const rows0 = filterRecords(recs, { ...f, status: 'ALL' }, userLock).filter((r) => norm(r.source) !== 'extra');
  const fc = fineCtx(s);
  const agg = new Map();
  for (const r of rows0) {
    const k = KEY_OF[by](r) || '(blank)';
    let g = agg.get(k);
    if (!g) { g = { key: k, total: 0, done: 0, missed: 0, task_fine: 0 }; agg.set(k, g); }
    g.total++;
    if (r.status) g.done++;
    else { g.missed++; if (fc.perTaskOn) g.task_fine += (fc.dept[norm(r.department)] ?? fc.per); }
  }
  const rows = [...agg.values()].map((g) => {
    g.pct = g.total ? round1(g.done * 100 / g.total) : 0;
    g.grade = slabFor(fc.grades, g.pct);
    g.salary = by === 'user' ? (salaries.get(norm(g.key)) || 0) : 0;
    g.deduct_pct = (fc.pctOn && by === 'user') ? (Number(slabFor(fc.slabs, g.pct)) || 0) : 0;
    g.pct_fine = Math.round(g.salary * g.deduct_pct / 100);
    g.total_fine = Math.round(g.task_fine + g.pct_fine);
    return g;
  });
  rows.sort(by === 'date' ? ((a, b) => (a.key < b.key ? -1 : 1)) : ((a, b) => (a.pct - b.pct) || (b.missed - a.missed)));
  const tot = { total: 0, done: 0, missed: 0, total_fine: 0 };
  rows.forEach((g) => { tot.total += g.total; tot.done += g.done; tot.missed += g.missed; tot.total_fine += g.total_fine; });
  tot.pct = tot.total ? round1(tot.done * 100 / tot.total) : 0;
  return { rows, totals: tot, group_by: by, mode: fc.mode, show_pct: fc.pctOn && by === 'user' };
}

export function monthly(recs, ym, s, salaries = new Map(), user = null) {
  const { start, end } = monthBounds(ym);
  const eff = efficiency(recs, { start, end, user: user || '', group_by: 'user' }, s, salaries);
  const inMonth = recs.filter((r) => r.date >= start && r.date <= end && norm(r.source) !== 'extra');
  const rows = [...eff.rows].sort((a, b) => b.pct - a.pct).map((u) => {
    const mine = inMonth.filter((r) => norm(r.user) === norm(u.key));
    const dm = new Map();
    mine.forEach((r) => {
      let d = dm.get(r.department);
      if (!d) { d = { department: r.department, total: 0, done: 0, missed: 0 }; dm.set(r.department, d); }
      d.total++; if (r.status) d.done++; else d.missed++;
    });
    const departments = [...dm.values()].map((d) => ({ ...d, pct: d.total ? round1(d.done * 100 / d.total) : 0 }))
      .sort((a, b) => a.pct - b.pct);
    const missed_list = mine.filter((r) => !r.status).sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((r) => ({ date: r.date, department: r.department, checklist: r.checklist, task_type: r.task_type, remarks: r.remarks }));
    return { ...u, departments, missed_list };
  });
  return { month: ym, rows, mode: eff.mode };
}

// ---------- task form ----------
export const TASK_FIELDS = ['depart', 'checklist', 'checklist_url', 'detail', 'task', 'user', 'audit_type', 'recurrence', 'target',
  'target_month', 'company', 'branch', 'start_time', 'end_time', 'sop_name', 'sop_url', 'remarks', 'ordered_by'];
const REQUIRED = { depart: 'Department', checklist: 'Check List', task: 'Task', user: 'User', recurrence: 'Recurrence',
  target: 'Target Day / Date', company: 'Company', branch: 'Branch' };

export function cleanTask(form) {
  const t = {};
  TASK_FIELDS.forEach((k) => { t[k] = String(form[k] ?? '').trim(); });
  for (const [k, label] of Object.entries(REQUIRED)) if (!t[k]) throw new Error(`${label} is required.`);
  if (/^\d+$/.test(t.target) && (Number(t.target) < 1 || Number(t.target) > 31)) throw new Error('Target date must be 1 – 31.');
  if (['quarterly', 'twice a year', 'yearly'].includes(norm(t.recurrence)) && /^\d+$/.test(t.target) && !t.target_month) {
    throw new Error('Quarterly / Yearly tasks need a Target Month (1 – 12).');
  }
  for (const k of ['sop_url', 'checklist_url']) if (t[k] && !/^https?:\/\//i.test(t[k])) t[k] = 'https://' + t[k];
  t.hidden = !!form.hidden;
  t.user_lc = norm(t.user);
  return t;
}

// ---------- Excel import helpers (old Google Sheet layout) ----------
const XL_EPOCH = Date.UTC(1899, 11, 30);
export function serialToKey(v) { return keyFromUTC(XL_EPOCH + Math.floor(Number(v)) * 86400000); }
export function serialToTime(v) {
  const mins = Math.round((Number(v) % 1) * 1440);
  return pad(Math.floor(mins / 60) % 24) + ':' + pad(mins % 60);
}
export function serialToStamp(v) {
  const ms = XL_EPOCH + Math.round(Number(v) * 86400000);
  const d = new Date(ms);
  return keyFromUTC(ms) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}
export function cellText(c) {
  if (!c || c.v == null) return '';
  if (c.t === 'n' && Number.isInteger(c.v)) return String(c.v);
  return String(c.v).trim();
}

/**
 * Parse the old sheet. getCell(sheetName, row1, col1) -> SheetJS cell or undefined. maxRow(sheetName) -> number.
 * Returns { tasks, records, users, lastDate }.
 */
// Header names of the tasks sheet -> task fields (first match wins; "Check List" appears twice in the sheet).
const TASK_HEADERS = {
  'depart': 'depart', 'department': 'depart', 'check list': 'checklist', 'checklist': 'checklist',
  'check list detail': 'detail', 'task': 'task', '1st': 'user', 'user': 'user',
  'triggered /daily work': 'audit_type', 'triggered / daily work': 'audit_type', 'recurrence': 'recurrence',
  'target day / date': 'target', 'target month': 'target_month', 'company': 'company', 'branch name': 'branch',
  'branch': 'branch', 'starttime': 'start_time', 'start time': 'start_time', 'endtime': 'end_time', 'end time': 'end_time',
  'remarks': 'remarks', 'ordered by': 'ordered_by', 'sop': 'sop', 'hide (y)': 'hide', 'hide': 'hide',
};
const DEFAULT_COLS = { depart: 3, checklist: 4, detail: 5, task: 6, user: 7, audit_type: 11, recurrence: 12, target: 13,
  target_month: 14, company: 15, branch: 16, start_time: 17, end_time: 18, remarks: 21, ordered_by: 22, sop: 26, hide: 29 };

/** Find the tasks sheet (any name) and its header row: the row that has "Check List" and "1st". */
export function findTaskSheet(getCell, maxRow, sheetNames) {
  const order = [...sheetNames].sort((a, b) => (a === 'Sort_List' ? -1 : b === 'Sort_List' ? 1 : 0));
  for (const sh of order) {
    if (sh === 'Officer_Master_DB' || sh === 'Listings') continue;
    for (let r = 1; r <= Math.min(15, maxRow(sh)); r++) {
      const cols = {};
      for (let c = 1; c <= 40; c++) {
        const h = norm(cellText(getCell(sh, r, c))).replace(/\s+/g, ' ');
        const f = TASK_HEADERS[h];
        if (f && !cols[f]) cols[f] = c;
      }
      if (cols.checklist && cols.user) return { sheet: sh, headerRow: r, cols: { ...DEFAULT_COLS, ...cols } };
    }
  }
  return null;
}

/**
 * Parse the old sheet (or a copy of it with another sheet name / header row).
 * getCell(sheetName, row1, col1) -> SheetJS cell or undefined. maxRow(sheetName) -> number. has(name) -> bool.
 * Returns { tasks, records, users, lastDate, sheet }.
 */
export function parseOldWorkbook(getCell, maxRow, has, sheetNames = ['Sort_List']) {
  const found = findTaskSheet(getCell, maxRow, sheetNames);
  if (!found) throw new Error('No task sheet found: the file needs a sheet with the headers "Check List" and "1st".');
  const { sheet, headerRow, cols } = found;
  const tasks = [], names = new Map(), branchOf = new Map();
  for (let r = headerRow + 1; r <= maxRow(sheet); r++) {
    const c = (f) => getCell(sheet, r, cols[f]);
    const checklist = cellText(c('checklist'));
    if (!checklist) continue;
    const user = cellText(c('user')) || 'Unassigned';
    if (!names.has(norm(user))) names.set(norm(user), user);
    const time = (f) => { const x = c(f); if (!x || x.v == null || x.v === '') return ''; return x.t === 'n' ? serialToTime(x.v) : cellText(x); };
    const link = (x) => (x && x.l && x.l.Target) || '';
    let sopName = cellText(c('sop')); let sopUrl = link(c('sop'));
    if (/^https?:/i.test(sopName) && !sopUrl) sopUrl = sopName;
    const t = { depart: cellText(c('depart')), checklist, checklist_url: link(c('checklist')), detail: cellText(c('detail')), task: cellText(c('task')),
      user, user_lc: norm(user), audit_type: cellText(c('audit_type')), recurrence: cellText(c('recurrence')), target: cellText(c('target')),
      target_month: cellText(c('target_month')), company: cellText(c('company')), branch: cellText(c('branch')),
      start_time: time('start_time'), end_time: time('end_time'), sop_name: sopName, sop_url: sopUrl,
      remarks: cellText(c('remarks')), ordered_by: cellText(c('ordered_by')),
      hidden: ['y', 'yes', 'true', '1'].includes(norm(cellText(c('hide')))), sort_order: r, created_at: '', created_by: 'import' };
    tasks.push(t);
    const bk = [norm(t.depart), norm(checklist), norm(t.task)].join('|');
    if (!branchOf.has(bk)) branchOf.set(bk, t.branch);
  }
  const records = [], seen = new Set();
  let lastDate = '';
  if (has('Officer_Master_DB')) {
    for (let r = 2; r <= maxRow('Officer_Master_DB'); r++) {
      const c = (col) => getCell('Officer_Master_DB', r, col);
      const cl = cellText(c(3)), user = cellText(c(10));
      if (!cl || !user) continue;
      const dc = c(9);
      let d = '';
      if (dc && dc.t === 'n') d = serialToKey(dc.v);
      else if (dc && /^\d{4}-\d{2}-\d{2}/.test(cellText(dc))) d = cellText(dc).slice(0, 10);
      if (!d) continue;
      const dept = cellText(c(2)), tt = cellText(c(5));
      const branch = cellText(c(11)) || branchOf.get([norm(dept), norm(cl), norm(tt)].join('|')) || cellText(c(1));
      const sc = c(6);
      const status = sc && (sc.v === true || norm(sc.v) === 'true') ? 1 : 0;
      const tc = c(7);
      const stamp = tc && tc.t === 'n' ? serialToStamp(tc.v) : cellText(tc);
      const k = recordKey(d, user, branch, dept, cl, tt);
      if (seen.has(k)) continue;
      seen.add(k);
      records.push({ date: d, user, user_lc: norm(user), company: cellText(c(1)), branch, department: dept, checklist: cl,
        todo: cellText(c(4)), task_type: tt, status, remarks: cellText(c(8)), source: 'Imported', timestamp: stamp });
      if (d > lastDate) lastDate = d;
    }
  }
  return { tasks, records, users: [...names.values()], lastDate, sheet };
}

// Dropdown values — same lists as the old sheet's "Listings" tab, plus whatever is already used in tasks.
export const SHEET_LISTS = {
  depart: ['Accounts', 'Admin', 'HR', 'Inventory', 'IT', 'Online & Marketing', 'QA', 'Retail', 'Retail + WH', 'Warehouse'],
  audit_type: ['Pre-Audit', 'Post-Audit'],
  recurrence: ['Daily', 'Weekly', 'Fornightly', 'Monthly', 'Quarterly', 'Twice a Year', 'Yearly', 'Trigger'],
  company: ['RC', 'RCG', 'Rc Gojra', 'RCG Fsd'],
  days: ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  dates: Array.from({ length: 31 }, (_, i) => String(i + 1)),
  months: Array.from({ length: 12 }, (_, i) => String(i + 1)),
};
const uniqSorted = (a) => [...new Set(a.filter(Boolean))].sort((x, y) => String(x).toLowerCase().localeCompare(String(y).toLowerCase()));

/** Keep SOP / check-list links that a newer file lost (match by SOP name, then by department + check list). */
export function carryLinks(newTasks, oldTasks) {
  const sop = new Map(), cl = new Map();
  for (const t of oldTasks) {
    if (t.sop_url && t.sop_name) sop.set(norm(t.sop_name), t.sop_url);
    if (t.checklist_url) cl.set(norm(t.depart) + '|' + norm(t.checklist), t.checklist_url);
  }
  let n = 0;
  for (const t of newTasks) {
    if (!t.sop_url && t.sop_name && sop.has(norm(t.sop_name))) { t.sop_url = sop.get(norm(t.sop_name)); n++; }
    const k = norm(t.depart) + '|' + norm(t.checklist);
    if (!t.checklist_url && cl.has(k)) { t.checklist_url = cl.get(k); n++; }
  }
  return n;
}

export function listings(tasks, userNames = []) {
  const col = (k) => tasks.map((t) => t[k]).filter(Boolean);
  return {
    depart: uniqSorted([...SHEET_LISTS.depart, ...col('depart')]),
    checklist: uniqSorted(col('checklist')),
    task: uniqSorted(col('task')),
    audit_type: uniqSorted([...SHEET_LISTS.audit_type, ...col('audit_type')]),
    company: uniqSorted([...SHEET_LISTS.company, ...col('company')]),
    branch: uniqSorted(['RC', ...col('branch')]),
    user: uniqSorted([...col('user'), ...userNames]),
    recurrence: [...new Set([...SHEET_LISTS.recurrence, ...col('recurrence')])],
    target: ['Daily', 'Triggered', ...SHEET_LISTS.days, ...SHEET_LISTS.dates],
  };
}

/** Target Day / Date choices that make sense for a Recurrence (column M depends on column L). */
export function targetsFor(recurrence) {
  const r = norm(recurrence);
  if (r === 'daily') return ['Daily'];
  if (r === 'weekly') return SHEET_LISTS.days;
  if (r === 'trigger' || r === 'triggered') return ['Triggered'];
  if (r === 'monthly' || r.startsWith('forn') || r.startsWith('fort')) return SHEET_LISTS.dates;
  if (['quarterly', 'twice a year', 'yearly'].includes(r)) return SHEET_LISTS.dates;
  return ['Daily', 'Triggered', ...SHEET_LISTS.days, ...SHEET_LISTS.dates];
}
export const needsMonth = (recurrence) => ['quarterly', 'twice a year', 'yearly'].includes(norm(recurrence));

/** Next dates (yyyy-mm-dd) on which a task will be "Y", looking ahead `days` days. */
export function nextDueDates(t, fromKey, opts, count = 5, days = 400) {
  const out = [];
  for (let i = 0, d = fromKey; i < days && out.length < count; i++, d = addDays(d, 1)) if (isScheduled(t, d, opts)) out.push(d);
  return out;
}
