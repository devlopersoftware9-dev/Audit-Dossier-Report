// Audit Dossier Portal — browser app (GitHub Pages + Firebase Auth + Firestore, free Spark plan).
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword,
  updatePassword, EmailAuthProvider, reauthenticateWithCredential,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where, writeBatch, addDoc,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import * as L from './logic.js';
import { firebaseConfig, EMAIL_DOMAIN } from './firebase-config.js';

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

// ------------------------------------------------------------------ state & helpers
const S = { seq: 0, settingUp: false, prof: null, uid: null, isAdmin: false, settings: L.settingsWithDefaults({}), tasks: [], groups: [], users: [], cache: new Map() };
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => Math.round(Number(v) || 0).toLocaleString('en-PK');
const tz = () => L.tzOffset(S.settings);
const today = () => L.todayKey(tz());
const nowText = () => L.nowText(tz());
const opts = () => L.schedOpts(S.settings);
const slug = (lc) => lc.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
const emailFor = (lc, n = 0) => `${slug(lc)}${n ? '.' + n : ''}@${EMAIL_DOMAIN}`;

function toast(msg, type = 'success') {
  const t = $('toast');
  t.className = 'toast border-0 text-white bg-' + type;
  $('toastBody').textContent = msg;
  bootstrap.Toast.getOrCreateInstance(t, { delay: 2800 }).show();
}
function showModal(title, html) {
  $('detailTitle').textContent = title;
  $('detailBody').innerHTML = html;
  bootstrap.Modal.getOrCreateInstance($('detailModal')).show();
}
function fail(e) { console.error(e); toast(friendly(e), 'danger'); }
function friendly(e) {
  const m = String((e && (e.code || e.message)) || e);
  if (m.includes('invalid-credential') || m.includes('wrong-password') || m.includes('user-not-found')) return 'Invalid username or password.';
  if (m.includes('permission-denied') || m.includes('insufficient permissions')) return 'Permission denied.';
  if (m.includes('failed-precondition') && m.includes('index')) return 'Database index is still being built — try again in a few minutes.';
  if (m.includes('weak-password')) return 'Password must be at least 6 characters.';
  if (m.includes('email-already-in-use')) return 'This username already has a login.';
  if (m.includes('too-many-requests')) return 'Too many attempts — wait a minute and try again.';
  return (e && e.message) || m;
}
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  return { path: path || 'tasks', q: Object.fromEntries(new URLSearchParams(qs || '')) };
}
const go = (path, q = {}) => { const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null)).toString(); location.hash = '#/' + path + (s ? '?' + s : ''); };
const link = (path, q = {}) => { const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null)).toString(); return '#/' + path + (s ? '?' + s : ''); };

async function sha1(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const recordId = (r) => sha1(L.recordKey(r.date, r.user, r.branch, r.department, r.checklist, r.task_type));

function exportXlsx(name, headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = headers.map((h, i) => ({ wch: Math.min(60, Math.max(String(h).length, ...rows.slice(0, 500).map((r) => String(r[i] ?? '').length)) + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  XLSX.writeFile(wb, name + '.xlsx');
}
async function log(action, detail = '') {
  try { await addDoc(collection(db, 'logs'), { ts: nowText(), user: S.prof?.username || '', action, detail: String(detail).slice(0, 1500) }); } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------------ data
async function loadSettings() {
  const d = await getDoc(doc(db, 'settings', 'app'));
  S.settings = L.settingsWithDefaults(d.exists() ? d.data().values : {});
}
async function loadTasks() {
  const snap = await getDocs(collection(db, 'tasks'));
  S.tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  S.groups = L.buildGroups(S.tasks);
}
async function loadUsers() {
  const snap = await getDocs(collection(db, 'users'));
  S.users = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => (a.role + a.username).localeCompare(b.role + b.username));
}
const salaries = () => new Map(S.users.map((u) => [u.username_lc, Number(u.salary) || 0]));

/** Records between two dates. Officers only ever read their own. */
async function fetchRecords(start, end, userLc = null, force = false) {
  const lc = S.isAdmin ? (userLc || null) : S.prof.username_lc;
  const key = `${start}|${end}|${lc || '*'}`;
  if (!force && S.cache.has(key)) return S.cache.get(key);
  const cons = [where('date', '>=', start), where('date', '<=', end)];
  if (lc) cons.unshift(where('user_lc', '==', lc));
  const snap = await getDocs(query(collection(db, 'records'), ...cons));
  const recs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  S.cache.set(key, recs);
  return recs;
}
const clearCache = () => S.cache.clear();

// ------------------------------------------------------------------ daily jobs (auto FALSE + monthly snapshot)
async function closePendingDays() {
  const yest = L.addDays(today(), -1);
  const ts = nowText();
  const people = S.isAdmin ? S.users.filter((u) => u.active && u.role !== 'Admin') : [{ ...S.prof, uid: S.uid }];
  const due = people.filter((u) => (u.closed_until || '') < yest);
  if (!due.length) return 0;
  let from = due.map((u) => u.closed_until || L.addDays(yest, -1)).sort()[0];
  if (from < L.addDays(yest, -62)) from = L.addDays(yest, -62);
  const start = L.addDays(from, 1);
  const recs = await fetchRecords(start, yest, S.isAdmin ? null : S.prof.username_lc, true);
  const out = [];
  for (let d = start; d <= yest; d = L.addDays(d, 1)) {
    const users = new Set(due.filter((u) => (u.closed_until || '') < d).map((u) => u.username_lc));
    if (!users.size) continue;
    out.push(...L.missingForDay(S.groups, recs.filter((r) => r.date === d), d, opts(), users, ts));
  }
  for (let i = 0; i < out.length; i += 400) {
    const b = writeBatch(db);
    for (const r of out.slice(i, i + 400)) b.set(doc(db, 'records', await recordId(r)), r);
    await b.commit();
  }
  for (const u of due) await updateDoc(doc(db, 'users', u.uid), { closed_until: yest });
  if (!S.isAdmin) S.prof.closed_until = yest; else due.forEach((u) => { u.closed_until = yest; });
  clearCache();
  return out.length;
}
async function autoMonthly() {
  if (!S.isAdmin) return;
  const t = today();
  const prev = L.addDays(t.slice(0, 8) + '01', -1).slice(0, 7);
  const ex = await getDoc(doc(db, 'monthly', prev));
  if (ex.exists()) return;
  const { start, end } = L.monthBounds(prev);
  const recs = await fetchRecords(start, end, null);
  if (recs.length) await saveMonthly(prev, recs);
}
async function saveMonthly(ym, recs) {
  const m = L.monthly(recs, ym, S.settings, salaries());
  await setDoc(doc(db, 'monthly', ym), {
    month: ym, generated_at: nowText(),
    rows: m.rows.map((u) => ({ user: u.key, total: u.total, done: u.done, missed: u.missed, pct: u.pct, grade: u.grade,
      task_fine: u.task_fine, pct_fine: u.pct_fine, total_fine: u.total_fine, salary: u.salary })),
  });
  return m.rows.length;
}

// ------------------------------------------------------------------ layout
function shell(active, inner) {
  const tab = (id, label, path) => `<li class="nav-item"><a class="nav-link ${active === id ? 'active' : ''}" href="#/${path}">${label}</a></li>`;
  return `<div class="container-fluid py-2">
    <div class="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
      <a href="#/tasks" class="app-title text-dark text-decoration-none">${esc(S.settings.APP_TITLE)}</a>
      <div class="d-flex align-items-center gap-2">
        <span class="muted small">${today()} · ${L.dayName(today())}</span>
        <span class="badge bg-success py-2">User: ${esc(S.prof.username)}${S.isAdmin ? ' (Admin)' : ''}</span>
        <a class="btn btn-sm btn-outline-secondary" href="#/password">Password</a>
        <button class="btn btn-sm btn-outline-danger" id="btnLogout">Logout</button>
      </div>
    </div>
    <ul class="nav nav-tabs mb-2">
      ${tab('tasks', 'Tasks Portal', 'tasks')}${tab('report', 'Reporting', 'report')}${tab('eff', 'Efficiency &amp; Fines', 'eff')}${tab('monthly', 'Monthly Performance', 'monthly')}
      ${S.isAdmin ? tab('admin', 'Task Manager', 'admin/tasks') + tab('users', 'Users', 'users') + tab('settings', 'Settings', 'settings') : ''}
    </ul>
    <div id="main">${inner}</div></div>`;
}
function mount(active, inner) {
  S.seq++;
  $('app').innerHTML = shell(active, inner);
  $('btnLogout').onclick = () => signOut(auth);
}
const loading = '<div class="text-center p-4 muted"><div class="spinner-border spinner-border-sm"></div> Loading…</div>';
function pctBar(p) {
  const c = p >= 85 ? '#198754' : p >= 70 ? '#0d6efd' : p >= 50 ? '#fd7e14' : '#dc3545';
  return `<div class="d-flex align-items-center gap-2"><div class="pct-bar"><div style="width:${Math.min(100, p)}%;background:${c}"></div></div><b style="color:${c}">${p}%</b></div>`;
}
const opt = (list, val, all) => (all ? `<option value="">${esc(all)}</option>` : '') + list.map((x) => `<option ${x === val ? 'selected' : ''}>${esc(x)}</option>`).join('');
const myTasksFilter = (lc) => (g) => !lc || L.norm(g.user) === lc;
function filterOptions() {
  const gs = S.isAdmin ? S.tasks : S.tasks.filter((t) => t.user_lc === S.prof.username_lc);
  const col = (k) => [...new Set(gs.map((t) => t[k]).filter(Boolean))].sort();
  return { users: S.isAdmin ? S.users.map((u) => u.username) : [S.prof.username], departments: col('depart'), branches: col('branch'), task_types: col('task') };
}
function readForm(form) {
  const o = {};
  form.querySelectorAll('[name]').forEach((el) => { o[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
  return o;
}

// ------------------------------------------------------------------ public screens
async function renderLogin(msg = '') {
  const setup = await getDoc(doc(db, 'meta', 'setup')).catch(() => null);
  if (setup && !setup.exists()) return renderSetup();
  $('app').innerHTML = `<div class="login-box panel p-4">
    <h4 class="mb-1">Audit Dossier Portal</h4><div class="muted mb-3">Sign in with your username</div>
    ${msg ? `<div class="alert alert-danger py-2">${esc(msg)}</div>` : ''}
    <form id="lf"><input name="u" class="form-control mb-2" placeholder="Username" autocomplete="username" required autofocus>
    <input name="p" type="password" class="form-control mb-3" placeholder="Password" autocomplete="current-password" required>
    <button class="btn btn-primary w-100" id="lb">Login</button></form></div>`;
  $('lf').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = readForm(ev.target);
    $('lb').disabled = true;
    try {
      const m = await getDoc(doc(db, 'usernames', L.norm(f.u)));
      if (!m.exists()) throw new Error('auth/invalid-credential');
      await signInWithEmailAndPassword(auth, m.data().email, f.p);
    } catch (e) { renderLogin(friendly(e)); }
  };
}
function renderSetup() {
  $('app').innerHTML = `<div class="login-box panel p-4" style="max-width:440px">
    <h4>First-time setup</h4><div class="muted mb-3">Create the <b>Admin</b> login for this portal. This page appears only once.</div>
    <form id="sf"><input name="u" class="form-control mb-2" placeholder="Admin username (e.g. admin)" required>
    <input name="p" type="password" class="form-control mb-2" placeholder="Password (min 6)" minlength="6" required>
    <input name="p2" type="password" class="form-control mb-3" placeholder="Repeat password" minlength="6" required>
    <button class="btn btn-primary w-100" id="sb">Create Admin</button><div id="se" class="text-danger small mt-2"></div></form></div>`;
  $('sf').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = readForm(ev.target);
    if (f.p !== f.p2) { $('se').textContent = 'Passwords do not match.'; return; }
    $('sb').disabled = true;
    S.settingUp = true;
    try {
      const lc = L.norm(f.u);
      const cred = await createUserWithEmailAndPassword(auth, emailFor(lc), f.p);
      const uid = cred.user.uid;
      await setDoc(doc(db, 'users', uid), { username: f.u.trim(), username_lc: lc, email: emailFor(lc), role: 'Admin', salary: 0,
        active: true, created_at: nowText(), last_login: '', closed_until: '', must_change: false });
      await setDoc(doc(db, 'usernames', lc), { email: emailFor(lc), uid });
      await setDoc(doc(db, 'meta', 'setup'), { done: true, at: nowText(), by: uid });
      await setDoc(doc(db, 'settings', 'app'), { values: Object.fromEntries(L.DEFAULT_SETTINGS.map(([k, v]) => [k, v])) });
      S.settingUp = false;
      location.hash = '#/settings';
      boot(cred.user);
    } catch (e) { S.settingUp = false; $('se').textContent = friendly(e); $('sb').disabled = false; }
  };
}

// ------------------------------------------------------------------ tasks portal
async function renderTasks(q) {
  mount('tasks', loading);
  const my = S.seq;
  const tab = q.tab || 'today', val = q.v || '';
  const viewLc = S.isAdmin ? L.norm(q.user || '') : S.prof.username_lc;
  const t = today();
  const recsToday = await fetchRecords(t, t, viewLc || null, true);
  const who = viewLc ? S.groups.find((g) => L.norm(g.user) === viewLc)?.user || q.user || S.prof.username : null;
  let rows = tab === 'today' ? L.todayTasks(S.groups, recsToday, t, opts(), who)
    : L.categoryTasks(S.groups, recsToday, t, opts(), tab, val, who);
  if (!who && tab === 'today') rows = L.todayTasks(S.groups, recsToday, t, opts(), null);
  const st = L.stats(L.todayTasks(S.groups, recsToday, t, opts(), who));
  let mtd = '–', fine = '–';
  if (viewLc && t.slice(8) !== '01') {
    const recs = await fetchRecords(t.slice(0, 8) + '01', L.addDays(t, -1), viewLc);
    const e = L.efficiency(recs, { start: t.slice(0, 8) + '01', end: L.addDays(t, -1), group_by: 'user' }, S.settings, salaries());
    if (e.totals.total) { mtd = e.totals.pct + '%'; fine = money(e.totals.total_fine); }
  }
  if (my !== S.seq) return;            // user already moved to another page
  const { depts, branches } = L.tabs(S.groups, S.settings, S.isAdmin ? null : S.prof.username);
  const qs = S.isAdmin && q.user ? { user: q.user } : {};
  const pill = (k, v, label, cls) => `<a class="btn btn-sm ${tab === k && val === v ? 'btn-' + cls + (cls === 'info' ? ' text-white' : '') : 'btn-outline-' + cls}" href="${link('tasks', { tab: k === 'today' ? '' : k, v, ...qs })}">${esc(label)}</a>`;
  const isAll = S.isAdmin && !viewLc;
  const head = tab === 'today'
    ? ['Company', 'Branch Name', 'Task', 'Depart', 'Check List', 'SOP', 'Target Day / Date', 'Recurrence', ...(S.isAdmin ? ['User'] : []), 'Remarks', 'Mark']
    : ['Depart', 'Check List', 'Task', 'Recurrence', 'Target Day / Date', 'Company', 'Branch Name', 'SOP', ...(S.isAdmin ? ['User'] : []), 'Due Today', 'Remarks', 'Mark'];
  let body = '';
  rows.forEach((r, i) => {
    if (i === 0 || r.bucket !== rows[i - 1].bucket) {
      const n = rows.filter((x) => x.bucket === r.bucket).length;
      body += `<tr class="grp-row" data-bucket="${esc(r.bucket)}"><td colspan="${head.length}">📋 ${esc(r.bucket)} tasks (${n}) ↕ <span class="fw-normal">(click to collapse / expand)</span></td></tr>`;
    }
    const cl = `<button type="button" class="link-btn" data-i="${i}">${esc(r.checklist)}</button>`;
    const sop = r.sop_url ? `<a href="${esc(r.sop_url)}" target="_blank" rel="noopener">${esc(r.sop_name || 'Open SOP')}</a>` : esc(r.sop_name);
    const mark = `<td><input class="form-control form-control-sm remarks-in" value="${esc(r.remarks)}" placeholder="Enter remarks…"></td>
      <td class="text-center"><input type="checkbox" class="form-check-input mark-box" ${r.status ? 'checked' : ''} title="${esc(r.marked_at ? 'Saved ' + r.marked_at : 'Not saved yet')}"></td>`;
    const cls = 'b-' + r.bucket.replace(/[ /]/g, '') + (r.status ? ' row-done' : '');
    body += tab === 'today'
      ? `<tr class="${cls}" data-i="${i}"><td>${esc(r.company)}</td><td>${esc(r.branch)}</td><td><span class="task-badge">${esc(r.task)}</span></td><td>${esc(r.depart)}</td><td>${cl}</td><td>${sop}</td><td>${esc(r.target)}</td><td>${esc(r.recurrence)}</td>${S.isAdmin ? `<td>${esc(r.user)}</td>` : ''}${mark}</tr>`
      : `<tr class="${cls}" data-i="${i}"><td>${esc(r.depart)}</td><td>${cl}</td><td>${esc(r.task)}</td><td>${esc(r.recurrence)}</td><td>${esc(r.target)}</td><td>${esc(r.company)}</td><td>${esc(r.branch)}</td><td>${sop}</td>${S.isAdmin ? `<td>${esc(r.user)}</td>` : ''}<td>${r.due_today ? '<span class="badge bg-primary">Y</span>' : '<span class="muted">N</span>'}</td>${mark}</tr>`;
  });
  const card = (cls, lbl, v, id = '') => `<div class="col-6 col-md-2"><div class="stat-card ${cls}"><div class="lbl">${lbl}</div><div class="val" ${id ? `id="${id}"` : ''}>${v}</div></div></div>`;
  $('main').innerHTML = `<div class="row g-2 mb-2">${card('bg-blue', 'Total Tasks (Today)', st.total, 'cTotal')}${card('bg-teal', 'Completed', st.done, 'cDone')}${card('bg-amber', 'Pending', st.pending, 'cPending')}${card('bg-green', 'Completion Progress', st.pct + '%', 'cPct')}${card('bg-slate', 'This Month Efficiency', mtd)}${card('bg-red', 'This Month Fine (Rs)', fine)}</div>
    <div class="d-flex flex-wrap justify-content-between align-items-start">
      <div class="pill-bar">${pill('today', '', 'Todays Task', 'dark')}${depts.map((d) => pill('dept', d, d, 'primary')).join('')}${branches.map((b) => pill('branch', b, 'Branch: ' + b, 'info')).join('')}</div>
      <div class="d-flex gap-2 mb-2">${S.isAdmin ? `<select id="viewAs" class="form-select form-select-sm" title="View as"><option value="">All users</option>${opt(S.users.filter((u) => u.active).map((u) => u.username), q.user || '')}</select>` : ''}
        <button class="btn btn-sm btn-success text-nowrap" id="btnExp">⬇ Export Excel</button></div>
    </div>
    <div class="panel"><div class="table-wrap">${rows.length ? `<table class="table table-bordered table-striped table-hover table-sm tbl mb-0"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`
      : `<div class="text-center p-4 muted">${tab === 'today' ? 'No task due today 🎉' : 'No tasks in this tab.'}</div>`}</div></div>`;
  if ($('viewAs')) $('viewAs').onchange = (e) => go('tasks', { tab: tab === 'today' ? '' : tab, v: val, user: e.target.value });
  $('btnExp').onclick = () => exportXlsx(tab === 'today' ? 'Todays_Task_' + t : val + '_Tasks',
    ['Group', 'Company', 'Branch', 'Department', 'Check List', 'Details', 'Task', 'Recurrence', 'Target Day / Date', 'SOP', 'SOP Link', 'User', 'Status', 'Remarks'],
    rows.map((r) => [r.bucket, r.company, r.branch, r.depart, r.checklist, r.details.map((d, k) => `${k + 1}. ${d}`).join('\n'), r.task, r.recurrence, r.target, r.sop_name, r.sop_url, r.user, r.status == null ? '' : (r.status ? 'TRUE' : 'FALSE'), r.remarks]));
  const main = $('main');
  main.onclick = (ev) => {
    const b = ev.target.closest('.link-btn');
    if (b) {
      const r = rows[+b.dataset.i];
      showModal(r.checklist, `<div class="small muted mb-2">${esc(`${r.depart} · ${r.task} · ${r.recurrence} (${r.target}) · ${r.company} / ${r.branch} · User: ${r.user}${r.start_time ? ` · ${r.start_time} – ${r.end_time}` : ''}`)}</div>`
        + (r.details.length ? r.details.map((d, k) => `<div class="detail-item"><b>${k + 1}.</b> ${esc(d)}</div>`).join('') : '<div class="muted">No detail written.</div>')
        + (r.sop_url ? `<div class="mt-2">SOP: <a target="_blank" rel="noopener" href="${esc(r.sop_url)}">${esc(r.sop_name || r.sop_url)}</a></div>` : r.sop_name ? `<div class="mt-2">SOP: ${esc(r.sop_name)}</div>` : '')
        + (r.checklist_url ? `<div class="mt-1"><a target="_blank" rel="noopener" href="${esc(r.checklist_url)}">Open linked check list</a></div>` : ''));
      return;
    }
    const grp = ev.target.closest('.grp-row');
    if (grp) main.querySelectorAll('tr.b-' + grp.dataset.bucket.replace(/[ /]/g, '')).forEach((tr) => tr.classList.toggle('d-none'));
  };
  main.onchange = async (ev) => {
    const tr = ev.target.closest('tr[data-i]');
    if (!tr) return;
    const r = rows[+tr.dataset.i];
    const box = tr.querySelector('.mark-box'), rem = tr.querySelector('.remarks-in');
    const fromBox = ev.target === box;
    tr.classList.add('saving');
    try {
      const due = L.isScheduled(r, t, opts());
      const source = S.isAdmin && L.norm(r.user) !== S.prof.username_lc ? 'Admin' : (due ? 'Portal' : 'Extra');
      const rec = L.makeRecord(r, t, r.user, box.checked, rem.value, source, nowText());
      await setDoc(doc(db, 'records', await recordId(rec)), rec);
      r.status = box.checked; r.remarks = rem.value;
      tr.classList.toggle('row-done', box.checked);
      box.title = 'Saved ' + rec.timestamp;
      toast((box.checked ? '✔ TRUE' : '✖ FALSE') + ' saved' + (source === 'Extra' ? ' (not due today)' : ''), box.checked ? 'success' : 'secondary');
      if (tab === 'today') {
        const s2 = L.stats(rows);
        $('cDone').textContent = s2.done; $('cPending').textContent = s2.pending; $('cPct').textContent = s2.pct + '%';
      }
      clearCache();
    } catch (e) { if (fromBox) box.checked = !box.checked; fail(e); } finally { tr.classList.remove('saving'); }
  };
}

// ------------------------------------------------------------------ reports
function filterBar(f, extra = '') {
  const o = filterOptions();
  return `<div class="col-md-2"><label class="form-label small fw-bold">Start Date</label><input type="date" name="start" value="${f.start}" class="form-control form-control-sm"></div>
    <div class="col-md-2"><label class="form-label small fw-bold">End Date</label><input type="date" name="end" value="${f.end}" class="form-control form-control-sm"></div>
    ${S.isAdmin ? `<div class="col-md-2"><label class="form-label small fw-bold">User</label><select name="user" class="form-select form-select-sm">${opt(o.users, f.user, 'All users')}</select></div>` : ''}
    <div class="col-md-2"><label class="form-label small fw-bold">Department</label><select name="department" class="form-select form-select-sm">${opt(o.departments, f.department, 'All departments')}</select></div>
    <div class="col-md-2"><label class="form-label small fw-bold">Branch</label><select name="branch" class="form-select form-select-sm">${opt(o.branches, f.branch, 'All branches')}</select></div>${extra}`;
}
const defF = (q, start) => ({ start: q.start || start || today(), end: q.end || today(), status: q.status || 'ALL', user: q.user || '',
  department: q.department || '', branch: q.branch || '', task_type: q.task_type || '', checklist: q.checklist || '', source: q.source || '', group_by: q.group_by || 'user' });

async function renderReport(q) {
  const f = defF(q);
  const o = filterOptions();
  mount('report', `<form id="rf" class="panel"><div class="d-flex justify-content-between align-items-center mb-2"><h5 class="m-0">Performance Reporting</h5><button type="button" class="btn btn-success btn-sm" id="btnExp">⬇ Export Excel</button></div>
    <div class="row g-2"><div class="col-md-2"><label class="form-label small fw-bold">Status</label><select name="status" class="form-select form-select-sm">
      ${[['ALL', 'All'], ['TRUE', 'TRUE (Done)'], ['FALSE', 'FALSE (Not done)']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    ${filterBar(f, `<div class="col-md-3"><label class="form-label small fw-bold">Task Type</label><select name="task_type" class="form-select form-select-sm">${opt(o.task_types, f.task_type, 'All task types')}</select></div>
      <div class="col-md-3"><label class="form-label small fw-bold">Check List contains</label><input name="checklist" value="${esc(f.checklist)}" class="form-control form-control-sm"></div>
      <div class="col-md-2"><label class="form-label small fw-bold">Source</label><select name="source" class="form-select form-select-sm">${opt(['Portal', 'Auto-Closed', 'Admin', 'Extra', 'Imported'], f.source, 'All')}</select></div>`)}</div>
    <button class="btn btn-primary w-100 mt-2 btn-sm">Generate Report</button></form><div class="panel" id="out">${q.start ? loading : '<div class="muted p-3">Choose filters and press Generate Report.</div>'}</div>`);
  $('rf').onsubmit = (ev) => { ev.preventDefault(); go('report', readForm(ev.target)); };
  let rows = [];
  $('btnExp').onclick = () => exportXlsx(`Report_${f.start}_to_${f.end}`, ['Date', 'User', 'Company', 'Branch', 'Department', 'Check List', 'To-Do', 'Task Type', 'Status', 'Remarks', 'Timestamp', 'Source'],
    rows.map((r) => [r.date, r.user, r.company, r.branch, r.department, r.checklist, r.todo, r.task_type, r.status ? 'TRUE' : 'FALSE', r.remarks, r.timestamp, r.source]));
  if (!q.start) return;
  const my = S.seq;
  const recs = await fetchRecords(f.start, f.end, S.isAdmin ? L.norm(f.user) : null, true);
  if (my !== S.seq) return;
  rows = L.filterRecords(recs, f, S.isAdmin ? null : S.prof.username).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.user.localeCompare(b.user)));
  const tr = rows.filter((r) => r.status).length;
  $('out').innerHTML = `<div class="mb-2"><span class="badge bg-secondary">Records: ${rows.length}</span> <span class="badge bg-success">TRUE: ${tr}</span> <span class="badge bg-danger">FALSE: ${rows.length - tr}</span>
    ${f.status === 'ALL' && rows.length ? `<span class="badge bg-primary">Efficiency: ${Math.round(tr * 1000 / rows.length) / 10}%</span>` : ''}</div>
    <div class="table-wrap">${rows.length ? `<table class="table table-sm table-striped table-bordered tbl mb-0"><thead><tr><th>Date</th><th>User</th><th>Company</th><th>Branch</th><th>Department</th><th>Check List</th><th>Task Type</th><th>Status</th><th>Remarks</th><th>Timestamp</th><th>Source</th>${S.isAdmin ? '<th>Edit</th>' : ''}</tr></thead><tbody>
    ${rows.slice(0, 3000).map((r, i) => `<tr><td class="text-nowrap">${r.date}</td><td>${esc(r.user)}</td><td>${esc(r.company)}</td><td>${esc(r.branch)}</td><td>${esc(r.department)}</td><td title="${esc(r.todo)}">${esc(r.checklist)}</td><td>${esc(r.task_type)}</td>
      <td>${r.status ? '<span class="badge bg-success">TRUE</span>' : '<span class="badge bg-danger">FALSE</span>'}</td><td>${esc(r.remarks)}</td><td class="small text-nowrap">${esc(r.timestamp)}</td><td class="small">${esc(r.source)}</td>
      ${S.isAdmin ? `<td><div class="d-flex gap-1" data-i="${i}"><select class="form-select form-select-sm py-0 es" style="width:80px"><option value="1" ${r.status ? 'selected' : ''}>TRUE</option><option value="0" ${r.status ? '' : 'selected'}>FALSE</option></select><input class="form-control form-control-sm py-0 er" style="width:120px" value="${esc(r.remarks)}"><button class="btn btn-sm btn-outline-secondary py-0 eb">Save</button></div></td>` : ''}</tr>`).join('')}
    </tbody></table>${rows.length > 3000 ? '<div class="small muted p-2">Showing first 3000 rows — Export Excel has all of them.</div>' : ''}` : '<div class="text-center p-4 muted">No records for this filter.</div>'}</div>`;
  $('out').onclick = async (ev) => {
    const b = ev.target.closest('.eb'); if (!b) return;
    const box = b.closest('[data-i]'); const r = rows[+box.dataset.i];
    try {
      await updateDoc(doc(db, 'records', r.id), { status: +box.querySelector('.es').value, remarks: box.querySelector('.er').value, source: 'Admin', timestamp: nowText() });
      log('EDIT_RECORD', r.id); clearCache(); toast('Record updated');
    } catch (e) { fail(e); }
  };
}

async function renderEff(q) {
  const t = today();
  const f = defF(q, t.slice(0, 8) + '01');
  const y = L.addDays(t, -1), ms = t.slice(0, 8) + '01', lme = L.addDays(ms, -1);
  const quick = (l, s, e) => `<a class="btn btn-outline-secondary btn-sm" href="${link('eff', { ...f, start: s, end: e })}">${l}</a>`;
  mount('eff', `<form id="ef" class="panel"><div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2"><h5 class="m-0">Efficiency &amp; Fine Report</h5>
    <div class="d-flex gap-1 flex-wrap">${quick('Yesterday', y, y)}${quick('Last 7 days', L.addDays(t, -7), y)}${quick('This month', ms, t)}${quick('Last month', lme.slice(0, 8) + '01', lme)}<button type="button" class="btn btn-success btn-sm" id="btnExp">⬇ Export Excel</button></div></div>
    <div class="row g-2">${filterBar(f, `<div class="col-md-2"><label class="form-label small fw-bold">Group by</label><select name="group_by" class="form-select form-select-sm">
      ${[['user', 'User'], ['department', 'Department'], ['checklist', 'Check List'], ['branch', 'Branch'], ['task_type', 'Task Type'], ['date', 'Date']].map(([v, l]) => `<option value="${v}" ${f.group_by === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`)}</div>
    <button class="btn btn-primary w-100 mt-2 btn-sm">Generate</button>
    <div class="small muted mt-1">Efficiency % = TRUE ÷ (TRUE + FALSE). Unmarked tasks are saved as FALSE automatically the next day. Tasks ticked on a day they were not due ("Extra") are not counted.</div></form>
    <div class="panel" id="out">${loading}</div>`);
  $('ef').onsubmit = (ev) => { ev.preventDefault(); go('eff', readForm(ev.target)); };
  const my = S.seq;
  const recs = await fetchRecords(f.start, f.end, S.isAdmin ? L.norm(f.user) : null);
  if (my !== S.seq) return;
  const d = L.efficiency(recs, f, S.settings, salaries(), S.isAdmin ? null : S.prof.username);
  $('btnExp').onclick = () => exportXlsx(`Efficiency_${f.start}_to_${f.end}`, [d.group_by, 'Scheduled', 'Done (TRUE)', 'Missed (FALSE)', 'Efficiency %', 'Grade', 'Per-task Fine', 'Salary', 'Deduct %', '% Fine', 'Total Fine'],
    d.rows.map((r) => [r.key, r.total, r.done, r.missed, r.pct, r.grade, r.task_fine, r.salary, r.deduct_pct, r.pct_fine, r.total_fine]));
  $('out').innerHTML = `<div class="mb-2"><span class="badge bg-secondary">Scheduled: ${d.totals.total}</span> <span class="badge bg-success">Done: ${d.totals.done}</span> <span class="badge bg-danger">Missed: ${d.totals.missed}</span> <span class="badge bg-primary">Efficiency: ${d.totals.pct}%</span> <span class="badge bg-dark">Total fine: Rs ${money(d.totals.total_fine)}</span> <span class="small muted">Fine mode: ${esc(d.mode)}</span></div>
    <div class="table-wrap">${d.rows.length ? `<table class="table table-sm table-bordered table-hover tbl mb-0"><thead><tr><th>${esc(d.group_by.replace('_', ' '))}</th><th>Scheduled</th><th>Done (TRUE)</th><th>Missed (FALSE)</th><th style="min-width:170px">Efficiency</th><th>Grade</th><th>Per-task Fine</th>${d.show_pct ? '<th>Salary</th><th>Deduct %</th><th>% Fine</th>' : ''}<th>Total Fine</th></tr></thead><tbody>
    ${d.rows.map((g) => `<tr><td>${esc(g.key)}</td><td>${g.total}</td><td class="text-success">${g.done}</td><td class="text-danger">${g.missed}</td><td>${pctBar(g.pct)}</td><td class="grade">${esc(g.grade)}</td><td>${money(g.task_fine)}</td>${d.show_pct ? `<td>${money(g.salary)}</td><td>${g.deduct_pct}%</td><td>${money(g.pct_fine)}</td>` : ''}<td><b>${money(g.total_fine)}</b></td></tr>`).join('')}
    </tbody></table>` : '<div class="text-center p-4 muted">No records in this range.</div>'}</div>`;
}

async function renderMonthly(q) {
  const ym = q.month || today().slice(0, 7);
  const viewLc = S.isAdmin ? L.norm(q.user || '') : S.prof.username_lc;
  mount('monthly', `<div class="panel"><div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2"><h5 class="m-0">Monthly Performance</h5>
    <div class="d-flex gap-1">${S.isAdmin ? '<button class="btn btn-outline-dark btn-sm" id="btnSave">💾 Save month-end snapshot</button>' : ''}<button class="btn btn-success btn-sm" id="btnExp">⬇ Export Excel</button></div></div>
    <form id="mf" class="row g-2 align-items-end"><div class="col-md-2"><label class="form-label small fw-bold">Month</label><input type="month" name="month" value="${ym}" class="form-control form-control-sm"></div>
    ${S.isAdmin ? `<div class="col-md-2"><label class="form-label small fw-bold">User</label><select name="user" class="form-select form-select-sm">${opt(S.users.map((u) => u.username), q.user || '', 'All users')}</select></div>` : ''}
    <div class="col-md-2"><button class="btn btn-primary btn-sm w-100">Show</button></div><div class="col-md-6 small muted" id="mInfo"></div></form></div>
    <div class="panel"><div class="table-wrap" id="out">${loading}</div></div>`);
  $('mf').onsubmit = (ev) => { ev.preventDefault(); go('monthly', readForm(ev.target)); };
  const { start, end } = L.monthBounds(ym);
  const my = S.seq;
  const recs = await fetchRecords(start, end, viewLc || null);
  const m = L.monthly(recs, ym, S.settings, salaries(), viewLc ? (S.users.find((u) => u.username_lc === viewLc)?.username || S.prof.username) : null);
  const snap = await getDoc(doc(db, 'monthly', ym)).catch(() => null);
  if (my !== S.seq) return;
  $('mInfo').innerHTML = `Fine mode: <b>${esc(m.mode)}</b> · ${snap && snap.exists() ? 'Month-end snapshot saved on ' + esc(snap.data().generated_at) : 'Snapshot saves automatically on the 1st of next month'}`;
  if ($('btnSave')) $('btnSave').onclick = async () => {
    if (!confirm(`Save / overwrite the month-end snapshot of ${ym}?`)) return;
    try { const all = await fetchRecords(start, end, null, true); const n = await saveMonthly(ym, all); log('SAVE_MONTHLY', ym); toast(`Saved ${n} users`); renderMonthly(q); } catch (e) { fail(e); }
  };
  $('btnExp').onclick = () => {
    const rows = [];
    m.rows.forEach((u) => {
      rows.push([ym, u.key, 'ALL', u.total, u.done, u.missed, u.pct, u.grade, u.salary, u.task_fine, u.deduct_pct, u.pct_fine, u.total_fine]);
      u.departments.forEach((d) => rows.push([ym, u.key, d.department, d.total, d.done, d.missed, d.pct, '', '', '', '', '', '']));
    });
    exportXlsx('Monthly_Performance_' + ym, ['Month', 'User', 'Department', 'Scheduled', 'Done', 'Missed', 'Efficiency %', 'Grade', 'Salary', 'Per-task Fine', 'Deduct %', '% Fine', 'Total Fine'], rows);
  };
  $('out').innerHTML = m.rows.length ? `<table class="table table-sm table-bordered table-hover tbl mb-0"><thead><tr><th>#</th><th>User</th><th>Scheduled</th><th>Done</th><th>Missed</th><th style="min-width:170px">Efficiency</th><th>Grade</th><th>Salary</th><th>Per-task Fine</th><th>Deduct %</th><th>% Fine</th><th>Total Fine</th><th></th></tr></thead><tbody>
    ${m.rows.map((u, i) => `<tr><td>${i + 1}</td><td><b>${esc(u.key)}</b></td><td>${u.total}</td><td class="text-success">${u.done}</td><td class="text-danger">${u.missed}</td><td>${pctBar(u.pct)}</td><td class="grade">${esc(u.grade)}</td><td>${money(u.salary)}</td><td>${money(u.task_fine)}</td><td>${u.deduct_pct}%</td><td>${money(u.pct_fine)}</td><td><b>${money(u.total_fine)}</b></td><td><button class="btn btn-sm btn-outline-primary py-0" data-i="${i}">Details</button></td></tr>`).join('')}
    </tbody></table>` : '<div class="text-center p-4 muted">No records for this month.</div>';
  $('out').onclick = (ev) => {
    const b = ev.target.closest('[data-i]'); if (!b) return;
    const u = m.rows[+b.dataset.i];
    showModal(`${u.key} — ${ym}`, `<h6>Department wise</h6><table class="table table-sm table-bordered"><thead><tr><th>Department</th><th>Scheduled</th><th>Done</th><th>Missed</th><th>Efficiency</th></tr></thead><tbody>
      ${u.departments.map((d) => `<tr><td>${esc(d.department)}</td><td>${d.total}</td><td>${d.done}</td><td>${d.missed}</td><td>${pctBar(d.pct)}</td></tr>`).join('')}</tbody></table>
      <h6>Tasks not done (${u.missed_list.length})</h6><table class="table table-sm table-striped"><thead><tr><th>Date</th><th>Department</th><th>Check List</th><th>Task</th><th>Remarks</th></tr></thead><tbody>
      ${u.missed_list.map((x) => `<tr><td class="text-nowrap">${x.date}</td><td>${esc(x.department)}</td><td>${esc(x.checklist)}</td><td>${esc(x.task_type)}</td><td>${esc(x.remarks)}</td></tr>`).join('')}</tbody></table>`);
  };
}

// ------------------------------------------------------------------ admin: tasks
function renderAdminTasks(q) {
  const show = q.show || 'active';
  const t = today();
  const Ls = L.listings(S.tasks, S.users.map((u) => u.username));
  const list = [...S.tasks].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).filter((x) => {
    const due = L.isScheduled(x, t, opts());
    if (show === 'active' && x.hidden) return false;
    if (show === 'hidden' && !x.hidden) return false;
    if (show === 'today' && (x.hidden || !due)) return false;
    if (q.dept && x.depart !== q.dept) return false;
    if (q.branch && x.branch !== q.branch) return false;
    if (q.user && L.norm(x.user) !== L.norm(q.user)) return false;
    if (q.q && !L.norm([x.checklist, x.detail, x.task, x.user, x.depart, x.sop_name].join(' ')).includes(L.norm(q.q))) return false;
    return true;
  });
  mount('admin', `<div class="panel"><form id="tf" class="d-flex flex-wrap gap-2 align-items-center">
      <a class="btn btn-primary btn-sm" href="#/admin/task">＋ Add New Task</a>
      <input name="q" value="${esc(q.q || '')}" class="form-control form-control-sm" style="max-width:240px" placeholder="Search check list / detail / user / SOP…">
      <select name="dept" class="form-select form-select-sm" style="width:auto">${opt(Ls.depart, q.dept || '', 'All departments')}</select>
      <select name="branch" class="form-select form-select-sm" style="width:auto">${opt(Ls.branch, q.branch || '', 'All branches')}</select>
      <select name="user" class="form-select form-select-sm" style="width:auto">${opt(Ls.user, q.user || '', 'All users')}</select>
      <select name="show" class="form-select form-select-sm" style="width:auto">${[['active', 'Active tasks'], ['hidden', 'Hidden tasks'], ['today', 'Due today (Y)'], ['all', 'All']].map(([v, l]) => `<option value="${v}" ${show === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn btn-outline-primary btn-sm">Filter</button><span class="muted small">${list.length} of ${S.tasks.length} rows</span></form>
      <div class="small muted mt-1">One row = one check-list point. Rows with the same Check List, Task, Branch and User show as one line in the portal. Use <b>＋ Point</b> to add another point to the same check list.</div></div>
    <div class="panel"><div class="d-flex gap-2 mb-2"><button class="btn btn-sm btn-outline-warning" data-act="hide">Hide selected</button><button class="btn btn-sm btn-outline-success" data-act="unhide">Unhide selected</button><button class="btn btn-sm btn-outline-danger" data-act="delete">Delete selected</button></div>
    <div class="table-wrap"><table class="table table-sm table-bordered table-hover tbl mb-0"><thead><tr><th><input type="checkbox" id="selAll" class="form-check-input"></th><th>Today</th><th>Depart</th><th>Check List</th><th>Detail</th><th>Task</th><th>User</th><th>Recurrence</th><th>Target</th><th>Company</th><th>Branch</th><th>SOP</th><th>Status</th><th style="min-width:120px"></th></tr></thead><tbody>
    ${list.slice(0, 2000).map((x) => `<tr class="${x.hidden ? 'hidden-row' : ''}"><td><input type="checkbox" class="form-check-input sel" value="${x.id}"></td><td>${L.isScheduled(x, t, opts()) && !x.hidden ? '<span class="badge bg-primary">Y</span>' : 'N'}</td>
      <td>${esc(x.depart)}</td><td>${esc(x.checklist)}</td><td class="small">${esc(x.detail)}</td><td>${esc(x.task)}</td><td>${esc(x.user)}</td><td>${esc(x.recurrence)}</td><td>${esc(x.target)}${x.target_month ? ' / M' + esc(x.target_month) : ''}</td><td>${esc(x.company)}</td><td>${esc(x.branch)}</td>
      <td>${x.sop_url ? `<a href="${esc(x.sop_url)}" target="_blank" rel="noopener">${esc(x.sop_name || 'Link')}</a>` : esc(x.sop_name)}</td>
      <td>${x.hidden ? '<span class="badge bg-secondary">Hidden</span>' : '<span class="badge bg-success">Active</span>'}</td>
      <td class="text-nowrap"><a class="btn btn-sm btn-outline-primary py-0" href="#/admin/task?id=${x.id}">Edit</a> <a class="btn btn-sm btn-outline-secondary py-0" href="#/admin/task?copy=${x.id}" title="Add another point to this check list">＋ Point</a></td></tr>`).join('')}
    </tbody></table></div></div>`);
  $('tf').onsubmit = (ev) => { ev.preventDefault(); go('admin/tasks', readForm(ev.target)); };
  $('selAll').onchange = (e) => document.querySelectorAll('.sel').forEach((c) => { c.checked = e.target.checked; });
  document.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const ids = [...document.querySelectorAll('.sel:checked')].map((c) => c.value);
      if (!ids.length) return toast('Select task rows first', 'warning');
      const act = b.dataset.act;
      if (act === 'delete' && !confirm(`Delete ${ids.length} task row(s) permanently? (Saved TRUE/FALSE history stays.)`)) return;
      try {
        const bt = writeBatch(db);
        ids.forEach((id) => (act === 'delete' ? bt.delete(doc(db, 'tasks', id)) : bt.update(doc(db, 'tasks', id), { hidden: act === 'hide' })));
        await bt.commit();
        log(act.toUpperCase() + '_TASK', ids.join(','));
        await loadTasks();
        toast(`${ids.length} row(s): ${act}`);
        renderAdminTasks(q);
      } catch (e) { fail(e); }
    };
  });
}

function renderTaskForm(q) {
  const edit = q.id ? S.tasks.find((x) => x.id === q.id) : null;
  const src = edit || (q.copy ? S.tasks.find((x) => x.id === q.copy) : null);
  const t = src ? { ...src, detail: edit ? src.detail : '' } : { company: 'RC', branch: 'RC', recurrence: 'Daily', target: 'Daily', audit_type: 'Post-Audit' };
  const Ls = L.listings(S.tasks, S.users.map((u) => u.username));
  const field = (name, label, cols = 3, list = null, type = 'text', req = false, ph = '') => `<div class="col-md-${cols}"><label class="form-label small fw-bold">${label}${req ? ' *' : ''}</label>
    <input name="${name}" type="${type}" value="${esc(t[name] ?? '')}" class="form-control form-control-sm" ${list ? `list="dl_${list}"` : ''} ${req ? 'required' : ''} placeholder="${esc(ph)}" autocomplete="off"></div>`;
  mount('admin', `<form id="tf" class="panel"><h5>${edit ? 'Edit Task' : 'Add New Task'}</h5><div class="row g-2">
    ${field('depart', 'Department', 3, 'depart', 'text', true)}${field('checklist', 'Check List', 5, 'checklist', 'text', true)}${field('task', 'Task', 4, 'task', 'text', true, 'Daily Followup, Weekly Round, Accounts Batch…')}
    <div class="col-12"><label class="form-label small fw-bold">Check list Detail (point)</label><textarea name="detail" rows="2" class="form-control form-control-sm">${esc(t.detail || '')}</textarea></div>
    ${field('user', 'User (assigned to)', 2, 'user', 'text', true)}${field('company', 'Company', 2, 'company', 'text', true)}${field('branch', 'Branch', 2, 'branch', 'text', true)}${field('audit_type', 'Pre / Post Audit', 2, 'audit_type')}
    ${field('recurrence', 'Recurrence', 2, 'recurrence', 'text', true)}${field('target', 'Target Day / Date', 2, 'target', 'text', true)}${field('target_month', 'Target Month (Qtr / Yearly)', 2, null, 'number')}
    ${field('start_time', 'Start Time', 2, null, 'time')}${field('end_time', 'End Time', 2, null, 'time')}${field('ordered_by', 'Ordered By', 2)}${field('remarks', 'Remarks', 4)}</div>
    <div class="border rounded p-2 mt-3 bg-light"><div class="small fw-bold mb-1">SOP / Links <span class="muted fw-normal">(optional — leave blank if there is no SOP)</span></div><div class="row g-2">
      ${field('sop_name', 'SOP name', 4, null, 'text', false, 'e.g. Bilty receiving (WH / Receipt room)')}${field('sop_url', 'SOP link', 4, null, 'text', false, 'https://docs.google.com/…')}${field('checklist_url', 'Check list document link', 4, null, 'text', false, 'optional')}</div></div>
    <div class="form-check mt-2"><input class="form-check-input" type="checkbox" name="hidden" id="hid" ${t.hidden ? 'checked' : ''}><label class="form-check-label" for="hid">Hide this task (it disappears from every tab; history is kept)</label></div>
    <div class="small muted mt-2"><b>Target Day / Date:</b> <code>Daily</code> = every day · <code>Mon … Sun</code> = weekly on that day · <code>1 – 31</code> = that date every month (one day earlier if it falls on Friday) · <code>Triggered</code> = never in Today's list, only in its department tab. Friday is off except for company RCG.</div>
    <div id="terr" class="text-danger small mt-2"></div>
    <div class="d-flex gap-2 mt-3"><button class="btn btn-primary btn-sm" name="go" value="save">Save</button>${edit ? '' : '<button class="btn btn-outline-primary btn-sm" name="go" value="again">Save &amp; add another point</button>'}<a class="btn btn-secondary btn-sm" href="#/admin/tasks">Cancel</a></div></form>
    ${Object.entries(Ls).map(([k, v]) => `<datalist id="dl_${k}">${v.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`).join('')}`);
  $('tf').onsubmit = async (ev) => {
    ev.preventDefault();
    const again = ev.submitter && ev.submitter.value === 'again';
    try {
      const c = L.cleanTask(readForm(ev.target));
      const ts = nowText();
      let id = edit?.id;
      if (edit) {
        await updateDoc(doc(db, 'tasks', id), { ...c, updated_by: S.prof.username, updated_at: ts });
        log('EDIT_TASK', `${id} ${c.checklist}`);
      } else {
        const order = Math.max(0, ...S.tasks.map((x) => x.sort_order || 0)) + 1;
        const ref = await addDoc(collection(db, 'tasks'), { ...c, sort_order: order, created_by: S.prof.username, created_at: ts, updated_by: S.prof.username, updated_at: ts });
        id = ref.id;
        log('ADD_TASK', `${id} ${c.checklist}`);
      }
      await loadTasks();
      toast('Task saved');
      if (again) { location.hash = '#/admin/task?copy=' + id + '&n=' + Date.now(); } else go('admin/tasks');
    } catch (e) { $('terr').textContent = friendly(e); }
  };
}

// ------------------------------------------------------------------ admin: users
async function createLogin(username, password, extra = {}) {
  const lc = L.norm(username);
  const existing = await getDoc(doc(db, 'usernames', lc));
  const n = existing.exists() ? (Number(existing.data().n) || 0) + 1 : 0;
  const email = emailFor(lc, n);
  const tmp = initializeApp(firebaseConfig, 'tmp' + Date.now());
  try {
    const cred = await createUserWithEmailAndPassword(getAuth(tmp), email, password);
    const uid = cred.user.uid;
    await signOut(getAuth(tmp));
    const prev = existing.exists() ? existing.data().uid : null;
    const old = prev ? (await getDoc(doc(db, 'users', prev))).data() || {} : {};
    await setDoc(doc(db, 'users', uid), {
      username: old.username || username.trim(), username_lc: lc, email, role: old.role || extra.role || 'Officer',
      salary: old.salary ?? (Number(extra.salary) || 0), active: true, created_at: nowText(), last_login: '',
      closed_until: old.closed_until || extra.closed_until || L.addDays(today(), -1), must_change: extra.must_change ?? true,
    });
    await setDoc(doc(db, 'usernames', lc), { email, uid, n });
    if (prev) await updateDoc(doc(db, 'users', prev), { active: false, replaced_by: uid });
    return uid;
  } finally { await deleteApp(tmp); }
}

async function renderUsers() {
  await loadUsers();
  const known = new Set(S.users.map((u) => u.username_lc));
  const missing = [...new Set(S.tasks.map((t) => t.user).filter((u) => u && !known.has(L.norm(u))))];
  const cnt = (lc) => S.tasks.filter((t) => t.user_lc === lc && !t.hidden).length;
  const live = S.users.filter((u) => !u.replaced_by);
  mount('users', `<div class="row g-2"><div class="col-lg-8"><div class="panel"><h6>Users</h6>
    ${missing.length ? `<div class="alert alert-warning py-2 small">Tasks are assigned to names that have no login: <b>${esc(missing.join(', '))}</b>. Add them on the right.</div>` : ''}
    <div class="table-wrap"><table class="table table-sm table-bordered tbl mb-0"><thead><tr><th>Username</th><th>Role</th><th>Monthly Salary</th><th>Active</th><th>Active tasks</th><th>Last login</th><th></th></tr></thead><tbody>
    ${live.map((u, i) => `<tr class="${u.active ? '' : 'hidden-row'}"><td><b>${esc(u.username)}</b></td><td>${esc(u.role)}</td><td>${money(u.salary)}</td><td>${u.active ? 'Y' : 'N'}</td><td>${cnt(u.username_lc)}</td><td class="small">${esc(u.last_login || '')}</td><td><button class="btn btn-sm btn-outline-primary py-0" data-i="${i}">Edit</button></td></tr>`).join('')}
    </tbody></table></div></div></div>
    <div class="col-lg-4"><form class="panel" id="uf"><h6 id="ufT">Add User</h6>
      <label class="form-label small fw-bold">Username (same name used in tasks)</label><input name="username" class="form-control form-control-sm mb-2" required>
      <label class="form-label small fw-bold">Role</label><select name="role" class="form-select form-select-sm mb-2"><option>Officer</option><option>Admin</option></select>
      <label class="form-label small fw-bold">Monthly Salary (for % fine)</label><input name="salary" type="number" min="0" class="form-control form-control-sm mb-2">
      <label class="form-label small fw-bold">Password <span class="muted" id="pwHint">(min 6 — user changes it at first login)</span></label><input name="password" class="form-control form-control-sm mb-2" minlength="6">
      <div class="form-check mb-2"><input class="form-check-input" type="checkbox" name="active" id="ufA" checked><label for="ufA" class="form-check-label">Active</label></div>
      <button class="btn btn-primary btn-sm">Save User</button> <button type="button" class="btn btn-outline-secondary btn-sm" id="ufNew">New</button>
      <div id="uerr" class="text-danger small mt-2"></div></form></div></div>`);
  let editing = null;
  const f = $('uf');
  $('main').onclick = (ev) => {
    const b = ev.target.closest('[data-i]'); if (!b) return;
    editing = live[+b.dataset.i];
    f.username.value = editing.username; f.username.readOnly = true; f.role.value = editing.role; f.salary.value = editing.salary || 0; f.active.checked = !!editing.active; f.password.value = '';
    $('ufT').textContent = 'Edit ' + editing.username; $('pwHint').textContent = '(blank = keep; filled = reset password)';
  };
  $('ufNew').onclick = () => renderUsers();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const v = readForm(f);
    try {
      if (editing) {
        if (editing.uid === S.uid && (v.role !== 'Admin' || !v.active)) throw new Error('You cannot remove your own Admin access.');
        await updateDoc(doc(db, 'users', editing.uid), { role: v.role, salary: Number(v.salary) || 0, active: !!v.active });
        if (v.password) await createLogin(editing.username, v.password, { must_change: true });
        log('SAVE_USER', editing.username);
        toast(v.password ? 'User updated and password reset' : 'User updated');
      } else {
        if (!v.password || v.password.length < 6) throw new Error('Password (min 6) is required for a new user.');
        if (known.has(L.norm(v.username))) throw new Error('This username already exists — click Edit instead.');
        await createLogin(v.username, v.password, { role: v.role, salary: v.salary, must_change: true });
        log('ADD_USER', v.username);
        toast('User created');
      }
      renderUsers();
    } catch (e) { $('uerr').textContent = friendly(e); }
  };
}

// ------------------------------------------------------------------ admin: settings, import, backup
function renderSettings() {
  mount('settings', `<div class="row g-2"><div class="col-lg-8"><form class="panel" id="sf"><h6>Fines, grades &amp; rules</h6>
    <table class="table table-sm table-bordered mb-2"><thead><tr><th>Setting</th><th style="width:38%">Value</th><th>Help</th></tr></thead><tbody>
    ${L.DEFAULT_SETTINGS.map(([k, , note]) => `<tr><td class="small fw-bold">${k}</td><td>${k === 'FINE_MODE' ? `<select name="${k}" class="form-select form-select-sm">${['NONE', 'PER_TASK', 'PERCENT', 'BOTH'].map((m) => `<option ${m === String(S.settings[k]).toUpperCase() ? 'selected' : ''}>${m}</option>`).join('')}</select>` : `<input name="${k}" value="${esc(S.settings[k])}" class="form-control form-control-sm">`}</td><td class="small muted">${esc(note)}</td></tr>`).join('')}
    </tbody></table><button class="btn btn-primary btn-sm">Save Settings</button></form></div>
    <div class="col-lg-4">
      <div class="panel"><h6>Import from the old Google Sheet</h6><div class="small muted mb-2">In Google Sheets, go to File → Download → Microsoft Excel (.xlsx), then choose the file here. It reads Sort_List (tasks) and Officer_Master_DB (history). It also creates a login for every user name in column G (password <b>Audit@123</b>; they set their own at first login).<br>Tasks in database: <b>${S.tasks.length}</b>.</div>
        <input type="file" id="xf" accept=".xlsx" class="form-control form-control-sm mb-2"><div class="form-check mb-2"><input class="form-check-input" type="checkbox" id="rep"><label for="rep" class="form-check-label small">Replace ALL current tasks and records</label></div>
        <button class="btn btn-outline-dark btn-sm w-100" id="btnImp">Import</button><div class="progress-log mt-2 d-none" id="ilog"></div></div>
      <div class="panel"><h6>Close a past day</h6><div class="small muted mb-2">Saves FALSE for every task due on that date that has no TRUE / FALSE. This also happens automatically every day.</div>
        <input type="date" id="cd" class="form-control form-control-sm mb-2"><button class="btn btn-outline-danger btn-sm w-100" id="btnClose">Close this date</button></div>
      <div class="panel"><h6>Backup</h6><button class="btn btn-outline-success btn-sm w-100" id="btnBak">⬇ Download full backup (Excel)</button></div></div></div>`);
  $('sf').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await setDoc(doc(db, 'settings', 'app'), { values: readForm(ev.target) }); await loadSettings(); log('SAVE_SETTINGS'); toast('Settings saved'); } catch (e) { fail(e); }
  };
  $('btnClose').onclick = async () => {
    const d = $('cd').value;
    if (!d) return toast('Pick a date', 'warning');
    if (d >= today()) return toast('Only past dates can be closed.', 'warning');
    if (!confirm(`Save FALSE for unmarked tasks of ${d}?`)) return;
    try {
      const recs = await fetchRecords(d, d, null, true);
      const active = new Set(S.users.filter((u) => u.active && u.role !== 'Admin').map((u) => u.username_lc));
      const out = L.missingForDay(S.groups, recs, d, opts(), active, nowText());
      const b = writeBatch(db);
      for (const r of out) b.set(doc(db, 'records', await recordId(r)), r);
      await b.commit(); clearCache(); log('CLOSE_DAY', `${d} ${out.length}`);
      toast(`${out.length} FALSE record(s) added for ${d}`);
    } catch (e) { fail(e); }
  };
  $('btnBak').onclick = async () => {
    try {
      const wb = XLSX.utils.book_new();
      for (const name of ['tasks', 'records', 'users', 'monthly', 'logs']) {
        const snap = await getDocs(collection(db, name));
        const rows = snap.docs.map((d) => { const x = { id: d.id, ...d.data() }; if (x.rows) x.rows = JSON.stringify(x.rows); return x; });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ empty: '' }]), name);
      }
      XLSX.writeFile(wb, `audit_backup_${today()}.xlsx`);
    } catch (e) { fail(e); }
  };
  $('btnImp').onclick = () => importWorkbook($('xf').files[0], $('rep').checked);
}

async function importWorkbook(file, replace) {
  const lg = $('ilog'), btn = $('btnImp');      // kept even if the user opens another page meanwhile
  const say = (m) => { lg.classList.remove('d-none'); lg.textContent += m + '\n'; lg.scrollTop = lg.scrollHeight; };
  if (!file) return toast('Choose the .xlsx file first', 'warning');
  if (!confirm('Import now? Please stay on this page until it says "Done".')) return;
  btn.disabled = true;
  try {
    if (S.tasks.length && !replace) throw new Error(`Database already has ${S.tasks.length} task rows. Tick "Replace" to import again.`);
    say('Reading file…');
    const wb = XLSX.read(await file.arrayBuffer(), { cellDates: false });
    const res = L.parseOldWorkbook(
      (s, r, c) => wb.Sheets[s][XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })],
      (s) => (wb.Sheets[s]['!ref'] ? XLSX.utils.decode_range(wb.Sheets[s]['!ref']).e.r + 1 : 0),
      (s) => !!wb.Sheets[s]);
    say(`Found ${res.tasks.length} task rows, ${res.records.length} history records, users: ${res.users.join(', ')}`);
    if (replace) {
      for (const name of ['tasks', 'records']) {
        const snap = await getDocs(collection(db, name));
        for (let i = 0; i < snap.docs.length; i += 450) {
          const b = writeBatch(db); snap.docs.slice(i, i + 450).forEach((d) => b.delete(d.ref)); await b.commit();
        }
        say(`Cleared ${snap.size} ${name}`);
      }
    }
    for (let i = 0; i < res.tasks.length; i += 450) {
      const b = writeBatch(db);
      res.tasks.slice(i, i + 450).forEach((t) => b.set(doc(collection(db, 'tasks')), t));
      await b.commit();
    }
    say(`Saved ${res.tasks.length} task rows`);
    for (let i = 0; i < res.records.length; i += 450) {
      const b = writeBatch(db);
      for (const r of res.records.slice(i, i + 450)) b.set(doc(db, 'records', await recordId(r)), r);
      await b.commit();
      say(`Saved records ${Math.min(i + 450, res.records.length)} / ${res.records.length}`);
    }
    await loadUsers();
    const yest = L.addDays(today(), -1);
    const closed = res.lastDate && res.lastDate < yest ? res.lastDate : yest;
    for (const name of res.users) {
      const u = S.users.find((x) => x.username_lc === L.norm(name) && !x.replaced_by);
      if (u) { await updateDoc(doc(db, 'users', u.uid), { closed_until: closed }); say(`User ${name} already has a login`); continue; }
      await createLogin(name, 'Audit@123', { role: 'Officer', closed_until: closed, must_change: true });
      say(`Login created: ${name} / Audit@123 (must change at first login)`);
    }
    await Promise.all([loadTasks(), loadUsers()]);
    clearCache();
    log('IMPORT', `${res.tasks.length} tasks, ${res.records.length} records`);
    say('Done ✔');
    toast(`Import finished: ${res.tasks.length} tasks, ${res.records.length} records`);
    route();                                       // refresh whatever page is open now
  } catch (e) { say('ERROR: ' + friendly(e)); fail(e); } finally { btn.disabled = false; }
}

// ------------------------------------------------------------------ password
function renderPassword(force = false) {
  const html = `<div class="panel" style="max-width:400px"><h5>${force ? 'Set your own password' : 'Change Password'}</h5>
    ${force ? '<div class="alert alert-warning py-2 small">You are using a password given by the admin. Please set your own password to continue.</div>' : ''}
    <form id="pf"><input name="old" type="password" class="form-control form-control-sm mb-2" placeholder="Current password" required>
    <input name="n1" type="password" class="form-control form-control-sm mb-2" placeholder="New password (min 6)" minlength="6" required>
    <input name="n2" type="password" class="form-control form-control-sm mb-2" placeholder="Repeat new password" minlength="6" required>
    <button class="btn btn-primary btn-sm">Change</button>${force ? ' <button type="button" class="btn btn-outline-danger btn-sm" id="pfOut">Logout</button>' : ''}<div id="perr" class="text-danger small mt-2"></div></form></div>`;
  if (force) { $('app').innerHTML = `<div class="container py-4">${html}</div>`; $('pfOut').onclick = () => signOut(auth); } else mount('', html);
  $('pf').onsubmit = async (ev) => {
    ev.preventDefault();
    const v = readForm(ev.target);
    try {
      if (v.n1 !== v.n2) throw new Error('New passwords do not match.');
      if (['Audit@123', '123456', 'admin123'].includes(v.n1)) throw new Error('Choose a stronger password.');
      const u = auth.currentUser;
      await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, v.old));
      await updatePassword(u, v.n1);
      if (S.prof.must_change) { await updateDoc(doc(db, 'users', S.uid), { must_change: false }); S.prof.must_change = false; }
      toast('Password changed');
      go('tasks'); if (force) route();
    } catch (e) { $('perr').textContent = friendly(e); }
  };
}

// ------------------------------------------------------------------ router & boot
async function route() {
  if (!S.prof) return;
  if (S.prof.must_change) return renderPassword(true);
  const { path, q } = parseHash();
  const adminOnly = ['admin/tasks', 'admin/task', 'users', 'settings'];
  try {
    if (adminOnly.includes(path) && !S.isAdmin) return go('tasks');
    if (path === 'report') return await renderReport(q);
    if (path === 'eff') return await renderEff(q);
    if (path === 'monthly') return await renderMonthly(q);
    if (path === 'admin/tasks') return renderAdminTasks(q);
    if (path === 'admin/task') return renderTaskForm(q);
    if (path === 'users') return await renderUsers();
    if (path === 'settings') return renderSettings();
    if (path === 'password') return renderPassword(false);
    return await renderTasks(q);
  } catch (e) {
    fail(e);
    if ($('main')) $('main').innerHTML = `<div class="alert alert-danger">${esc(friendly(e))}</div>`;
  }
}
window.addEventListener('hashchange', route);

async function boot(user) {
  try {
    const p = await getDoc(doc(db, 'users', user.uid));
    if (!p.exists() || !p.data().active) { await signOut(auth); return renderLogin('This login is not active. Ask the admin.'); }
    S.uid = user.uid; S.prof = p.data(); S.isAdmin = S.prof.role === 'Admin';
    $('app').innerHTML = loading;
    await Promise.all([loadSettings(), loadTasks(), S.isAdmin ? loadUsers() : Promise.resolve()]);
    if (!S.isAdmin) S.users = [{ uid: S.uid, ...S.prof }];
    updateDoc(doc(db, 'users', S.uid), { last_login: nowText() }).catch(() => {});
    document.title = S.settings.APP_TITLE;
    try { const n = await closePendingDays(); if (n) toast(`${n} unmarked task(s) from previous days saved as FALSE`, 'secondary'); } catch (e) { console.warn('auto-close', e); }
    try { await autoMonthly(); } catch (e) { console.warn('monthly', e); }
    route();
  } catch (e) { fail(e); renderLogin(friendly(e)); }
}

onAuthStateChanged(auth, (user) => {
  if (S.settingUp) return;          // first-admin setup is still writing the profile
  S.prof = null; S.uid = null; S.isAdmin = false; clearCache();
  if (user) boot(user); else renderLogin();
});
