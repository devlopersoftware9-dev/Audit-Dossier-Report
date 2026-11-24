// Audit Dossier Portal — browser app (GitHub Pages + Firebase Auth + Firestore, free Spark plan).
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword,
  updatePassword, EmailAuthProvider, reauthenticateWithCredential,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, writeBatch, addDoc, onSnapshot, orderBy, limit, runTransaction, arrayUnion,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import * as L from './logic.js?v=18';
import { firebaseConfig, EMAIL_DOMAIN } from './firebase-config.js?v=18';

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

// ------------------------------------------------------------------ state & helpers
const S = { seq: 0, settingUp: false, prof: null, uid: null, isAdmin: false, isDept: false, isAuditor: false, issues: null, issueUnsub: null, onIssues: null, settings: L.settingsWithDefaults({}), tasks: [], groups: [], users: [], cache: new Map() };
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => Math.round(Number(v) || 0).toLocaleString('en-PK');
const tz = () => L.tzOffset(S.settings);
// Work day closes at DAY_CLOSE_HOUR (default 23 = 11 PM): after that the portal is already on the next day.
const closeShift = () => { const h = Number(S.settings.DAY_CLOSE_HOUR); return h > 0 && h < 24 ? 24 - h : 0; };
const today = () => L.todayKey(tz() + closeShift());
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
/** In-page Yes/No dialog (some browsers, e.g. the one inside the Claude app, block window.confirm). */
function askConfirm(message, okLabel = 'OK') {
  return new Promise((resolve) => {
    let box = $('askModal');
    if (!box) {
      document.body.insertAdjacentHTML('beforeend', `<div class="modal fade" id="askModal" tabindex="-1"><div class="modal-dialog modal-dialog-centered"><div class="modal-content">
        <div class="modal-body" id="askText"></div><div class="modal-footer"><button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">Cancel</button>
        <button class="btn btn-primary btn-sm" id="askOk">OK</button></div></div></div></div>`);
      box = $('askModal');
    }
    $('askText').textContent = message;
    $('askOk').textContent = okLabel;
    const m = bootstrap.Modal.getOrCreateInstance(box);
    let answered = false;
    $('askOk').onclick = () => { answered = true; m.hide(); resolve(true); };
    box.addEventListener('hidden.bs.modal', () => { if (!answered) resolve(false); }, { once: true });
    m.show();
  });
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
/** Auditor / admin names once each (old login records left by a password reset are skipped). */
const auditorNames = (activeOnly = false) => [...new Set(S.users.filter((u) => !u.replaced_by && u.role !== 'Department' && (!activeOnly || u.active)).map((u) => u.username))];
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
// ------------------------------------------------------------------ today's ticks (shared live) -> database at 11 PM
// Like the old Google Sheet: ticks/remarks go to the shared "marks" list at once, so everybody using the same
// login on any computer sees them live. When the day closes (11 PM) every finished day's marks are copied into
// the "records" database in one go and cleared; tasks with no tick become FALSE; open pages reload.
const markKeyOf = (r) => L.recordKey(r.date, r.user, r.branch, r.department, r.checklist, r.task_type);
const marksQuery = (cons) => query(collection(db, 'marks'), ...cons);

async function fetchMarks(date, userLc) {
  const cons = [where('date', '==', date)];
  if (userLc) cons.push(where('user_lc', '==', userLc));
  const snap = await getDocs(marksQuery(cons));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Copy all marks of finished days (date < today) into records, then delete those marks. */
async function saveMarksToDatabase() {
  const t = today();
  const snap = await getDocs(marksQuery(S.isAdmin ? [where('date', '<', t)] : [where('user_lc', '==', S.prof.username_lc)]));
  const marks = snap.docs.map((d) => ({ ref: d.ref, id: d.id, ...d.data() })).filter((m) => m.date < t);
  let saved = 0, skipped = 0;
  const days = [...new Set(marks.map((m) => m.date))].sort();
  for (const d of days) {
    const list = marks.filter((m) => m.date === d);
    const existing = await fetchRecords(d, d, S.isAdmin ? null : S.prof.username_lc, true);
    const locked = new Set(existing.filter((r) => !S.isAdmin && (r.source === 'Auto-Closed' || r.source === 'Admin')).map((r) => r.id));
    for (let i = 0; i < list.length; i += 200) {
      const b = writeBatch(db);
      for (const m of list.slice(i, i + 200)) {
        const { ref, id, ...rec } = m;
        if (!S.isAdmin && rec.source === 'Admin') continue;   // ticks made by the admin are saved from the admin's login
        if (locked.has(id)) skipped++; else { b.set(doc(db, 'records', id), rec); saved++; }
        b.delete(ref);
      }
      await b.commit();
    }
  }
  if (days.length) { clearCache(); log('DAY_SAVE', `${days.join(',')}: ${saved} saved, ${skipped} skipped`); }
  return { saved, skipped, days: days.length };
}

/** Old version kept ticks in this browser — move any left-overs into the shared marks list once. */
async function migrateLocalDrafts() {
  const k = `adp_draft_${S.uid}`;
  let dr = null;
  try { dr = JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { dr = null; }
  if (!dr) return;
  for (const recs of Object.values(dr)) {
    for (const r of Object.values(recs || {})) await setDoc(doc(db, 'marks', await recordId(r)), r).catch(() => {});
  }
  localStorage.removeItem(k);
}

/** Close finished days: marks -> records, unmarked -> FALSE, monthly snapshot. Safe to run from many PCs. */
async function closeDay() {
  await migrateLocalDrafts();
  const f = await saveMarksToDatabase();
  const n = await closePendingDays();
  await autoMonthly().catch(() => {});
  return { saved: f.saved, skipped: f.skipped, falses: n };
}

async function closePendingDays() {
  const yest = L.addDays(today(), -1);
  const ts = nowText();
  const people = S.isAdmin ? S.users.filter((u) => u.active && u.role === 'Officer') : [{ ...S.prof, uid: S.uid }];
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
      <a href="#/${S.isDept ? 'issues' : 'tasks'}" class="app-title text-dark text-decoration-none">${esc(S.settings.APP_TITLE)}</a>
      <div class="d-flex align-items-center gap-2">
        <span class="muted small">${today()} · ${L.dayName(today())}</span>
        <span class="badge bg-success py-2">User: ${esc(S.prof.username)}${S.isAdmin ? ' (Admin)' : S.isDept ? ` (Department: ${esc(S.prof.department)})` : ''}</span>
        <button class="btn btn-sm btn-outline-secondary" id="btnTheme" title="Light / Dark">${document.documentElement.dataset.bsTheme === 'dark' ? '☀️' : '🌙'}</button>
        <a class="btn btn-sm btn-outline-secondary" href="#/password">Password</a>
        <button class="btn btn-sm btn-outline-danger" id="btnLogout">Logout</button>
      </div>
    </div>
    <ul class="nav nav-tabs mb-2">
      ${S.isDept ? '' : tab('tasks', 'Tasks Portal', 'tasks') + tab('report', 'Reporting', 'report') + tab('eff', 'Efficiency &amp; Fines', 'eff') + tab('monthly', 'Performance', 'monthly')}
      ${tab('issues', 'Audit Issues <span class="badge rounded-pill bg-danger d-none" id="issueBadge"></span>', 'issues')}${tab('ireport', 'Issue Reports', 'ireport')}
      ${S.isAdmin ? tab('admin', 'Task Manager', 'admin/tasks') + tab('users', 'Users', 'users') + tab('settings', 'Settings', 'settings') : ''}
    </ul>
    <div id="main">${inner}</div></div>`;
}
function mount(active, inner) {
  S.seq++;
  S.onIssues = null;
  if (S.unsub) { S.unsub(); S.unsub = null; }
  $('app').innerHTML = shell(active, inner);
  updateIssueBadge();
  $('btnLogout').onclick = () => { if (S.unsub) { S.unsub(); S.unsub = null; } stopIssueWatch(); signOut(auth); };
  $('btnTheme').onclick = () => {
    const next = document.documentElement.dataset.bsTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.bsTheme = next;
    try { localStorage.setItem('adp_theme', next); } catch (e) { /* ignore */ }
    $('btnTheme').textContent = next === 'dark' ? '☀️' : '🌙';
  };
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
  return { users: S.isAdmin ? auditorNames() : [S.prof.username], departments: col('depart'), branches: col('branch'), task_types: col('task') };
}
function readForm(form) {
  const o = {};
  form.querySelectorAll('[name]').forEach((el) => {
    if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; else if (!(el.name in o)) o[el.name] = ''; return; }
    if (el.type === 'checkbox') { o[el.name] = el.hasAttribute('value') ? (el.checked ? el.value : '') : el.checked; return; }
    o[el.name] = el.value;
  });
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

// ------------------------------------------------------------------ evidence pictures
// Firebase Storage is not free any more, so pictures are shrunk (max 1280 px, JPEG) and kept in Firestore.
async function compressImage(file, maxSide = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('This file is not a picture.')); i.src = url; });
    let side = maxSide, data = '', w = 0, h = 0;
    for (let tries = 0; tries < 4; tries++) {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      w = Math.round(img.naturalWidth * k); h = Math.round(img.naturalHeight * k);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      for (let q = 0.7; q >= 0.35; q -= 0.1) { data = c.toDataURL('image/jpeg', q); if (data.length < 450000) break; }
      if (data.length < 450000) break;
      side = Math.round(side * 0.75);
    }
    return { data, w, h };
  } finally { URL.revokeObjectURL(url); }
}
async function showEvidence(ids, title) {
  if (!ids.length) return;
  showModal(`Evidence — ${title}`, loading);
  const docs = await Promise.all(ids.map((id) => getDoc(doc(db, 'evidence', id)).catch(() => null)));
  $('detailBody').innerHTML = docs.filter((d) => d && d.exists()).map((d) => {
    const x = d.data();
    return `<figure class="mb-3"><img src="${x.data}" class="img-fluid rounded border" alt="evidence"><figcaption class="small muted mt-1">${esc(x.ts)} · by ${esc(x.by)}</figcaption></figure>`;
  }).join('') || '<div class="muted">Picture not found.</div>';
}

// ------------------------------------------------------------------ tasks portal
async function renderTasks(q) {
  mount('tasks', loading);
  const my = S.seq;
  const tab = q.tab || 'today', val = q.v || '';
  const viewLc = S.isAdmin ? L.norm(q.user || '') : S.prof.username_lc;
  const t = today();
  const [dbToday, marks] = await Promise.all([fetchRecords(t, t, viewLc || null, true), fetchMarks(t, viewLc || null)]);
  const mk = new Map(marks.map((r) => [markKeyOf(r), r]));
  const recsToday = [...dbToday.filter((r) => !mk.has(markKeyOf(r))), ...mk.values()];
  const who = viewLc ? S.groups.find((g) => L.norm(g.user) === viewLc)?.user || q.user || S.prof.username : null;
  let rows = tab === 'today' ? L.todayTasks(S.groups, recsToday, t, opts(), who, true)
    : L.categoryTasks(S.groups, recsToday, t, opts(), tab, val, who);
  if (!who && tab === 'today') rows = L.todayTasks(S.groups, recsToday, t, opts(), null, true);
  const st = L.stats(L.todayTasks(S.groups, recsToday, t, opts(), who));   // trigger tasks are not counted
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
  const ACT = ['Mark (TRUE)', 'Department', 'Remarks', 'Evidence'];
  const head = tab === 'today'
    ? ['Organization', 'Branch Name', 'Task', 'Depart', 'Check List', 'SOP', 'Target Day / Date', 'Recurrence', ...(S.isAdmin ? ['User'] : []), ...ACT]
    : ['Depart', 'Check List', 'Task', 'Recurrence', 'Target Day / Date', 'Organization', 'Branch Name', 'SOP', ...(S.isAdmin ? ['User'] : []), 'Due Today', ...ACT];
  let body = '';
  rows.forEach((r, i) => {
    if (i === 0 || r.bucket !== rows[i - 1].bucket) {
      const n = rows.filter((x) => x.bucket === r.bucket).length;
      body += r.trigger
        ? `<tr class="grp-row grp-trigger" data-bucket="${esc(r.bucket)}"><td colspan="${head.length}">⚡ Triggered tasks (${n}) — click here to open / close · <span class="fw-normal">tick only when it happened; not counted in efficiency, never auto-FALSE</span></td></tr>`
        : `<tr class="grp-row" data-bucket="${esc(r.bucket)}"><td colspan="${head.length}">📋 ${esc(r.bucket)} tasks (${n}) ↕ <span class="fw-normal">(click to collapse / expand)</span></td></tr>`;
    }
    const cl = `<button type="button" class="link-btn" data-i="${i}">${esc(r.checklist)}</button>`;
    const sop = r.sop_url ? `<a href="${esc(r.sop_url)}" target="_blank" rel="noopener">${esc(r.sop_name || 'Open SOP')}</a>` : esc(r.sop_name);
    const td = (label, html, cls = '') => `<td data-label="${label}" class="${cls}">${html}</td>`;
    const nEv = (r.evidence_ids || []).length;
    const mark = td('Mark (TRUE)', `<input type="checkbox" class="form-check-input mark-box" ${r.status ? 'checked' : ''} title="${esc(r.marked_at ? 'Ticked ' + r.marked_at + (r.by ? ' by ' + r.by : '') : 'Not ticked yet')}">`, 'text-center td-mark')
      + td('Department', `<select class="form-select form-select-sm dept-sel ${r.dept_status === 'Incomplete' ? 'is-bad' : r.dept_status === 'Complete' ? 'is-good' : ''}" ${r.status ? '' : 'disabled'} title="Tick TRUE first">
          <option value="">—</option>${L.DEPT_STATUSES.map((x) => `<option ${r.dept_status === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`)
      + td('Remarks', `<input class="form-control form-control-sm remarks-in" value="${esc(r.remarks)}" placeholder="Enter remarks…">`)
      + td('Evidence', `<div class="d-flex gap-1 align-items-center"><button type="button" class="btn btn-sm btn-outline-secondary ev-add" title="Take / attach a picture">📷</button>
          <button type="button" class="btn btn-sm btn-outline-info ev-view ${nEv ? '' : 'd-none'}" title="View pictures">🖼 <span class="ev-n">${nEv}</span></button>
          <input type="file" accept="image/*" capture="environment" class="d-none ev-file"></div>`);
    const cls = 'b-' + r.bucket.replace(/[ /]/g, '') + (r.status ? ' row-done' : '') + (r.trigger ? ' d-none' : '');
    body += tab === 'today'
      ? `<tr class="${cls}" data-i="${i}">${td('Organization', esc(r.company))}${td('Branch', esc(r.branch))}${td('Task', `<span class="task-badge">${esc(r.task)}</span>`)}${td('Depart', esc(r.depart))}${td('Check List', cl, 'm-title')}${td('SOP', sop || '<span class="muted">—</span>')}${td('Target', esc(r.target), 'm-hide')}${td('Recurrence', esc(r.recurrence), 'm-hide')}${S.isAdmin ? td('User', esc(r.user)) : ''}${mark}</tr>`
      : `<tr class="${cls}" data-i="${i}">${td('Depart', esc(r.depart))}${td('Check List', cl, 'm-title')}${td('Task', esc(r.task))}${td('Recurrence', esc(r.recurrence))}${td('Target', esc(r.target))}${td('Organization', esc(r.company))}${td('Branch', esc(r.branch))}${td('SOP', sop || '<span class="muted">—</span>')}${S.isAdmin ? td('User', esc(r.user)) : ''}${td('Due Today', r.due_today ? '<span class="badge bg-primary">Y</span>' : '<span class="muted">N</span>')}${mark}</tr>`;
  });
  const card = (cls, lbl, v, id = '') => `<div class="col-6 col-md-2"><div class="stat-card ${cls}"><div class="lbl">${lbl}</div><div class="val" ${id ? `id="${id}"` : ''}>${v}</div></div></div>`;
  $('main').innerHTML = `<div class="row g-2 mb-2">${card('bg-blue', 'Total Tasks (Today)', st.total, 'cTotal')}${card('bg-teal', 'Completed', st.done, 'cDone')}${card('bg-amber', 'Pending', st.pending, 'cPending')}${card('bg-green', 'Completion Progress', st.pct + '%', 'cPct')}${card('bg-slate', 'This Month Efficiency', mtd)}${card('bg-red', 'This Month Fine (Rs)', fine)}</div>
    <div class="night-note mb-2">🔄 Ticks are shared live on every computer using this login (<b><span id="pendBox">${marks.length}</span></b> ticked today). At <b>${esc(closeLabel())}</b> the day is saved to the database in one go, unmarked tasks become FALSE and the page loads the next day's tasks.</div>
    <div class="d-flex flex-wrap justify-content-between align-items-start">
      <div class="pill-bar">${pill('today', '', 'Todays Task', 'success')}${depts.map((d) => pill('dept', d, d, 'primary')).join('')}${branches.map((b) => pill('branch', b, 'Branch: ' + b, 'info')).join('')}</div>
      <div class="d-flex gap-2 mb-2">${S.isAdmin ? `<select id="viewAs" class="form-select form-select-sm" title="View as"><option value="">All users</option>${opt(auditorNames(true), q.user || '')}</select>` : ''}
        <button class="btn btn-sm btn-success text-nowrap" id="btnExp">⬇ Export Excel</button></div>
    </div>
    <div class="panel"><div class="table-wrap">${rows.length ? `<table class="table table-bordered table-striped table-hover table-sm tbl tbl-cards mb-0"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`
      : `<div class="text-center p-4 muted">${tab === 'today' ? 'No task due today 🎉' : 'No tasks in this tab.'}</div>`}</div></div>`;
  if ($('viewAs')) $('viewAs').onchange = (e) => go('tasks', { tab: tab === 'today' ? '' : tab, v: val, user: e.target.value });
  $('btnExp').onclick = () => exportXlsx(tab === 'today' ? 'Todays_Task_' + t : val + '_Tasks',
    ['Group', 'Organization', 'Branch', 'Department', 'Check List', 'Details', 'Task', 'Recurrence', 'Target Day / Date', 'SOP', 'SOP Link', 'User', 'Status', 'Remarks'],
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
  const saveRow = async (tr, r, note) => {
    const box = tr.querySelector('.mark-box'), rem = tr.querySelector('.remarks-in'), dep = tr.querySelector('.dept-sel');
    if (!box.checked) dep.value = '';
    dep.disabled = !box.checked;
    const due = L.isScheduled(r, t, opts());
    const source = !due && L.isPureTrigger(r) ? 'Trigger' : S.isAdmin && L.norm(r.user) !== S.prof.username_lc ? 'Admin' : (due ? 'Portal' : 'Extra');
    const rec = L.makeRecord(r, t, r.user, box.checked, rem.value, source, nowText(), dep.value, r.evidence_ids || []);
    rec.by = S.prof.username;
    await setDoc(doc(db, 'marks', await recordId(rec)), rec);
    r.status = box.checked; r.remarks = rem.value; r.dept_status = rec.dept_status;
    tr.classList.toggle('row-done', box.checked);
    dep.classList.toggle('is-bad', rec.dept_status === 'Incomplete');
    dep.classList.toggle('is-good', rec.dept_status === 'Complete');
    box.title = 'Ticked ' + rec.timestamp + ' — saved to the database at ' + closeLabel();
    if (note) toast(note + (source === 'Extra' ? ' (not due today)' : source === 'Trigger' ? ' (trigger task — not counted in efficiency)' : ''), box.checked ? 'success' : 'secondary');
    return rec;
  };
  main.addEventListener('click', async (ev) => {
    const add = ev.target.closest('.ev-add'), view = ev.target.closest('.ev-view');
    if (!add && !view) return;
    const tr = ev.target.closest('tr[data-i]');
    const r = rows[+tr.dataset.i];
    if (add) { tr.querySelector('.ev-file').click(); return; }
    showEvidence(r.evidence_ids || [], r.checklist);
  });
  main.onchange = async (ev) => {
    const tr = ev.target.closest('tr[data-i]');
    if (!tr) return;
    const r = rows[+tr.dataset.i];
    const box = tr.querySelector('.mark-box');
    const fromBox = ev.target === box;
    tr.classList.add('saving');
    try {
      if (ev.target.classList.contains('ev-file')) {
        const file = ev.target.files[0];
        ev.target.value = '';
        if (!file) return;
        if ((r.evidence_ids || []).length >= 5) throw new Error('Maximum 5 pictures per task.');
        toast('Uploading picture…', 'info');
        const img = await compressImage(file);
        const ref = await addDoc(collection(db, 'evidence'), { date: t, user: r.user, user_lc: L.norm(r.user), department: r.depart,
          checklist: r.checklist, task_type: r.task, data: img.data, w: img.w, h: img.h, by: S.prof.username, ts: nowText() });
        r.evidence_ids = [...(r.evidence_ids || []), ref.id];
        await saveRow(tr, r, '📷 Picture attached');
        tr.querySelector('.ev-n').textContent = r.evidence_ids.length;
        tr.querySelector('.ev-view').classList.remove('d-none');
        return;
      }
      if (ev.target.classList.contains('dept-sel') && !box.checked) { ev.target.value = ''; throw new Error('Tick TRUE first, then choose Complete / Incomplete.'); }
      const rec = await saveRow(tr, r, null);
      toast(ev.target.classList.contains('dept-sel') ? `Department: ${rec.dept_status || '—'}`
        : (box.checked ? '✔ TRUE' : '✖ FALSE') + ` noted — goes to the database at ${closeLabel()}`, box.checked ? 'success' : 'secondary');
      if (tab === 'today') {
        const s2 = L.stats(rows.filter((x) => !x.trigger));
        $('cDone').textContent = s2.done; $('cPending').textContent = s2.pending; $('cPct').textContent = s2.pct + '%';
      }
      clearCache();
    } catch (e) { if (fromBox) box.checked = !box.checked; fail(e); } finally { tr.classList.remove('saving'); }
  };
  // live: ticks made on other computers appear here within a second
  const cons = [where('date', '==', t)];
  if (viewLc) cons.push(where('user_lc', '==', viewLc));
  S.unsub = onSnapshot(marksQuery(cons), (snap) => {
    if (my !== S.seq) return;
    const live = new Map(snap.docs.map((d) => { const x = d.data(); return [markKeyOf(x), x]; }));
    rows.forEach((r, i) => {
      const m = live.get(L.groupRecordKey(r, t));
      if (!m) return;
      const tr = main.querySelector(`tr[data-i="${i}"]`);
      if (!tr) return;
      const box = tr.querySelector('.mark-box'), rem = tr.querySelector('.remarks-in');
      r.status = !!m.status; r.remarks = m.remarks || '';
      box.checked = r.status;
      if (document.activeElement !== rem) rem.value = r.remarks;
      tr.classList.toggle('row-done', r.status);
      box.title = `Ticked ${m.timestamp}${m.by ? ' by ' + m.by : ''}`;
      const dep = tr.querySelector('.dept-sel');
      r.dept_status = m.dept_status || '';
      if (document.activeElement !== dep) dep.value = r.dept_status;
      dep.disabled = !r.status;
      dep.classList.toggle('is-bad', r.dept_status === 'Incomplete');
      dep.classList.toggle('is-good', r.dept_status === 'Complete');
      r.evidence_ids = m.evidence_ids || [];
      tr.querySelector('.ev-n').textContent = r.evidence_ids.length;
      tr.querySelector('.ev-view').classList.toggle('d-none', !r.evidence_ids.length);
    });
    if ($('pendBox')) $('pendBox').textContent = snap.size;
    if (tab === 'today' && $('cDone')) {
      const s2 = L.stats(rows.filter((x) => !x.trigger));
      $('cDone').textContent = s2.done; $('cPending').textContent = s2.pending; $('cPct').textContent = s2.pct + '%';
    }
  }, (e) => console.warn('live', e));
}
const closeLabel = () => { const h = Number(S.settings.DAY_CLOSE_HOUR); return h > 0 && h < 24 ? `${h > 12 ? h - 12 : h}:00 ${h >= 12 ? 'PM' : 'AM'}` : '12:00 midnight'; };

// ------------------------------------------------------------------ reports
function filterBar(f, extra = '') {
  const o = filterOptions();
  return `<div class="col-md-2"><label class="form-label small fw-bold">Start Date</label><input type="date" name="start" value="${f.start}" class="form-control form-control-sm"></div>
    <div class="col-md-2"><label class="form-label small fw-bold">End Date</label><input type="date" name="end" value="${f.end}" class="form-control form-control-sm"></div>
    ${S.isAdmin ? `<div class="col-md-2"><label class="form-label small fw-bold">User</label><select name="user" class="form-select form-select-sm">${opt(o.users, f.user, 'All users')}</select></div>` : ''}
    <div class="col-md-2"><label class="form-label small fw-bold">Organization</label><select name="company" class="form-select form-select-sm">${opt(L.SHEET_LISTS.company, f.company, 'RC & RCG')}</select></div>
    <div class="col-md-2"><label class="form-label small fw-bold">Department</label><select name="department" class="form-select form-select-sm">${opt(o.departments, f.department, 'All departments')}</select></div>
    <div class="col-md-2"><label class="form-label small fw-bold">Branch</label><select name="branch" class="form-select form-select-sm">${opt(o.branches, f.branch, 'All branches')}</select></div>${extra}`;
}
const defF = (q, start) => ({ start: q.start || start || today(), end: q.end || today(), status: q.status || 'ALL', user: q.user || '',
  department: q.department || '', branch: q.branch || '', task_type: q.task_type || '', checklist: q.checklist || '', source: q.source || '', group_by: q.group_by || 'user', sub_group: q.sub_group || '', dept_status: q.dept_status || '', company: q.company || '' });
const groupSel = (name, val, list, none) => `<select name="${name}" class="form-select form-select-sm">${none ? `<option value="">${none}</option>` : ''}${list.map(([v, l]) => `<option value="${v}" ${val === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;

async function renderReport(q) {
  const f = defF(q);
  const o = filterOptions();
  mount('report', `<form id="rf" class="panel"><div class="d-flex justify-content-between align-items-center mb-2"><h5 class="m-0">Performance Reporting</h5><button type="button" class="btn btn-success btn-sm" id="btnExp">⬇ Export Excel</button></div>
    <div class="row g-2"><div class="col-md-2"><label class="form-label small fw-bold">Status</label><select name="status" class="form-select form-select-sm">
      ${[['ALL', 'All'], ['TRUE', 'TRUE (Done)'], ['FALSE', 'FALSE (Not done)']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    ${filterBar(f, `<div class="col-md-3"><label class="form-label small fw-bold">Task Type</label><select name="task_type" class="form-select form-select-sm">${opt(o.task_types, f.task_type, 'All task types')}</select></div>
      <div class="col-md-3"><label class="form-label small fw-bold">Check List contains</label><input name="checklist" value="${esc(f.checklist)}" class="form-control form-control-sm"></div>
      <div class="col-md-2"><label class="form-label small fw-bold">Source</label><select name="source" class="form-select form-select-sm">${opt(['Portal', 'Auto-Closed', 'Admin', 'Extra', 'Trigger', 'Imported'], f.source, 'All')}</select></div>
      <div class="col-md-2"><label class="form-label small fw-bold">Department status</label><select name="dept_status" class="form-select form-select-sm">
        ${[['', 'All'], ['Complete', 'Complete'], ['Incomplete', 'Incomplete'], ['none', 'Not given']].map(([v, l]) => `<option value="${v}" ${f.dept_status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`)}</div>
    <button class="btn btn-primary w-100 mt-2 btn-sm">Generate Report</button></form><div class="panel" id="out">${q.start ? loading : '<div class="muted p-3">Choose filters and press Generate Report.</div>'}</div>`);
  $('rf').onsubmit = (ev) => { ev.preventDefault(); go('report', readForm(ev.target)); };
  let rows = [];
  $('btnExp').onclick = () => exportXlsx(`Report_${f.start}_to_${f.end}`, ['Date', 'User', 'Organization', 'Branch', 'Department', 'Check List', 'To-Do', 'Task Type', 'Status', 'Department status', 'Pictures', 'Remarks', 'Timestamp', 'Ticked by', 'Source'],
    rows.map((r) => [r.date, r.user, r.company, r.branch, r.department, r.checklist, r.todo, r.task_type, r.status ? 'TRUE' : 'FALSE', r.dept_status || '', (r.evidence_ids || []).length, r.remarks, r.timestamp, r.by || '', r.source]));
  if (!q.start) return;
  const my = S.seq;
  const recs = await fetchRecords(f.start, f.end, S.isAdmin ? L.norm(f.user) : null, true);
  if (my !== S.seq) return;
  rows = L.filterRecords(recs, f, S.isAdmin ? null : S.prof.username).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.user.localeCompare(b.user)));
  const tr = rows.filter((r) => r.status).length;
  $('out').innerHTML = `<div class="mb-2"><span class="badge bg-secondary">Records: ${rows.length}</span> <span class="badge bg-success">TRUE: ${tr}</span> <span class="badge bg-danger">FALSE: ${rows.length - tr}</span>
    ${f.status === 'ALL' && rows.length ? `<span class="badge bg-primary">Efficiency: ${Math.round(tr * 1000 / rows.length) / 10}%</span>` : ''}</div>
    <div class="table-wrap">${rows.length ? `<table class="table table-sm table-striped table-bordered tbl mb-0"><thead><tr><th>Date</th><th>User</th><th>Organization</th><th>Branch</th><th>Department</th><th>Check List</th><th>Task Type</th><th>Status</th><th>Department</th><th>Pictures</th><th>Remarks</th><th>Timestamp</th><th>Source</th>${S.isAdmin ? '<th>Edit</th>' : ''}</tr></thead><tbody>
    ${rows.slice(0, 3000).map((r, i) => `<tr><td class="text-nowrap">${r.date}</td><td>${esc(r.user)}</td><td>${esc(r.company)}</td><td>${esc(r.branch)}</td><td>${esc(r.department)}</td><td title="${esc(r.todo)}">${esc(r.checklist)}</td><td>${esc(r.task_type)}</td>
      <td>${r.status ? '<span class="badge bg-success">TRUE</span>' : '<span class="badge bg-danger">FALSE</span>'}</td>
      <td>${r.dept_status === 'Incomplete' ? '<span class="badge bg-warning text-dark">Incomplete</span>' : r.dept_status === 'Complete' ? '<span class="badge bg-info text-dark">Complete</span>' : '<span class="muted">—</span>'}</td>
      <td>${(r.evidence_ids || []).length ? `<button class="btn btn-sm btn-outline-info py-0 evv" data-ev="${i}">🖼 ${(r.evidence_ids || []).length}</button>` : ''}</td><td>${esc(r.remarks)}</td><td class="small text-nowrap">${esc(r.timestamp)}</td><td class="small">${esc(r.source)}</td>
      ${S.isAdmin ? `<td><div class="d-flex gap-1" data-i="${i}"><select class="form-select form-select-sm py-0 es" style="width:80px"><option value="1" ${r.status ? 'selected' : ''}>TRUE</option><option value="0" ${r.status ? '' : 'selected'}>FALSE</option></select><input class="form-control form-control-sm py-0 er" style="width:120px" value="${esc(r.remarks)}"><button class="btn btn-sm btn-outline-secondary py-0 eb">Save</button></div></td>` : ''}</tr>`).join('')}
    </tbody></table>${rows.length > 3000 ? '<div class="small muted p-2">Showing first 3000 rows — Export Excel has all of them.</div>' : ''}` : '<div class="text-center p-4 muted">No records for this filter.</div>'}</div>`;
  $('out').onclick = async (ev) => {
    const v = ev.target.closest('.evv');
    if (v) { const r = rows[+v.dataset.ev]; showEvidence(r.evidence_ids || [], `${r.checklist} (${r.date})`); return; }
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
    <div class="row g-2">${filterBar(f, `<div class="col-md-2"><label class="form-label small fw-bold">Group by</label>${groupSel('group_by', f.group_by, L.GROUP_BY)}</div>
      <div class="col-md-2"><label class="form-label small fw-bold">Sub group</label>${groupSel('sub_group', f.sub_group, L.GROUP_BY, '— none —')}</div>`)}</div>
    <button class="btn btn-primary w-100 mt-2 btn-sm">Generate</button>
    <div class="small muted mt-1">Efficiency % = TRUE ÷ (TRUE + FALSE). Unmarked tasks are saved as FALSE automatically the next day. Tasks ticked on a day they were not due ("Extra") and pure Trigger tasks are not counted.</div></form>
    <div class="panel" id="out">${loading}</div>`);
  $('ef').onsubmit = (ev) => { ev.preventDefault(); go('eff', readForm(ev.target)); };
  const my = S.seq;
  const recs = await fetchRecords(f.start, f.end, S.isAdmin ? L.norm(f.user) : null);
  if (my !== S.seq) return;
  const d = L.efficiency(recs, f, S.settings, salaries(), S.isAdmin ? null : S.prof.username);
  const gLabel = (k) => (L.GROUP_BY.find(([v]) => v === k) || [k, k])[1];
  const xrow = (r, sub) => [r.key, sub, r.total, r.done, r.missed, r.pct, r.grade, r.task_fine, r.salary, r.deduct_pct, r.pct_fine, r.total_fine, r.incomplete, r.dept_fine];
  $('btnExp').onclick = () => exportXlsx(`Efficiency_${f.start}_to_${f.end}`, [gLabel(d.group_by), d.sub_group ? gLabel(d.sub_group) : 'Sub group', 'Scheduled', 'Done (TRUE)', 'Missed (FALSE)', 'Efficiency %', 'Grade', 'Per-task Fine', 'Salary', 'Deduct %', '% Fine', 'Auditor Fine', 'Dept Incomplete', 'Dept Fine'],
    d.rows.flatMap((r) => [xrow(r, d.sub_group ? 'ALL' : ''), ...(r.children || []).map((c) => xrow({ ...c, salary: '', deduct_pct: '', pct_fine: '' }, c.sub))]));
  const effRow = (g, isSub) => `<tr class="${isSub ? 'sub-row' : d.sub_group ? 'grp-total' : ''}"><td>${isSub ? '' : `<b>${esc(g.key)}</b>`}</td>${d.sub_group ? `<td>${isSub ? esc(g.sub) : '<span class="muted">All</span>'}</td>` : ''}<td>${g.total}</td><td class="text-success">${g.done}</td><td class="text-danger">${g.missed}</td><td>${pctBar(g.pct)}</td><td class="grade">${esc(g.grade)}</td><td>${money(g.task_fine)}</td>${d.show_pct ? (isSub ? '<td></td><td></td><td></td>' : `<td>${money(g.salary)}</td><td>${g.deduct_pct}%</td><td>${money(g.pct_fine)}</td>`) : ''}<td><b>${money(g.total_fine)}</b></td><td>${g.incomplete || ''}</td><td>${g.dept_fine ? '<b class="text-warning">' + money(g.dept_fine) + '</b>' : ''}</td></tr>`;
  $('out').innerHTML = `<div class="mb-2"><span class="badge bg-secondary">Scheduled: ${d.totals.total}</span> <span class="badge bg-success">Done: ${d.totals.done}</span> <span class="badge bg-danger">Missed: ${d.totals.missed}</span> <span class="badge bg-primary">Efficiency: ${d.totals.pct}%</span> <span class="badge bg-dark">Auditor fine: Rs ${money(d.totals.total_fine)}</span> <span class="badge bg-warning text-dark">Dept incomplete: ${d.totals.incomplete} · Dept fine: Rs ${money(d.totals.dept_fine)}</span> <span class="small muted">Fine mode: ${esc(d.mode)}</span></div>
    <div class="table-wrap">${d.rows.length ? `<table class="table table-sm table-bordered table-hover tbl mb-0"><thead><tr><th>${esc(gLabel(d.group_by))}</th>${d.sub_group ? `<th>${esc(gLabel(d.sub_group))}</th>` : ''}<th>Scheduled</th><th>Done (TRUE)</th><th>Missed (FALSE)</th><th style="min-width:170px">Efficiency</th><th>Grade</th><th>Per-task Fine</th>${d.show_pct ? '<th>Salary</th><th>Deduct %</th><th>% Fine</th>' : ''}<th>Auditor Fine</th><th>Dept Incomplete</th><th>Dept Fine</th></tr></thead><tbody>
    ${d.rows.map((g) => effRow(g, false) + (g.children || []).map((c) => effRow(c, true)).join('')).join('')}
    </tbody></table>` : '<div class="text-center p-4 muted">No records in this range.</div>'}</div>`;
}

async function renderMonthly(q) {
  const t0 = today();
  const start = q.start || t0.slice(0, 8) + '01', end = q.end || t0;
  const ym = start.slice(0, 7);
  const label = `${start} → ${end}`;
  const ms0 = t0.slice(0, 8) + '01', lme0 = L.addDays(ms0, -1);
  const quickM = (l, s, e) => `<a class="btn btn-outline-secondary btn-sm" href="${link('monthly', { ...q, start: s, end: e })}">${l}</a>`;
  const viewLc = S.isAdmin ? L.norm(q.user || '') : S.prof.username_lc;
  mount('monthly', `<div class="panel"><div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2"><h5 class="m-0">Performance Report</h5>
    <div class="d-flex gap-1 flex-wrap">${quickM('This month', ms0, t0)}${quickM('Last month', lme0.slice(0, 8) + '01', lme0)}${S.isAdmin ? `<button class="btn btn-outline-secondary btn-sm" id="btnSave" title="Saves the full month of the start date">💾 Save snapshot of ${ym}</button>` : ''}<button class="btn btn-success btn-sm" id="btnExp">⬇ Export Excel</button></div></div>
    <form id="mf" class="row g-2 align-items-end"><div class="col-md-2"><label class="form-label small fw-bold">Start Date</label><input type="date" name="start" value="${start}" class="form-control form-control-sm"></div>
    <div class="col-md-2"><label class="form-label small fw-bold">End Date</label><input type="date" name="end" value="${end}" class="form-control form-control-sm"></div>
    ${S.isAdmin ? `<div class="col-md-2"><label class="form-label small fw-bold">User</label><select name="user" class="form-select form-select-sm">${opt(auditorNames(), q.user || '', 'All users')}</select></div>` : ''}
    <div class="col-md-2"><button class="btn btn-primary btn-sm w-100">Show</button></div><div class="col-md-4 small muted" id="mInfo"></div></form></div>
    <div class="panel"><div class="table-wrap" id="out">${loading}</div></div>`);
  $('mf').onsubmit = (ev) => { ev.preventDefault(); go('monthly', readForm(ev.target)); };
  const my = S.seq;
  if (start > end) { $('out').innerHTML = '<div class="text-center p-4 text-danger">Start date is after the end date.</div>'; return; }
  const recs = await fetchRecords(start, end, viewLc || null);
  const m = L.monthly(recs, { start, end }, S.settings, salaries(), viewLc ? (S.users.find((u) => u.username_lc === viewLc)?.username || S.prof.username) : null);
  const snap = await getDoc(doc(db, 'monthly', ym)).catch(() => null);
  if (my !== S.seq) return;
  $('mInfo').innerHTML = `Fine mode: <b>${esc(m.mode)}</b> · ${snap && snap.exists() ? 'Month-end snapshot saved on ' + esc(snap.data().generated_at) : 'Snapshot saves automatically on the 1st of next month'}`;
  if ($('btnSave')) $('btnSave').onclick = async () => {
    if (!await askConfirm(`Save / overwrite the month-end snapshot of the full month ${ym}?`)) return;
    const mb = L.monthBounds(ym);
    try { const all = await fetchRecords(mb.start, mb.end, null, true); const n = await saveMonthly(ym, all); log('SAVE_MONTHLY', ym); toast(`Saved ${n} users`); renderMonthly(q); } catch (e) { fail(e); }
  };
  $('btnExp').onclick = () => {
    const rows = [];
    m.rows.forEach((u) => {
      rows.push([label, u.key, 'ALL', u.total, u.done, u.missed, u.pct, u.grade, u.salary, u.task_fine, u.deduct_pct, u.pct_fine, u.total_fine]);
      u.departments.forEach((d) => rows.push([label, u.key, d.department, d.total, d.done, d.missed, d.pct, '', '', '', '', '', '']));
    });
    m.dept_fines.forEach((d) => rows.push([label, 'DEPARTMENT FINE', d.key, d.checked, d.complete, d.incomplete, '', '', '', '', '', '', d.fine]));
    exportXlsx(`Performance_${start}_to_${end}`, ['Period', 'User', 'Department', 'Scheduled / Checked', 'Done / Complete', 'Missed / Incomplete', 'Efficiency %', 'Grade', 'Salary', 'Per-task Fine', 'Deduct %', '% Fine', 'Total Fine'], rows);
  };
  $('out').innerHTML = m.rows.length ? `<table class="table table-sm table-bordered table-hover tbl mb-0"><thead><tr><th>#</th><th>User</th><th>Scheduled</th><th>Done</th><th>Missed</th><th style="min-width:170px">Efficiency</th><th>Grade</th><th>Salary</th><th>Per-task Fine</th><th>Deduct %</th><th>% Fine</th><th>Total Fine</th><th></th></tr></thead><tbody>
    ${m.rows.map((u, i) => `<tr><td>${i + 1}</td><td><b>${esc(u.key)}</b></td><td>${u.total}</td><td class="text-success">${u.done}</td><td class="text-danger">${u.missed}</td><td>${pctBar(u.pct)}</td><td class="grade">${esc(u.grade)}</td><td>${money(u.salary)}</td><td>${money(u.task_fine)}</td><td>${u.deduct_pct}%</td><td>${money(u.pct_fine)}</td><td><b>${money(u.total_fine)}</b></td><td><button class="btn btn-sm btn-outline-primary py-0" data-i="${i}">Details</button></td></tr>`).join('')}
    </tbody></table>` : '<div class="text-center p-4 muted">No records in this date range.</div>';
  if (m.dept_fines.length) {
    $('out').insertAdjacentHTML('beforeend', `<h6 class="mt-3">🏢 Department fines (auditor ticked TRUE and marked the department "Incomplete")</h6>
      <table class="table table-sm table-bordered table-hover tbl mb-0"><thead><tr><th>Organization · Department</th><th>Checked (TRUE)</th><th>Complete</th><th>Incomplete</th><th>Dept Fine (Rs)</th><th></th></tr></thead><tbody>
      ${m.dept_fines.map((d, i) => `<tr><td><b>${esc(d.key)}</b></td><td>${d.checked}</td><td class="text-success">${d.complete}</td><td class="text-warning">${d.incomplete}</td><td><b>${money(d.fine)}</b></td><td>${d.incomplete ? `<button class="btn btn-sm btn-outline-warning py-0" data-df="${i}">Details</button>` : ''}</td></tr>`).join('')}
      </tbody></table>`);
  }
  $('out').onclick = (ev) => {
    const df = ev.target.closest('[data-df]');
    if (df) {
      const d = m.dept_fines[+df.dataset.df];
      showModal(`${d.key} — Incomplete (${label})`, `<table class="table table-sm table-striped"><thead><tr><th>Date</th><th>Check List</th><th>Task</th><th>Auditor</th><th>Remarks</th><th>Pictures</th></tr></thead><tbody>
        ${d.items.map((x) => `<tr><td class="text-nowrap">${x.date}</td><td>${esc(x.checklist)}</td><td>${esc(x.task_type)}</td><td>${esc(x.user)}</td><td>${esc(x.remarks)}</td><td>${x.evidence || ''}</td></tr>`).join('')}</tbody></table>`);
      return;
    }
    const b = ev.target.closest('[data-i]'); if (!b) return;
    const u = m.rows[+b.dataset.i];
    showModal(`${u.key} — ${label}`, `<h6>Department wise</h6><table class="table table-sm table-bordered"><thead><tr><th>Department</th><th>Scheduled</th><th>Done</th><th>Missed</th><th>Efficiency</th></tr></thead><tbody>
      ${u.departments.map((d) => `<tr><td>${esc(d.department)}</td><td>${d.total}</td><td>${d.done}</td><td>${d.missed}</td><td>${pctBar(d.pct)}</td></tr>`).join('')}</tbody></table>
      <h6>Tasks not done (${u.missed_list.length})</h6><table class="table table-sm table-striped"><thead><tr><th>Date</th><th>Department</th><th>Check List</th><th>Task</th><th>Remarks</th></tr></thead><tbody>
      ${u.missed_list.map((x) => `<tr><td class="text-nowrap">${x.date}</td><td>${esc(x.department)}</td><td>${esc(x.checklist)}</td><td>${esc(x.task_type)}</td><td>${esc(x.remarks)}</td></tr>`).join('')}</tbody></table>`);
  };
}

// ------------------------------------------------------------------ audit issues (auditor raises → department clears → auditor verifies)
const ISSUE_ST_BADGE = { Open: 'danger', Reopened: 'danger', Done: 'warning text-dark', Verified: 'success' };
const issueStatusLabel = (st) => (st === 'Done' ? 'Done — waiting audit check' : st === 'Open' ? 'Pending' : st === 'Reopened' ? 'Reopened (not cleared)' : st);
const typeBadge = (t) => (t === 'Major' ? '<span class="badge bg-danger">⚠ Major</span>' : '<span class="badge bg-secondary">Minor</span>');
const short = (x, n = 90) => { const v = String(x || ''); return v.length > n ? v.slice(0, n) + '…' : v; };
const canManage = (i) => S.isAdmin || (S.isAuditor && i.created_by_lc === S.prof.username_lc);

function issueQuery() {
  return S.isDept ? query(collection(db, 'issues'), where('dept_lc', '==', S.prof.dept_lc || '-')) : collection(db, 'issues');
}
function stopIssueWatch() { if (S.issueUnsub) { S.issueUnsub(); S.issueUnsub = null; } S.issues = null; }
function startIssueWatch() {
  stopIssueWatch();
  let first = true;
  S.issueUnsub = onSnapshot(issueQuery(), (snap) => {
    const mineCo = L.norm(S.prof.company || '');
    S.issues = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((i) => !S.isDept || !mineCo || L.norm(i.company) === mineCo);
    if (!first) snap.docChanges().forEach((ch) => { if (ch.type !== 'removed') issueNotify({ id: ch.doc.id, ...ch.doc.data() }); });
    first = false;
    updateIssueBadge();
    if (S.onIssues) S.onIssues();
  }, (e) => console.warn('issues', e));
}
/** Items that need this login's attention (shown as a red number on the tab). */
function issueAttention() {
  if (!S.issues) return 0;
  if (S.isDept) return S.issues.filter((i) => L.ISSUE_PENDING.includes(i.status)).length;
  return S.issues.filter((i) => canManage(i) && (i.status === 'Done' || i.auditor_alert)).length;
}
function updateIssueBadge() {
  const n = issueAttention();
  const b = $('issueBadge');
  if (b) { b.textContent = n || ''; b.classList.toggle('d-none', !n); }
  document.title = (n ? `(${n}) ` : '') + S.settings.APP_TITLE;
}
function notify(title, body, major = false) {
  toast(`${title} — ${body}`, major ? 'danger' : 'info');
  try { if (navigator.vibrate) navigator.vibrate(major ? [200, 100, 200] : 150); } catch (e) { /* ignore */ }
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.ready.then((r) => r.showNotification(title, { body }));
      else new Notification(title, { body });
    }
  } catch (e) { /* phones without a service worker: the toast above is shown instead */ }
}
function issueNotify(i) {
  const h = i.history || [];
  const last = h[h.length - 1];
  if (!last || last.by_lc === S.prof.username_lc) return;
  if (Date.now() - (last.ms || 0) > 5 * 60 * 1000) return;           // only fresh events
  if (!S.isDept && !canManage(i)) return;
  notify(`${i.type === 'Major' ? '⚠ MAJOR ' : ''}${i.no} — ${last.action}`, `${i.company} · ${i.department}${last.note ? ': ' + short(last.note, 80) : ''}`, i.type === 'Major');
}
const histEntry = (action, note = '') => ({ ts: nowText(), ms: Date.now(), by: S.prof.username, by_lc: S.prof.username_lc, role: S.prof.role, action, note: String(note || '').slice(0, 500) });

async function uploadIssueFile(file, issue, side) {
  const img = await compressImage(file);
  const ref = await addDoc(collection(db, 'issue_files'), { issue_id: issue.id || '', dept_lc: issue.dept_lc, side, data: img.data, w: img.w, h: img.h, by: S.prof.username, ts: nowText() });
  return ref.id;
}
async function filesHtml(ids) {
  if (!ids || !ids.length) return '<span class="muted">No picture.</span>';
  const docs = await Promise.all(ids.map((id) => getDoc(doc(db, 'issue_files', id)).catch(() => null)));
  return `<div class="d-flex flex-wrap gap-2">${docs.filter((d) => d && d.exists()).map((d) => { const x = d.data();
    return `<figure class="m-0"><img src="${x.data}" class="iss-thumb rounded border" alt="evidence" title="Click to enlarge"><figcaption class="small muted">${esc(x.by)} · ${esc(x.ts)}</figcaption></figure>`; }).join('')}</div>`;
}
function mailIssue(i) {
  const to = String(S.settings.OWNER_EMAILS || '').split(',').map((x) => x.trim()).filter(Boolean).join(',');
  if (!to) toast('Set the ownership e-mail in Settings → OWNER_EMAILS. The mail opens without "To".', 'warning');
  const a = L.issueAge(i, today());
  const body = [`Audit issue ${i.no} (${i.type})`, `Organization: ${i.company}${i.branch ? ' / ' + i.branch : ''}`, `Department: ${i.department}`,
    `Raised by: ${i.created_by} on ${i.created_at}`, `Status: ${issueStatusLabel(i.status)}`, `Due date: ${i.due_date || 'not set yet'}`, `Pending days: ${a.days_open}`, '',
    'ISSUE:', i.detail, '', 'RECOMMENDATION:', i.recommendation, '', `Pictures: ${(i.evidence_ids || []).length} (see the portal)`, location.origin + location.pathname + '#/issues'].join('\n');
  const url = `mailto:${encodeURIComponent(to).replace(/%2C/g, ',')}?subject=${encodeURIComponent(`[${i.type} audit issue] ${i.no} — ${i.company} ${i.department}`)}&body=${encodeURIComponent(body.slice(0, 1700))}`;
  const aEl = document.createElement('a'); aEl.href = url; aEl.click();
}

function issueFilterOpts() {
  const Ls = L.listings(S.tasks);
  const fromIssues = (k) => (S.issues || []).map((i) => i[k]).filter(Boolean);
  const uniq = (a) => [...new Set(a)].sort((x, y) => String(x).localeCompare(String(y)));
  return { departments: uniq([...Ls.depart, ...fromIssues('department')]), branches: uniq([...Ls.branch, ...fromIssues('branch')]), raisers: uniq(fromIssues('created_by')) };
}

async function renderIssues(q) {
  mount('issues', loading);
  S.onIssues = () => drawIssues(q);
  if (S.issues) drawIssues(q);
}
function drawIssues(q) {
  if (!$('main')) return;
  const t = today();
  const tab = q.tab || 'pending';
  const all = (S.issues || []).filter((i) => (!q.company || i.company === q.company) && (!q.department || i.department === q.department)
    && (!q.type || i.type === q.type) && (!q.q || L.norm([i.no, i.detail, i.recommendation, i.department, i.dept_remarks].join(' ')).includes(L.norm(q.q))));
  const inTab = { pending: (i) => L.ISSUE_PENDING.includes(i.status), done: (i) => i.status === 'Done', verified: (i) => i.status === 'Verified', all: () => true };
  const list = all.filter(inTab[tab] || inTab.pending).map((i) => ({ ...i, age: L.issueAge(i, t) }))
    .sort((a, b) => (b.type === 'Major') - (a.type === 'Major') || (a.created_at < b.created_at ? -1 : 1));
  if (tab === 'verified' || tab === 'all') list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const pend = all.filter(inTab.pending);
  const cnt = { pending: pend.length, major: pend.filter((i) => i.type === 'Major').length, overdue: pend.filter((i) => L.issueAge(i, t).overdue_days).length,
    nodue: pend.filter((i) => !i.due_date).length, done: all.filter(inTab.done).length, verified: all.filter(inTab.verified).length };
  const tabs = S.isDept ? [['pending', 'Pending', cnt.pending], ['done', 'Done (waiting audit check)', cnt.done], ['verified', 'Verified / Closed', cnt.verified]]
    : [['pending', 'Pending', cnt.pending], ['done', 'Done — verify', cnt.done], ['verified', 'Verified', cnt.verified], ['all', 'All', all.length]];
  const qs = { company: q.company, department: q.department, type: q.type, q: q.q };
  const card = (cls, lbl, v) => `<div class="col-6 col-md-2"><div class="stat-card ${cls}"><div class="lbl">${lbl}</div><div class="val">${v}</div></div></div>`;
  const newMajor = S.isDept ? pend.filter((i) => i.type === 'Major' && !i.dept_seen) : [];
  const alerts = S.isDept ? [] : (S.issues || []).filter((i) => canManage(i) && i.auditor_alert);
  const td = (label, html, cls = '') => `<td data-label="${label}" class="${cls}">${html}</td>`;
  const canAsk = 'Notification' in window && Notification.permission === 'default';
  $('main').innerHTML = `<div class="row g-2 mb-2">${card('bg-amber', 'Pending', cnt.pending)}${card('bg-red', 'Major pending', cnt.major)}${card('bg-red', 'Overdue', cnt.overdue)}${card('bg-slate', 'No due date yet', cnt.nodue)}${card('bg-blue', S.isDept ? 'Done (waiting check)' : 'Waiting your check', cnt.done)}${card('bg-green', 'Verified', cnt.verified)}</div>
    ${newMajor.length ? `<div class="alert alert-danger py-2 mb-2 blink-soft">⚠ <b>${newMajor.length} new MAJOR issue(s)</b> for your department: ${newMajor.map((i) => `<button class="btn btn-sm btn-danger py-0 ms-1 iss-open" data-id="${i.id}">${esc(i.no)}</button>`).join('')} — please set a due date.</div>` : ''}
    ${alerts.length ? `<div class="alert alert-info py-2 mb-2">🔔 Department updates: ${alerts.map((i) => `<button class="btn btn-sm btn-outline-dark py-0 ms-1 iss-open" data-id="${i.id}">${esc(i.no)} · ${esc(i.auditor_alert)}</button>`).join('')}</div>` : ''}
    <div class="panel"><form id="isf" class="d-flex flex-wrap gap-2 align-items-center">
      ${S.isAuditor ? '<a class="btn btn-danger btn-sm" href="#/issues/new">＋ Raise Audit Issue</a>' : ''}
      <input name="q" value="${esc(q.q || '')}" class="form-control form-control-sm" style="max-width:220px" placeholder="Search no / issue / remarks…">
      <select name="company" class="form-select form-select-sm" style="width:auto">${opt(L.SHEET_LISTS.company, q.company || '', 'RC & RCG')}</select>
      ${S.isDept ? '' : `<select name="department" class="form-select form-select-sm" style="width:auto">${opt(issueFilterOpts().departments, q.department || '', 'All departments')}</select>`}
      <select name="type" class="form-select form-select-sm" style="width:auto">${opt(L.ISSUE_TYPES, q.type || '', 'Minor & Major')}</select>
      <input type="hidden" name="tab" value="${tab}"><button class="btn btn-outline-primary btn-sm">Filter</button>
      ${canAsk ? '<button type="button" class="btn btn-outline-warning btn-sm" id="btnNotif">🔔 Turn on alerts</button>' : ''}
      <a class="btn btn-outline-info btn-sm ms-auto" href="#/ireport">📊 Issue Reports</a></form>
      ${S.isDept ? `<div class="small muted mt-1">Department: <b>${esc(S.prof.department)}</b>${S.prof.company ? ' · ' + esc(S.prof.company) : ' · RC & RCG'}. Open an issue → set the due date → fix it → write remarks, add pictures → <b>Mark Done</b>. The auditor then verifies it.</div>` : ''}</div>
    <ul class="nav nav-pills mb-2 gap-1">${tabs.map(([k, l, n]) => `<li class="nav-item"><a class="nav-link py-1 ${tab === k ? 'active' : ''}" href="${link('issues', { ...qs, tab: k })}">${l} <span class="badge bg-light text-dark">${n}</span></a></li>`).join('')}</ul>
    <div class="panel"><div class="table-wrap">${list.length ? `<table class="table table-sm table-bordered table-hover tbl tbl-cards mb-0"><thead><tr><th>No</th><th>Raised on</th><th>Organization</th><th>Department</th><th>Type</th><th>Issue</th><th>Raised by</th><th>Due date</th><th>Pending days</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((i) => `<tr class="${i.type === 'Major' ? 'iss-major' : ''} ${S.isDept && !i.dept_seen && i.age.pending ? 'iss-new' : ''}">
        ${td('No', `<b>${esc(i.no)}</b>${S.isDept && !i.dept_seen && i.age.pending ? ' <span class="badge bg-warning text-dark">NEW</span>' : ''}`, 'm-title')}
        ${td('Raised on', esc(i.created_date))}${td('Organization', esc(i.company) + (i.branch ? ' / ' + esc(i.branch) : ''))}${td('Department', esc(i.department))}
        ${td('Type', typeBadge(i.type))}${td('Issue', esc(short(i.detail)))}${td('Raised by', esc(i.created_by))}
        ${td('Due date', i.due_date ? `${esc(i.due_date)}${i.age.overdue_days ? ` <span class="badge bg-danger">${i.age.late ? 'late' : 'overdue'} ${i.age.overdue_days}d</span>` : ''}` : '<span class="text-warning">not set</span>')}
        ${td('Pending days', `<b>${i.age.days_open}</b> day(s)${i.age.cleared ? `<div class="small muted">cleared ${esc(i.age.cleared)}</div>` : ''}`)}
        ${td('Status', `<span class="badge bg-${ISSUE_ST_BADGE[i.status] || 'secondary'}">${esc(issueStatusLabel(i.status))}</span>`)}
        ${td('', `<button class="btn btn-sm btn-primary py-0 iss-open" data-id="${i.id}">Open</button>`)}</tr>`).join('')}
      </tbody></table>` : `<div class="text-center p-4 muted">${S.issues ? 'Nothing here.' : 'Loading…'}</div>`}</div></div>`;
  $('isf').onsubmit = (ev) => { ev.preventDefault(); go('issues', readForm(ev.target)); };
  if ($('btnNotif')) $('btnNotif').onclick = async () => { try { await Notification.requestPermission(); } catch (e) { /* ignore */ } drawIssues(q); };
  $('main').onclick = (ev) => { const b = ev.target.closest('.iss-open'); if (b) openIssue(b.dataset.id); };
}

async function renderIssueForm() {
  if (!S.isAuditor) return go('issues');
  const o = issueFilterOpts();
  mount('issues', `<form id="nif" class="panel" style="max-width:900px"><div class="d-flex justify-content-between align-items-center mb-2"><h5 class="m-0">Raise Audit Issue</h5><a class="btn btn-sm btn-outline-secondary" href="#/issues">← Back</a></div>
    <div class="row g-2">
      <div class="col-md-3"><label class="form-label fw-semibold">Organization <span class="text-danger">*</span></label><select name="company" class="form-select form-select-sm" required>${opt(L.SHEET_LISTS.company, '', '— select —')}</select></div>
      <div class="col-md-3"><label class="form-label fw-semibold">Department <span class="text-danger">*</span></label><select name="department" class="form-select form-select-sm" required>${opt(o.departments, '', '— select —')}</select></div>
      <div class="col-md-3"><label class="form-label fw-semibold">Branch</label><select name="branch" class="form-select form-select-sm">${opt(o.branches, '', '— optional —')}</select></div>
      <div class="col-md-3"><label class="form-label fw-semibold">Issue type <span class="text-danger">*</span></label><div class="d-flex gap-3 pt-1">
        <div class="form-check"><input class="form-check-input" type="radio" name="type" id="tMin" value="Minor" checked><label class="form-check-label" for="tMin">Minor</label></div>
        <div class="form-check"><input class="form-check-input" type="radio" name="type" id="tMaj" value="Major"><label class="form-check-label text-danger fw-bold" for="tMaj">⚠ Major</label></div></div></div>
      <div class="col-md-12"><label class="form-label fw-semibold">E-mail this point to ownership?</label><div class="d-flex gap-3">
        <div class="form-check"><input class="form-check-input" type="radio" name="email_owner" id="eN" value="No" checked><label class="form-check-label" for="eN">No</label></div>
        <div class="form-check"><input class="form-check-input" type="radio" name="email_owner" id="eY" value="Yes"><label class="form-check-label" for="eY">Yes — open an e-mail to ${esc(S.settings.OWNER_EMAILS || '(set OWNER_EMAILS in Settings)')}</label></div></div></div>
      <div class="col-12"><label class="form-label fw-semibold">Issue detail <span class="text-danger">*</span></label><textarea name="detail" rows="4" class="form-control" required placeholder="What did you find? Where, when, how much…"></textarea></div>
      <div class="col-12"><label class="form-label fw-semibold">Recommendation <span class="text-danger">*</span></label><textarea name="recommendation" rows="3" class="form-control" required placeholder="What should the department do to clear it?"></textarea></div>
      <div class="col-12"><label class="form-label fw-semibold">Evidence pictures <span class="muted fw-normal">(up to 5 — camera opens on mobile)</span></label>
        <div class="d-flex gap-2 align-items-center flex-wrap"><button type="button" class="btn btn-outline-secondary btn-sm" id="pickPic">📷 Add picture</button><input type="file" accept="image/*" capture="environment" multiple class="d-none" id="picIn"><div id="picPrev" class="d-flex gap-2 flex-wrap"></div></div></div>
    </div>
    <div id="nerr" class="text-danger small mt-2"></div>
    <button class="btn btn-danger mt-3 px-4" id="nSubmit">Submit issue</button></form>`);
  const files = [];
  const prev = () => { $('picPrev').innerHTML = files.map((f, k) => `<span class="badge text-bg-light border p-1">🖼 ${esc(f.name.slice(0, 18))} <a href="#" data-k="${k}" class="text-danger ms-1 rmPic">✕</a></span>`).join(''); };
  $('pickPic').onclick = () => $('picIn').click();
  $('picIn').onchange = (ev) => { [...ev.target.files].forEach((f) => { if (files.length < 5) files.push(f); }); ev.target.value = ''; prev(); };
  $('picPrev').onclick = (ev) => { const a = ev.target.closest('.rmPic'); if (a) { ev.preventDefault(); files.splice(+a.dataset.k, 1); prev(); } };
  $('nif').onsubmit = async (ev) => {
    ev.preventDefault();
    const v = readForm(ev.target);
    const btn = $('nSubmit'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      if (!v.detail.trim() || !v.recommendation.trim()) throw new Error('Issue detail and recommendation are required.');
      const dept_lc = L.norm(v.department);
      const ids = [];
      for (const f of files) ids.push(await uploadIssueFile(f, { dept_lc }, 'auditor'));
      const n = await runTransaction(db, async (tx) => {
        const ref = doc(db, 'counters', 'issues');
        const c = await tx.get(ref);
        const next = (c.exists() ? Number(c.data().n) || 0 : 0) + 1;
        tx.set(ref, { n: next });
        return next;
      });
      const ts = nowText();
      const issue = { no: 'AUD-' + String(n).padStart(4, '0'), seq: n, company: v.company, branch: v.branch || '', department: v.department, dept_lc,
        type: v.type === 'Major' ? 'Major' : 'Minor', email_owner: v.email_owner === 'Yes', emailed: false,
        detail: v.detail.trim().slice(0, 4000), recommendation: v.recommendation.trim().slice(0, 4000), evidence_ids: ids,
        created_by: S.prof.username, created_by_lc: S.prof.username_lc, created_at: ts, created_date: today(), status: 'Open',
        due_date: '', due_set_by: '', due_set_at: '', dept_remarks: '', dept_evidence_ids: [], done_by: '', done_at: '', done_date: '',
        verify_remarks: '', verified_by: '', verified_at: '', verified_date: '', dept_seen: false, auditor_alert: '', updated_at: ts,
        history: [histEntry('Raised', `${v.type} issue raised`)] };
      const ref = await addDoc(collection(db, 'issues'), issue);
      log('RAISE_ISSUE', `${issue.no} ${issue.department}`);
      toast(`${issue.no} raised for ${issue.department}`);
      if (issue.email_owner) {
        mailIssue({ ...issue, id: ref.id });
        await updateDoc(doc(db, 'issues', ref.id), { emailed: true, history: arrayUnion(histEntry('E-mail to ownership opened')) }).catch(() => {});
      }
      go('issues');
    } catch (e) { $('nerr').textContent = friendly(e); btn.disabled = false; btn.textContent = 'Submit issue'; }
  };
}

async function openIssue(id) {
  const i = (S.issues || []).find((x) => x.id === id);
  if (!i) return toast('Issue not found', 'warning');
  const t = today(), a = L.issueAge(i, t);
  const pending = L.ISSUE_PENDING.includes(i.status);
  const row = (k, v) => `<div class="col-6 col-md-4"><div class="small muted">${k}</div><div class="fw-semibold">${v}</div></div>`;
  let actions = '';
  if (S.isDept && pending) {
    actions = `<div class="iss-box"><h6>Your action</h6>
      <div class="row g-2 align-items-end"><div class="col-md-5"><label class="form-label small fw-bold">Due date (when it will be cleared)</label><input type="date" id="ixDue" class="form-control form-control-sm" min="${t}" value="${esc(i.due_date)}"></div>
      <div class="col-md-4"><button class="btn btn-sm btn-primary w-100" id="ixSaveDue">${i.due_date ? 'Change due date' : 'Save due date'}</button></div></div>
      <label class="form-label small fw-bold mt-3">Remarks — what was done to clear it <span class="text-danger">*</span></label><textarea id="ixRem" rows="3" class="form-control">${esc(i.dept_remarks)}</textarea>
      <div class="d-flex gap-2 align-items-center mt-2 flex-wrap"><button class="btn btn-sm btn-outline-secondary" id="ixPic">📷 Add picture</button><input type="file" accept="image/*" capture="environment" class="d-none" id="ixPicIn"><span class="small muted" id="ixPicN">${(i.dept_evidence_ids || []).length} picture(s)</span>
      <button class="btn btn-sm btn-success ms-auto" id="ixDone">✔ Mark Done</button></div></div>`;
  }
  if (S.isAuditor && i.status === 'Done') {
    actions = `<div class="iss-box"><h6>Cross-verify</h6><label class="form-label small fw-bold">Verification remarks</label><textarea id="ixVer" rows="2" class="form-control" placeholder="What did you check?"></textarea>
      <div class="d-flex gap-2 mt-2"><button class="btn btn-sm btn-success" id="ixOk">✔ Verified — issue cleared</button><button class="btn btn-sm btn-outline-danger" id="ixNo">✖ Not cleared — send back</button></div></div>`;
  }
  const tools = `<div class="d-flex gap-2 mt-3 flex-wrap">${S.isAuditor ? '<button class="btn btn-sm btn-outline-info" id="ixMail">✉ E-mail ownership</button>' : ''}${S.isAdmin ? '<button class="btn btn-sm btn-outline-danger ms-auto" id="ixDel">🗑 Delete issue</button>' : ''}</div>`;
  showModal(`${i.no} — ${i.department}`, `<div class="d-flex gap-2 align-items-center mb-2">${typeBadge(i.type)}<span class="badge bg-${ISSUE_ST_BADGE[i.status] || 'secondary'}">${esc(issueStatusLabel(i.status))}</span>${i.email_owner ? '<span class="badge bg-info text-dark">✉ ownership</span>' : ''}</div>
    <div class="row g-2 mb-2">${row('Organization / Branch', esc(i.company) + (i.branch ? ' / ' + esc(i.branch) : ''))}${row('Department', esc(i.department))}${row('Raised by', `${esc(i.created_by)}<div class="small muted">${esc(i.created_at)}</div>`)}
      ${row('Due date', i.due_date ? `${esc(i.due_date)}<div class="small muted">set by ${esc(i.due_set_by)}</div>` : '<span class="text-warning">Not set yet</span>')}
      ${row('Pending days', `${a.days_open} day(s)${a.overdue_days ? ` <span class="badge bg-danger">${a.late ? 'late' : 'overdue'} ${a.overdue_days}d</span>` : ''}`)}
      ${row('Cleared / Verified', `${esc(i.done_date || '—')} / ${esc(i.verified_date || '—')}${a.days_to_verify != null ? `<div class="small muted">${a.days_to_verify} day(s) in total</div>` : ''}`)}</div>
    <div class="iss-box"><h6>Issue</h6><div class="pre">${esc(i.detail)}</div><h6 class="mt-2">Recommendation</h6><div class="pre">${esc(i.recommendation)}</div><h6 class="mt-2">Auditor's pictures</h6><div id="ixA">${loading}</div></div>
    <div class="iss-box"><h6>Department response</h6>${i.dept_remarks ? `<div class="pre">${esc(i.dept_remarks)}</div><div class="small muted">${esc(i.done_by)} ${esc(i.done_at)}</div>` : '<span class="muted">No response yet.</span>'}<div id="ixD" class="mt-2"></div></div>
    ${i.verify_remarks || i.verified_by ? `<div class="iss-box"><h6>Verification</h6><div class="pre">${esc(i.verify_remarks || '')}</div><div class="small muted">${esc(i.verified_by)} ${esc(i.verified_at)}</div></div>` : ''}
    ${actions}${tools}
    <details class="mt-3"><summary class="small fw-bold">History (${(i.history || []).length})</summary><ul class="small mt-2">${(i.history || []).map((h) => `<li><b>${esc(h.ts)}</b> — ${esc(h.by)} (${esc(h.role)}): ${esc(h.action)}${h.note ? ' — ' + esc(h.note) : ''}</li>`).join('')}</ul></details>`);
  filesHtml(i.evidence_ids).then((h) => { if ($('ixA')) $('ixA').innerHTML = h; });
  if ((i.dept_evidence_ids || []).length) filesHtml(i.dept_evidence_ids).then((h) => { if ($('ixD')) $('ixD').innerHTML = h; });
  $('detailBody').onclick = (ev) => { if (ev.target.classList.contains('iss-thumb')) ev.target.classList.toggle('big'); };
  // seen flags
  if (S.isDept && !i.dept_seen) updateDoc(doc(db, 'issues', id), { dept_seen: true }).catch(() => {});
  if (canManage(i) && i.auditor_alert) updateDoc(doc(db, 'issues', id), { auditor_alert: '' }).catch(() => {});
  const upd = async (data, msg) => {
    try { await updateDoc(doc(db, 'issues', id), { ...data, updated_at: nowText() }); toast(msg); bootstrap.Modal.getOrCreateInstance($('detailModal')).hide(); } catch (e) { fail(e); }
  };
  if ($('ixSaveDue')) $('ixSaveDue').onclick = () => {
    const d = $('ixDue').value;
    if (!d) return toast('Choose a date', 'warning');
    if (d < t) return toast('Due date cannot be in the past', 'warning');
    upd({ due_date: d, due_set_by: S.prof.username, due_set_at: nowText(), dept_seen: true, auditor_alert: `due date ${d}`,
      history: arrayUnion(histEntry(i.due_date ? 'Due date changed' : 'Due date set', `${i.due_date ? i.due_date + ' → ' : ''}${d}`)) }, `Due date ${d} saved — the auditor is notified`);
  };
  if ($('ixPic')) {
    $('ixPic').onclick = () => $('ixPicIn').click();
    $('ixPicIn').onchange = async (ev) => {
      const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
      const cur = (S.issues.find((x) => x.id === id) || i).dept_evidence_ids || [];
      if (cur.length >= 5) return toast('Maximum 5 pictures.', 'warning');
      try {
        $('ixPicN').textContent = 'Uploading…';
        const fid = await uploadIssueFile(f, i, 'department');
        await updateDoc(doc(db, 'issues', id), { dept_evidence_ids: [...cur, fid], updated_at: nowText() });
        $('ixPicN').textContent = `${cur.length + 1} picture(s)`;
        filesHtml([...cur, fid]).then((h) => { if ($('ixD')) $('ixD').innerHTML = h; });
      } catch (e) { $('ixPicN').textContent = ''; fail(e); }
    };
  }
  if ($('ixDone')) $('ixDone').onclick = async () => {
    const rem = $('ixRem').value.trim();
    if (!rem) return toast('Write remarks: what was done to clear the issue.', 'warning');
    if (!await askConfirm(`Mark ${i.no} as Done? The auditor will check it.`, 'Mark Done')) return;
    upd({ status: 'Done', dept_remarks: rem.slice(0, 4000), done_by: S.prof.username, done_at: nowText(), done_date: t, dept_seen: true, auditor_alert: 'marked Done',
      history: arrayUnion(histEntry('Marked Done by department', rem)) }, `${i.no} marked Done — sent to the auditor`);
  };
  if ($('ixOk')) $('ixOk').onclick = () => upd({ status: 'Verified', verify_remarks: $('ixVer').value.trim(), verified_by: S.prof.username, verified_at: nowText(), verified_date: t, auditor_alert: '',
    history: arrayUnion(histEntry('Verified — issue cleared', $('ixVer').value.trim())) }, `${i.no} verified ✔ — moved to Verified`);
  if ($('ixNo')) $('ixNo').onclick = () => {
    const r = $('ixVer').value.trim();
    if (!r) return toast('Write why it is not cleared.', 'warning');
    upd({ status: 'Reopened', verify_remarks: r, done_date: '', dept_seen: false, auditor_alert: '',
      history: arrayUnion(histEntry('Not cleared — sent back to department', r)) }, `${i.no} sent back to ${i.department}`);
  };
  if ($('ixMail')) $('ixMail').onclick = () => { mailIssue(i); updateDoc(doc(db, 'issues', id), { emailed: true, history: arrayUnion(histEntry('E-mail to ownership opened')) }).catch(() => {}); };
  if ($('ixDel')) $('ixDel').onclick = async () => {
    if (!await askConfirm(`Delete ${i.no} permanently? This cannot be undone.`, 'Delete')) return;
    try {
      await deleteDoc(doc(db, 'issues', id));
      await Promise.all([...(i.evidence_ids || []), ...(i.dept_evidence_ids || [])].map((f) => deleteDoc(doc(db, 'issue_files', f)).catch(() => {})));
      log('DELETE_ISSUE', i.no); toast(`${i.no} deleted`); bootstrap.Modal.getOrCreateInstance($('detailModal')).hide();
    } catch (e) { fail(e); }
  };
}

// ------------------------------------------------------------------ audit issue reports
async function renderIssueReport(q) {
  mount('ireport', loading);
  S.onIssues = () => drawIssueReport(q);
  if (S.issues) drawIssueReport(q);
}
function drawIssueReport(q) {
  if (!$('main')) return;
  const t = today();
  const f = { start: q.start || t.slice(0, 8) + '01', end: q.end || t, company: q.company || '', department: S.isDept ? '' : (q.department || ''), type: q.type || '',
    status: q.status || '', raised_by: q.raised_by || '', branch: q.branch || '', overdue: q.overdue || '', q: q.q || '', group_by: q.group_by || (S.isDept ? 'type' : 'department'), sub_group: q.sub_group || '' };
  const o = issueFilterOpts();
  const rp = L.issueReport(S.issues || [], f, t);
  const gl = (k) => (L.ISSUE_GROUP_BY.find(([v]) => v === k) || [k, k])[1];
  const T = rp.totals;
  const col = (lbl, inner, w = 2) => `<div class="col-md-${w}"><label class="form-label small fw-bold">${lbl}</label>${inner}</div>`;
  const sumRow = (g, sub) => `<tr class="${sub ? 'sub-row' : rp.sub_group ? 'grp-total' : ''}"><td>${sub ? '' : `<b>${esc(g.key)}</b>`}</td>${rp.sub_group ? `<td>${sub ? esc(g.sub) : '<span class="muted">All</span>'}</td>` : ''}
    <td>${g.total}</td><td class="text-danger">${g.major}</td><td>${g.minor}</td><td class="text-warning">${g.pending}</td><td>${g.done}</td><td class="text-success">${g.verified}</td><td class="text-danger">${g.overdue || ''}</td><td>${g.no_due || ''}</td><td>${g.avg_days}</td><td>${pctBar(g.on_time_pct)}</td><td>${pctBar(g.close_pct)}</td></tr>`;
  $('main').innerHTML = `<form id="irf" class="panel"><div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2"><h5 class="m-0">Audit Issue Reports</h5>
      <div class="d-flex gap-1"><button type="button" class="btn btn-success btn-sm" id="irxS">⬇ Summary Excel</button><button type="button" class="btn btn-success btn-sm" id="irxL">⬇ Full list Excel</button></div></div>
    <div class="row g-2">${col('Raised from', `<input type="date" name="start" value="${f.start}" class="form-control form-control-sm">`)}${col('Raised to', `<input type="date" name="end" value="${f.end}" class="form-control form-control-sm">`)}
      ${col('Organization', `<select name="company" class="form-select form-select-sm">${opt(L.SHEET_LISTS.company, f.company, 'RC & RCG')}</select>`)}
      ${S.isDept ? '' : col('Department', `<select name="department" class="form-select form-select-sm">${opt(o.departments, f.department, 'All departments')}</select>`)}
      ${col('Issue type', `<select name="type" class="form-select form-select-sm">${opt(L.ISSUE_TYPES, f.type, 'Minor & Major')}</select>`)}
      ${col('Status', `<select name="status" class="form-select form-select-sm"><option value="">All</option>${[['Pending', 'Pending (Open + Reopened)'], ['Open', 'Open'], ['Reopened', 'Reopened'], ['Done', 'Done — waiting check'], ['Verified', 'Verified']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
      ${col('Raised by', `<select name="raised_by" class="form-select form-select-sm">${opt(o.raisers, f.raised_by, 'All auditors')}</select>`)}
      ${col('Branch', `<select name="branch" class="form-select form-select-sm">${opt(o.branches, f.branch, 'All branches')}</select>`)}
      ${col('Group by', `<select name="group_by" class="form-select form-select-sm">${L.ISSUE_GROUP_BY.map(([v, l]) => `<option value="${v}" ${f.group_by === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
      ${col('Sub group', `<select name="sub_group" class="form-select form-select-sm"><option value="">— none —</option>${L.ISSUE_GROUP_BY.map(([v, l]) => `<option value="${v}" ${f.sub_group === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
      ${col('Search', `<input name="q" value="${esc(f.q)}" class="form-control form-control-sm" placeholder="no / text">`)}
      <div class="col-md-2 d-flex align-items-end"><div class="form-check"><input class="form-check-input" type="checkbox" name="overdue" value="1" id="irO" ${f.overdue ? 'checked' : ''}><label class="form-check-label small fw-bold" for="irO">Overdue only</label></div></div></div>
    <button class="btn btn-primary w-100 mt-2 btn-sm">Generate</button>
    <div class="small muted mt-1"><b>Pending days</b> = raised date → date the department marked Done (or today). <b>On-time %</b> = cleared on or before the due date. <b>Closed %</b> = verified ÷ total.</div></form>
    <div class="panel"><div class="mb-2"><span class="badge bg-secondary">Total: ${T.total}</span> <span class="badge bg-danger">Major: ${T.major}</span> <span class="badge bg-secondary">Minor: ${T.minor}</span> <span class="badge bg-warning text-dark">Pending: ${T.pending}</span> <span class="badge bg-info text-dark">Waiting check: ${T.done}</span> <span class="badge bg-success">Verified: ${T.verified}</span> <span class="badge bg-danger">Overdue: ${T.overdue}</span> <span class="badge bg-dark">Avg days to clear: ${T.avg_days}</span> <span class="badge bg-primary">On-time: ${T.on_time_pct}%</span></div>
    <div class="table-wrap">${rp.rows.length ? `<table class="table table-sm table-bordered table-hover tbl mb-0"><thead><tr><th>${esc(gl(rp.group_by))}</th>${rp.sub_group ? `<th>${esc(gl(rp.sub_group))}</th>` : ''}<th>Total</th><th>Major</th><th>Minor</th><th>Pending</th><th>Waiting check</th><th>Verified</th><th>Overdue</th><th>No due date</th><th>Avg days to clear</th><th style="min-width:150px">On-time %</th><th style="min-width:150px">Closed %</th></tr></thead><tbody>
      ${rp.rows.map((g) => sumRow(g, false) + (g.children || []).map((c) => sumRow(c, true)).join('')).join('')}</tbody></table>` : `<div class="text-center p-4 muted">${S.issues ? 'No issues in this range.' : 'Loading…'}</div>`}</div></div>
    <div class="panel"><h6>Issue list (${rp.items.length})</h6><div class="table-wrap">${rp.items.length ? `<table class="table table-sm table-striped table-bordered tbl mb-0"><thead><tr><th>No</th><th>Raised</th><th>Organization</th><th>Department</th><th>Type</th><th>Issue</th><th>Raised by</th><th>Due</th><th>Cleared</th><th>Verified</th><th>Pending days</th><th>Overdue</th><th>Status</th><th></th></tr></thead><tbody>
      ${rp.items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((i) => { const a = L.issueAge(i, t); return `<tr><td class="text-nowrap"><b>${esc(i.no)}</b></td><td class="text-nowrap">${esc(i.created_date)}</td><td>${esc(i.company)}</td><td>${esc(i.department)}</td><td>${typeBadge(i.type)}</td><td class="small">${esc(short(i.detail, 70))}</td><td>${esc(i.created_by)}</td><td class="text-nowrap">${esc(i.due_date || '—')}</td><td class="text-nowrap">${esc(i.done_date || '—')}</td><td class="text-nowrap">${esc(i.verified_date || '—')}</td><td>${a.days_open}</td><td>${a.overdue_days ? `<span class="text-danger">${a.overdue_days}d${a.late ? ' late' : ''}</span>` : ''}</td><td><span class="badge bg-${ISSUE_ST_BADGE[i.status] || 'secondary'}">${esc(issueStatusLabel(i.status))}</span></td><td><button class="btn btn-sm btn-outline-primary py-0 iss-open" data-id="${i.id}">Open</button></td></tr>`; }).join('')}
      </tbody></table>` : '<div class="text-center p-3 muted">—</div>'}</div></div>`;
  $('irf').onsubmit = (ev) => { ev.preventDefault(); go('ireport', readForm(ev.target)); };
  $('main').onclick = (ev) => { const b = ev.target.closest('.iss-open'); if (b) openIssue(b.dataset.id); };
  const xs = (g, sub) => [g.key, sub, g.total, g.major, g.minor, g.pending, g.done, g.verified, g.overdue, g.no_due, g.avg_days, g.on_time_pct, g.close_pct];
  $('irxS').onclick = () => exportXlsx(`Issue_Summary_${f.start}_to_${f.end}`, [gl(rp.group_by), rp.sub_group ? gl(rp.sub_group) : 'Sub group', 'Total', 'Major', 'Minor', 'Pending', 'Waiting check', 'Verified', 'Overdue', 'No due date', 'Avg days to clear', 'On-time %', 'Closed %'],
    [...rp.rows.flatMap((g) => [xs(g, rp.sub_group ? 'ALL' : ''), ...(g.children || []).map((c) => xs(c, c.sub))]), xs(T, 'TOTAL')]);
  $('irxL').onclick = () => exportXlsx(`Issue_List_${f.start}_to_${f.end}`, ['No', 'Raised on', 'Raised at', 'Raised by', 'Organization', 'Branch', 'Department', 'Type', 'E-mail ownership', 'Issue', 'Recommendation', 'Auditor pictures', 'Due date', 'Due set by', 'Department remarks', 'Department pictures', 'Done by', 'Cleared on', 'Verified by', 'Verified on', 'Verification remarks', 'Pending days', 'Overdue days', 'Status'],
    rp.items.map((i) => { const a = L.issueAge(i, t); return [i.no, i.created_date, i.created_at, i.created_by, i.company, i.branch, i.department, i.type, i.email_owner ? 'Yes' : 'No', i.detail, i.recommendation, (i.evidence_ids || []).length, i.due_date, i.due_set_by, i.dept_remarks, (i.dept_evidence_ids || []).length, i.done_by, i.done_date, i.verified_by, i.verified_date, i.verify_remarks, a.days_open, a.overdue_days, issueStatusLabel(i.status)]; }));
}

// ------------------------------------------------------------------ admin: tasks
function renderAdminTasks(q) {
  const show = q.show || 'active';
  const t = today();
  const Ls = L.listings(S.tasks, S.users.map((u) => u.username));
  const mine = (x) => S.isAdmin || x.user_lc === S.prof.username_lc;
  const list = [...S.tasks].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).filter((x) => {
    if (!mine(x) || (!S.isAdmin && x.hidden)) return false;
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
      <a class="btn btn-primary btn-sm" href="#/admin/task">＋ Add New Task</a> <a class="btn btn-outline-info btn-sm" href="#/admin/log">📜 Change log</a>
      <input name="q" value="${esc(q.q || '')}" class="form-control form-control-sm" style="max-width:240px" placeholder="Search check list / detail / user / SOP…">
      <select name="dept" class="form-select form-select-sm" style="width:auto">${opt(Ls.depart, q.dept || '', 'All departments')}</select>
      <select name="branch" class="form-select form-select-sm" style="width:auto">${opt(Ls.branch, q.branch || '', 'All branches')}</select>
      ${S.isAdmin ? `<select name="user" class="form-select form-select-sm" style="width:auto">${opt(Ls.user, q.user || '', 'All users')}</select>` : ''}
      <select name="show" class="form-select form-select-sm" style="width:auto">${(S.isAdmin ? [['active', 'Active tasks'], ['hidden', 'Hidden tasks'], ['today', 'Due today (Y)'], ['all', 'All']] : [['active', 'All my tasks'], ['today', 'Due today (Y)']]).map(([v, l]) => `<option value="${v}" ${show === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn btn-outline-primary btn-sm">Filter</button><span class="muted small">${list.length} of ${S.tasks.filter(mine).length} rows</span></form>
      <div class="small muted mt-1">One row = one check-list point. Rows with the same Check List, Task, Branch and User show as one line in the portal. Use <b>＋ Point</b> to add another point to the same check list.</div></div>
    ${S.isAdmin ? '' : '<div class="small muted mb-1 px-1">You can add your own tasks and change Recurrence, Target, SOP etc. Every change is saved in the 📜 Change log (old → new). Only the admin can hide or delete a task.</div>'}
    <div class="panel">${S.isAdmin ? '<div class="d-flex gap-2 mb-2"><button class="btn btn-sm btn-outline-warning" data-act="hide">Hide selected</button><button class="btn btn-sm btn-outline-success" data-act="unhide">Unhide selected</button><button class="btn btn-sm btn-outline-danger" data-act="delete">Delete selected</button></div>' : ''}
    <div class="table-wrap"><table class="table table-sm table-bordered table-hover tbl mb-0"><thead><tr>${S.isAdmin ? '<th><input type="checkbox" id="selAll" class="form-check-input"></th>' : ''}<th>Today</th><th>Depart</th><th>Check List</th><th>Detail</th><th>Task</th><th>User</th><th>Recurrence</th><th>Target</th><th>Organization</th><th>Branch</th><th>SOP</th><th>Status</th><th style="min-width:120px"></th></tr></thead><tbody>
    ${list.slice(0, 2000).map((x) => `<tr class="${x.hidden ? 'hidden-row' : ''}">${S.isAdmin ? `<td><input type="checkbox" class="form-check-input sel" value="${x.id}"></td>` : ''}<td>${L.isScheduled(x, t, opts()) && !x.hidden ? '<span class="badge bg-primary">Y</span>' : 'N'}</td>
      <td>${esc(x.depart)}</td><td>${esc(x.checklist)}</td><td class="small">${esc(x.detail)}</td><td>${esc(x.task)}</td><td>${esc(x.user)}</td><td>${esc(x.recurrence)}</td><td>${esc(x.target)}${x.target_month ? ' / M' + esc(x.target_month) : ''}</td><td>${esc(x.company)}</td><td>${esc(x.branch)}</td>
      <td>${x.sop_url ? `<a href="${esc(x.sop_url)}" target="_blank" rel="noopener">${esc(x.sop_name || 'Link')}</a>` : esc(x.sop_name)}</td>
      <td>${x.hidden ? '<span class="badge bg-secondary">Hidden</span>' : '<span class="badge bg-success">Active</span>'}</td>
      <td class="text-nowrap"><a class="btn btn-sm btn-outline-primary py-0" href="#/admin/task?id=${x.id}">Edit</a> <a class="btn btn-sm btn-outline-secondary py-0" href="#/admin/task?copy=${x.id}" title="Add another point to this check list">＋ Point</a></td></tr>`).join('')}
    </tbody></table></div></div>`);
  $('tf').onsubmit = (ev) => { ev.preventDefault(); go('admin/tasks', readForm(ev.target)); };
  if ($('selAll')) $('selAll').onchange = (e) => document.querySelectorAll('.sel').forEach((c) => { c.checked = e.target.checked; });
  document.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const ids = [...document.querySelectorAll('.sel:checked')].map((c) => c.value);
      if (!ids.length) return toast('Select task rows first', 'warning');
      const act = b.dataset.act;
      if (act === 'delete' && !await askConfirm(`Delete ${ids.length} task row(s) permanently? (Saved TRUE/FALSE history stays.)`)) return;
      try {
        const bt = writeBatch(db);
        ids.forEach((id) => (act === 'delete' ? bt.delete(doc(db, 'tasks', id)) : bt.update(doc(db, 'tasks', id), { hidden: act === 'hide' })));
        await bt.commit();
        log(act.toUpperCase() + '_TASK', ids.join(','));
        const ts = nowText();
        const lb = writeBatch(db);
        ids.forEach((id) => {
          const x = S.tasks.find((k) => k.id === id) || {};
          lb.set(doc(collection(db, 'task_log')), logEntry(x, act === 'delete' ? 'DELETE' : act === 'hide' ? 'HIDE' : 'UNHIDE', id, ts,
            act === 'delete' ? [] : [{ field: 'hidden', label: 'Hidden', from: act === 'hide' ? 'No' : 'Yes', to: act === 'hide' ? 'Yes' : 'No' }]));
        });
        await lb.commit().catch(() => {});
        await loadTasks();
        toast(`${ids.length} row(s): ${act}`);
        renderAdminTasks(q);
      } catch (e) { fail(e); }
    };
  });
}

async function renderTaskForm(q) {
  const own = (x) => x && (S.isAdmin || x.user_lc === S.prof.username_lc);
  const edit = q.id ? S.tasks.find((x) => x.id === q.id) : null;
  if (q.id && (!edit || !own(edit) || (!S.isAdmin && edit.hidden))) { toast('You can only change your own tasks.', 'warning'); return go('admin/tasks'); }
  const src = edit || (q.copy ? S.tasks.find((x) => x.id === q.copy) : null);
  const t = src ? { ...src, detail: edit ? src.detail : '' } : { company: 'RC', branch: 'RC', recurrence: 'Daily', target: 'Daily', audit_type: 'Post-Audit' };
  if (!S.isAdmin) t.user = S.prof.username;   // an officer's tasks are always his own
  const Ls = L.listings(S.tasks, S.users.filter((u) => !u.replaced_by).map((u) => u.username));
  if (!S.isAdmin) Ls.user = [S.prof.username];
  const lab = (label, req) => `<label class="form-label small fw-semibold">${label}${req ? ' <span class="text-danger">*</span>' : ''}</label>`;
  // text box
  const field = (name, label, cols = 3, type = 'text', req = false, ph = '', list = '') => `<div class="col-md-${cols}">${lab(label, req)}
    <input name="${name}" type="${type}" value="${esc(t[name] ?? '')}" class="form-control form-control-sm" ${list ? `list="dl_${list}"` : ''} ${req ? 'required' : ''} placeholder="${esc(ph)}" autocomplete="off"></div>`;
  // dropdown (like the sheet) + "Other" to type a new value
  const dd = (name, label, cols, options, req = false) => {
    const cur = String(t[name] ?? '');
    const all = [...new Set([...options, ...(cur ? [cur] : [])])];
    return `<div class="col-md-${cols}">${lab(label, req)}
      <select name="${name}" class="form-select form-select-sm dd" ${req ? 'required' : ''}><option value="">— select —</option>
      ${all.map((o) => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}<option value="__other">➕ Other (type new)…</option></select>
      <input class="form-control form-control-sm mt-1 d-none other" data-for="${name}" placeholder="Type new ${esc(label)}"></div>`;
  };
  mount('admin', `<form id="tf" class="panel"><div class="d-flex justify-content-between align-items-center mb-2"><h5 class="m-0">${edit ? 'Edit Task' : 'Add New Task'}</h5><a class="btn btn-sm btn-outline-secondary" href="#/admin/tasks">← Back</a></div>
    <div class="section-title">1. Check list</div><div class="row g-2">
      ${dd('depart', 'Department', 3, Ls.depart, true)}
      ${field('checklist', 'Check List', 5, 'text', true, 'Pick or type — same name joins points together', 'checklist')}
      ${dd('task', 'Task', 4, Ls.task, true)}
      <div class="col-12">${lab('Check list Detail (point)')}<textarea name="detail" rows="2" class="form-control form-control-sm" placeholder="What exactly has to be checked">${esc(t.detail || '')}</textarea></div>
    </div>
    <div class="section-title">2. Who &amp; where</div><div class="row g-2">
      ${dd('user', '1st — User (assigned to)', 3, Ls.user, true)}
      ${dd('company', 'Organization', 3, Ls.company, true)}
      ${dd('branch', 'Branch Name', 3, Ls.branch, true)}
      ${dd('audit_type', 'Triggered / Daily Work', 3, Ls.audit_type)}
    </div>
    <div class="section-title">3. When (decides the Y in Todays Task)</div><div class="row g-2">
      ${dd('recurrence', 'Recurrence', 3, Ls.recurrence, true)}
      <div class="col-md-3">${lab('Target Day / Date', true)}<select name="target" id="tgt" class="form-select form-select-sm" required></select></div>
      <div class="col-md-2" id="tmWrap">${lab('Target Month')}<select name="target_month" id="tm" class="form-select form-select-sm"><option value="">—</option>${L.SHEET_LISTS.months.map((m) => `<option ${String(t.target_month) === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
      ${field('start_time', 'Start Time', 2, 'time')}${field('end_time', 'End Time', 2, 'time')}
      <div class="col-12"><div class="due-box" id="due"></div></div>
    </div>
    <div class="section-title">4. SOP / links <span class="muted fw-normal small">(optional — leave blank if there is no SOP)</span></div><div class="row g-2">
      ${field('sop_name', 'SOP name', 4, 'text', false, 'e.g. Bilty receiving (WH / Receipt room)')}${field('sop_url', 'SOP link', 4, 'text', false, 'https://docs.google.com/…')}${field('checklist_url', 'Check list document link', 4, 'text', false, 'optional')}
      ${field('ordered_by', 'Ordered By', 4)}${field('remarks', 'Remarks', 8)}
    </div>
    <div class="form-check mt-2"><input class="form-check-input" type="checkbox" name="sop_all" id="sopAll" checked><label class="form-check-label small" for="sopAll">Use this SOP / link for the same check list in <b>every company</b> (RC, RCG … — same SOP, different team)</label></div>
    ${S.isAdmin ? `<div class="form-check mt-3"><input class="form-check-input" type="checkbox" name="hidden" id="hid" ${t.hidden ? 'checked' : ''}><label class="form-check-label" for="hid">Hide this task (it disappears from every tab; history is kept)</label></div>` : '<div class="small muted mt-3">Every change you save is written to the 📜 Change log (old value → new value). Hiding or deleting a task is done by the admin.</div>'}
    <div id="terr" class="text-danger small mt-2"></div>
    <div class="d-flex gap-2 mt-3"><button class="btn btn-primary btn-sm px-4" name="go" value="save">Save</button>${edit ? '' : '<button class="btn btn-outline-primary btn-sm" name="go" value="again">Save &amp; add another point</button>'}<a class="btn btn-secondary btn-sm" href="#/admin/tasks">Cancel</a></div></form>
    <datalist id="dl_checklist">${Ls.checklist.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
    ${edit ? '<div class="panel"><h6>📜 Changes to this task</h6><div id="tlog" class="small muted">Loading…</div></div>' : ''}`);

  const form = $('tf');
  if (!S.isAdmin) {   // user is fixed: no "Other" choice
    const us = form.querySelector('select[name="user"]');
    us.querySelectorAll('option').forEach((o) => { if (o.value !== S.prof.username) o.remove(); });
    us.value = S.prof.username;
  }
  if (edit) {
    fetchTaskLog({ taskId: edit.id }).then((rows) => { if ($('tlog')) $('tlog').innerHTML = rows.length ? logTable(rows, false) : 'No changes yet.'; })
      .catch((e) => { if ($('tlog')) $('tlog').textContent = friendly(e); });
  }
  const val = (name) => {
    const el = form.querySelector(`[name="${name}"]`);
    if (el && el.value === '__other') return form.querySelector(`.other[data-for="${name}"]`).value.trim();
    return el ? el.value : '';
  };
  // Target Day/Date list follows Recurrence (Daily / Mon-Sun / 1-31 / Triggered), like the sheet
  const fillTargets = (keep) => {
    const opts = L.targetsFor(val('recurrence'));
    // first load keeps the saved value; after a Recurrence change only a value that fits the new list is kept
    const cur = keep ?? (opts.includes($('tgt').value) ? $('tgt').value : '');
    const list = [...new Set([...opts, ...(cur && !opts.includes(cur) ? [cur] : [])])];
    $('tgt').innerHTML = `<option value="">— select —</option>` + list.map((o) => `<option ${o === cur ? 'selected' : ''}>${o}</option>`).join('');
    if (list.length === 1 && !cur) $('tgt').value = list[0];
    $('tmWrap').classList.toggle('opacity-50', !L.needsMonth(val('recurrence')));
    $('tm').disabled = !L.needsMonth(val('recurrence'));
  };
  // live preview: is it Y today, and the next due dates
  const preview = () => {
    const x = { checklist: val('checklist') || 'x', task: val('task') || 'x', recurrence: val('recurrence'), target: $('tgt').value,
      target_month: $('tm').value, company: val('company') };
    if (!x.target) { $('due').innerHTML = '<span class="muted">Choose Recurrence and Target to see when this task will appear.</span>'; return; }
    const tk = today();
    const y = L.isScheduled(x, tk, opts());
    const next = L.nextDueDates(x, tk, opts(), 6);
    $('due').innerHTML = `<b>Today (${tk}, ${L.dayName(tk)}):</b> ${y ? '<span class="badge bg-success">Y — shows in Todays Task</span>' : '<span class="badge bg-secondary">N</span>'}
      &nbsp; <b>Next due:</b> ${next.length ? next.map((d) => `<span class="badge text-bg-light border">${d} ${L.dayName(d)}</span>`).join(' ') : '<span class="muted">never in Todays Task (Triggered — use its department tab)</span>'}`;
  };
  fillTargets(String(t.target ?? ''));
  preview();
  form.addEventListener('change', (ev) => {
    if (ev.target.classList.contains('dd')) {
      const o = form.querySelector(`.other[data-for="${ev.target.name}"]`);
      o.classList.toggle('d-none', ev.target.value !== '__other');
      if (ev.target.value === '__other') o.focus();
    }
    if (ev.target.name === 'recurrence' || ev.target.dataset.for === 'recurrence') fillTargets();
    preview();
  });
  form.addEventListener('input', (ev) => { if (ev.target.classList.contains('other')) preview(); });

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const again = ev.submitter && ev.submitter.value === 'again';
    try {
      const data = readForm(form);
      form.querySelectorAll('select.dd').forEach((s) => { data[s.name] = val(s.name); });
      if (!L.needsMonth(data.recurrence)) data.target_month = '';
      if (!S.isAdmin) { data.user = S.prof.username; data.hidden = edit ? !!edit.hidden : false; }
      const c = L.cleanTask(data);
      const ts = nowText();
      let id = edit?.id;
      if (edit) {
        const changes = L.taskDiff(edit, c);
        if (!changes.length && !data.sop_all) { toast('Nothing changed', 'warning'); return; }
        if (changes.length) {
          await updateDoc(doc(db, 'tasks', id), { ...c, updated_by: S.prof.username, updated_at: ts });
          await addDoc(collection(db, 'task_log'), logEntry(c, 'EDIT', id, ts, changes));
          log('EDIT_TASK', `${id} ${c.checklist}`);
        }
      } else {
        const order = Math.max(0, ...S.tasks.map((x) => x.sort_order || 0)) + 1;
        const ref = await addDoc(collection(db, 'tasks'), { ...c, sort_order: order, created_by: S.prof.username, created_at: ts, updated_by: S.prof.username, updated_at: ts });
        id = ref.id;
        await addDoc(collection(db, 'task_log'), logEntry(c, 'ADD', id, ts, L.taskDiff({}, c).filter((d) => d.field !== 'hidden')));
        log('ADD_TASK', `${id} ${c.checklist}`);
      }
      if (data.sop_all && (c.sop_name || c.sop_url || c.checklist_url)) {
        // an officer can only update his own rows; the admin updates every company
        const same = S.tasks.filter((x) => x.id !== id && L.norm(x.depart) === L.norm(c.depart) && L.norm(x.checklist) === L.norm(c.checklist)
          && (S.isAdmin || x.user_lc === S.prof.username_lc)
          && (x.sop_name !== c.sop_name || x.sop_url !== c.sop_url || x.checklist_url !== c.checklist_url));
        for (let i = 0; i < same.length; i += 400) {
          const b = writeBatch(db);
          same.slice(i, i + 400).forEach((x) => b.update(doc(db, 'tasks', x.id), { sop_name: c.sop_name, sop_url: c.sop_url, checklist_url: c.checklist_url }));
          await b.commit();
        }
      }
      await loadTasks();
      toast('Task saved');
      if (again) { location.hash = '#/admin/task?copy=' + id + '&n=' + Date.now(); } else go('admin/tasks');
    } catch (e) { $('terr').textContent = friendly(e); }
  };
}

// ------------------------------------------------------------------ task change log
function logEntry(task, action, taskId, ts, changes) {
  return { action, task_id: taskId, ts, date: today(), by: S.prof.username, by_lc: S.prof.username_lc, by_role: S.prof.role,
    user: task.user || '', user_lc: L.norm(task.user || ''), depart: task.depart || '', checklist: task.checklist || '', task: task.task || '',
    company: task.company || '', branch: task.branch || '', changes };
}
async function fetchTaskLog({ taskId = '', userLc = '' } = {}) {
  let qy;
  if (taskId) qy = S.isAdmin ? query(collection(db, 'task_log'), where('task_id', '==', taskId))
    : query(collection(db, 'task_log'), where('user_lc', '==', S.prof.username_lc), where('task_id', '==', taskId));
  else if (!S.isAdmin) qy = query(collection(db, 'task_log'), where('user_lc', '==', S.prof.username_lc));
  else if (userLc) qy = query(collection(db, 'task_log'), where('user_lc', '==', userLc));
  else qy = query(collection(db, 'task_log'), orderBy('ts', 'desc'), limit(2000));
  const snap = await getDocs(qy);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}
const ACT_BADGE = { ADD: 'success', EDIT: 'primary', HIDE: 'secondary', UNHIDE: 'info', DELETE: 'danger' };
function logTable(rows, withTask = true) {
  return `<div class="table-wrap"><table class="table table-sm table-bordered tbl mb-0"><thead><tr><th>When</th><th>Changed by</th><th>Action</th>${withTask ? '<th>Task</th>' : ''}<th>What changed (old → new)</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="text-nowrap small">${esc(r.ts)}</td><td>${esc(r.by)}${r.by_role === 'Admin' ? ' <span class="badge bg-dark">Admin</span>' : ''}</td>
      <td><span class="badge bg-${ACT_BADGE[r.action] || 'secondary'}">${esc(r.action)}</span></td>
      ${withTask ? `<td class="small"><b>${esc(r.checklist)}</b><br>${esc(r.task)} · ${esc(r.branch)} · ${esc(r.user)}${r.task_id && S.tasks.some((x) => x.id === r.task_id) ? ` <a href="#/admin/task?id=${r.task_id}">open</a>` : ''}</td>` : ''}
      <td class="small">${(r.changes || []).length ? r.changes.map((c) => r.action === 'ADD' ? `<div><b>${esc(c.label)}:</b> ${esc(c.to)}</div>`
        : `<div><b>${esc(c.label)}:</b> <span class="text-danger text-decoration-line-through">${esc(c.from) || '(blank)'}</span> → <span class="text-success">${esc(c.to) || '(blank)'}</span></div>`).join('') : (r.action === 'DELETE' ? 'Task deleted' : '')}</td></tr>`).join('')}
    </tbody></table></div>`;
}
async function renderTaskLog(q) {
  mount('admin', '<div class="panel">Loading change log…</div>');
  const seq = S.seq;
  const rows = (await fetchTaskLog({ userLc: S.isAdmin ? L.norm(q.user || '') : '' })).filter((r) => (!q.action || r.action === q.action)
    && (!q.q || L.norm([r.checklist, r.task, r.depart, r.branch, r.by, ...(r.changes || []).map((c) => c.label + ' ' + c.from + ' ' + c.to)].join(' ')).includes(L.norm(q.q))));
  if (seq !== S.seq) return;
  mount('admin', `<div class="panel"><form id="lf" class="d-flex flex-wrap gap-2 align-items-center">
      <a class="btn btn-sm btn-outline-secondary" href="#/admin/tasks">← Tasks</a>
      <input name="q" value="${esc(q.q || '')}" class="form-control form-control-sm" style="max-width:240px" placeholder="Search check list / field / value…">
      ${S.isAdmin ? `<select name="user" class="form-select form-select-sm" style="width:auto">${opt(S.users.filter((u) => !u.replaced_by).map((u) => u.username), q.user || '', 'All users')}</select>` : ''}
      <select name="action" class="form-select form-select-sm" style="width:auto">${opt(['ADD', 'EDIT', 'HIDE', 'UNHIDE', 'DELETE'], q.action || '', 'All actions')}</select>
      <button class="btn btn-outline-primary btn-sm">Filter</button><button type="button" class="btn btn-success btn-sm" id="lx">⬇ Export Excel</button>
      <span class="muted small">${rows.length} change(s)</span></form></div>
    <div class="panel">${rows.length ? logTable(rows) : '<div class="text-center p-4 muted">No task changes yet.</div>'}</div>`);
  $('lf').onsubmit = (ev) => { ev.preventDefault(); go('admin/log', readForm(ev.target)); };
  $('lx').onclick = () => exportXlsx('Task_Change_Log', ['When', 'Changed by', 'Role', 'Action', 'User (1st)', 'Department', 'Check List', 'Task', 'Organization', 'Branch', 'Field', 'Old', 'New'],
    rows.flatMap((r) => ((r.changes || []).length ? r.changes : [{ label: '', from: '', to: '' }]).map((c) => [r.ts, r.by, r.by_role, r.action, r.user, r.depart, r.checklist, r.task, r.company, r.branch, c.label, c.from, c.to])));
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
      department: old.department || extra.department || '', dept_lc: L.norm(old.department || extra.department || ''), company: old.company ?? extra.company ?? '',
    });
    await setDoc(doc(db, 'usernames', lc), { email, uid, n });
    if (prev) await updateDoc(doc(db, 'users', prev), { active: false, replaced_by: uid });
    return uid;
  } finally { await deleteApp(tmp); }
}

/** Rename a user everywhere: login name, tasks (column 1st), saved history, today's ticks. */
async function renameUser(u, newName) {
  const oldLc = u.username_lc, newLc = L.norm(newName);
  if (newLc !== oldLc) {
    const taken = await getDoc(doc(db, 'usernames', newLc));
    if (taken.exists()) throw new Error(`The name "${newName}" is already used by another login.`);
  }
  const map = await getDoc(doc(db, 'usernames', oldLc));
  const upd = async (col) => {
    const snap = await getDocs(query(collection(db, col), where('user_lc', '==', oldLc)));
    for (let i = 0; i < snap.docs.length; i += 400) {
      const b = writeBatch(db);
      snap.docs.slice(i, i + 400).forEach((d) => b.update(d.ref, { user: newName, user_lc: newLc }));
      await b.commit();
    }
    return snap.size;
  };
  const tasks = await upd('tasks');
  const records = await upd('records');
  await upd('marks');
  await upd('evidence');
  await upd('task_log');
  await updateDoc(doc(db, 'users', u.uid), { username: newName, username_lc: newLc });
  if (newLc !== oldLc) {
    await setDoc(doc(db, 'usernames', newLc), map.exists() ? map.data() : { email: u.email, uid: u.uid, n: 0 });
    await deleteDoc(doc(db, 'usernames', oldLc));
  }
  log('RENAME_USER', `${u.username} -> ${newName}`);
  await Promise.all([loadTasks(), loadUsers()]);
  clearCache();
  return { tasks, records };
}

async function renderUsers() {
  await loadUsers();
  const known = new Set(S.users.map((u) => u.username_lc));
  const missing = [...new Set(S.tasks.map((t) => t.user).filter((u) => u && !known.has(L.norm(u))))];
  const cnt = (lc) => S.tasks.filter((t) => t.user_lc === lc && !t.hidden).length;
  const live = S.users.filter((u) => !u.replaced_by);
  mount('users', `<div class="row g-2"><div class="col-lg-8"><div class="panel"><h6>Users</h6>
    ${missing.length ? `<div class="alert alert-warning py-2 small">Tasks are assigned to names that have no login: <b>${esc(missing.join(', '))}</b>. Add them on the right.</div>` : ''}
    <div class="table-wrap"><table class="table table-sm table-bordered tbl mb-0"><thead><tr><th>Username</th><th>Role</th><th>Department login</th><th>Monthly Salary</th><th>Active</th><th>Active tasks</th><th>Last login</th><th></th></tr></thead><tbody>
    ${live.map((u, i) => `<tr class="${u.active ? '' : 'hidden-row'}"><td><b>${esc(u.username)}</b></td><td>${esc(u.role)}</td><td>${u.role === 'Department' ? esc(u.department) + ' · ' + esc(u.company || 'RC & RCG') : ''}</td><td>${money(u.salary)}</td><td>${u.active ? 'Y' : 'N'}</td><td>${cnt(u.username_lc)}</td><td class="small">${esc(u.last_login || '')}</td><td><button class="btn btn-sm btn-outline-primary py-0" data-i="${i}">Edit</button></td></tr>`).join('')}
    </tbody></table></div></div></div>
    <div class="col-lg-4"><form class="panel" id="uf"><h6 id="ufT">Add User</h6>
      <label class="form-label small fw-bold">Username (same name used in tasks — can be renamed)</label><input name="username" class="form-control form-control-sm mb-2" required>
      <label class="form-label small fw-bold">Role</label><select name="role" id="ufRole" class="form-select form-select-sm mb-2"><option value="Officer">Officer (auditor)</option><option value="Admin">Admin</option><option value="Department">Department (sees only its audit issues)</option></select>
      <div id="ufDept" class="d-none"><label class="form-label small fw-bold">Department</label><select name="department" class="form-select form-select-sm mb-2">${opt(L.listings(S.tasks).depart, '', '— select —')}</select>
        <label class="form-label small fw-bold">Organization</label><select name="company" class="form-select form-select-sm mb-2">${opt(L.SHEET_LISTS.company, '', 'RC & RCG (both)')}</select></div>
      <label class="form-label small fw-bold">Monthly Salary (for % fine)</label><input name="salary" type="number" min="0" class="form-control form-control-sm mb-2">
      <label class="form-label small fw-bold">Password <span class="muted" id="pwHint">(min 6 — user changes it at first login)</span></label><input name="password" class="form-control form-control-sm mb-2" minlength="6">
      <div class="form-check mb-2"><input class="form-check-input" type="checkbox" name="active" id="ufA" checked><label for="ufA" class="form-check-label">Active</label></div>
      <button class="btn btn-primary btn-sm">Save User</button> <button type="button" class="btn btn-outline-secondary btn-sm" id="ufNew">New</button>
      <div id="uerr" class="text-danger small mt-2"></div></form></div></div>`);
  let editing = null;   // eslint-disable-line prefer-const
  const f = $('uf');
  const deptBox = () => $('ufDept').classList.toggle('d-none', f.role.value !== 'Department');
  f.role.onchange = deptBox;
  $('main').onclick = (ev) => {
    const b = ev.target.closest('[data-i]'); if (!b) return;
    editing = live[+b.dataset.i];
    f.username.value = editing.username; f.username.readOnly = false; f.role.value = editing.role; f.salary.value = editing.salary || 0; f.active.checked = !!editing.active; f.password.value = '';
    f.department.value = editing.department || ''; f.company.value = editing.company || ''; deptBox();
    $('ufT').textContent = 'Edit ' + editing.username; $('pwHint').textContent = '(blank = keep; filled = reset password)';
  };
  $('ufNew').onclick = () => renderUsers();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const v = readForm(f);
    try {
      if (editing) {
        if (editing.uid === S.uid && (v.role !== 'Admin' || !v.active)) throw new Error('You cannot remove your own Admin access.');
        const newName = String(v.username || '').trim();
        if (!newName) throw new Error('Username is required.');
        if (newName !== editing.username) {
          if (!(await askConfirm(`Rename "${editing.username}" to "${newName}"? The new name is used for login, all tasks and all saved history.`, 'Rename'))) return;
          const n = await renameUser(editing, newName);
          toast(`Renamed to ${newName}: ${n.tasks} task(s), ${n.records} history record(s) updated`);
          editing = { ...editing, username: newName, username_lc: L.norm(newName) };
        }
        if (v.role === 'Department' && !v.department) throw new Error('Choose the department for this login.');
        await updateDoc(doc(db, 'users', editing.uid), { role: v.role, salary: Number(v.salary) || 0, active: !!v.active,
          department: v.role === 'Department' ? v.department : '', dept_lc: v.role === 'Department' ? L.norm(v.department) : '', company: v.role === 'Department' ? (v.company || '') : '' });
        if (v.password) {
          const self = editing.uid === S.uid;
          if (self && !(await askConfirm(`Set a new password for your own login "${editing.username}"? You will be logged out and must log in again with the new password.`, 'Set password'))) return;
          await createLogin(editing.username, v.password, { must_change: !self });
          if (self) { await log('RESET_OWN_PASSWORD', editing.username); toast('Password changed. Please log in again with the new password.'); await signOut(auth); return; }
        }
        log('SAVE_USER', editing.username);
        toast(v.password ? 'User updated and password reset' : 'User updated');
      } else {
        if (!v.password || v.password.length < 6) throw new Error('Password (min 6) is required for a new user.');
        if (known.has(L.norm(v.username))) throw new Error('This username already exists — click Edit instead.');
        if (v.role === 'Department' && !v.department) throw new Error('Choose the department for this login.');
        await createLogin(v.username, v.password, { role: v.role, salary: v.salary, must_change: true,
          ...(v.role === 'Department' ? { department: v.department, company: v.company || '' } : {}) });
        log('ADD_USER', v.username);
        toast('User created');
      }
      renderUsers();
    } catch (e) { $('uerr').textContent = friendly(e); }
  };
}

// ------------------------------------------------------------------ admin: settings, import, backup
function renderSettings() {
  mount('settings', `<div class="row g-2"><div class="col-lg-8">
    <div class="panel"><h6>📘 How efficiency and fines are worked out</h6><div class="small" style="line-height:1.7">
      <b>Who is fined?</b> Two separate fines: the <b>auditor</b> (user in column 1st) for tasks he did not check (FALSE) — rules 1 and 2 — and the <b>department</b> when the auditor checked the work and found it <b>Incomplete</b> — rule 3. <code>DEPT_FINES</code> only changes the auditor's Rs rate for tasks of that department.<br>
      <b>What counts?</b> Every task that was due on a day (it showed in Todays Task). At ${esc(closeLabel())} it is saved as <b>TRUE</b> (ticked) or <b>FALSE</b> (not ticked). Triggered tasks and ticks on a day the task was not due ("Extra") are not counted.<br>
      <b>Efficiency %</b> = TRUE ÷ (TRUE + FALSE) × 100 for the chosen days or month.<br>
      <b>1) Per-task fine</b> (FINE_MODE PER_TASK or BOTH) = number of FALSE × <code>FINE_PER_TASK</code> (or the department's rate from <code>DEPT_FINES</code>).<br>
      <b>2) Salary % fine</b> (FINE_MODE PERCENT or BOTH) = monthly salary × the % from <code>FINE_PCT_SLABS</code> for the month's efficiency. Set each user's salary in <b>Users</b>; salary 0 = no % fine.<br>
      <b>Total fine</b> = 1 + 2. It is final at month end; the month-end snapshot is saved on the 1st.<br>
      <b>Trigger tasks</b> (Recurrence = Trigger, no day / date / month) show at the <b>end of Todays Task</b> under ⚡ Triggered. Tick them only when they happen; they are <b>not counted</b> in the auditor's efficiency and never become FALSE. A task that has a day, date or month (Weekly, Monthly …) is counted normally.<br>
      <b>Audit Issues</b>: an auditor raises an issue for a department (Minor / Major, detail, recommendation, pictures). The department login sees it, sets a <b>due date</b>, clears it, writes remarks + pictures and marks <b>Done</b>. The auditor cross-checks and marks <b>Verified</b> (or sends it back). <b>Pending days</b> = raised → Done. Department logins are made in <b>Users</b> with Role = Department. Ownership e-mail: <code>OWNER_EMAILS</code>.<br>
      <b>3) Department fine</b> (separate from the auditor): the auditor first ticks <b>TRUE</b> (he checked it), then chooses the department's work: <b>Complete</b> or <b>Incomplete</b> (+ remarks and 📷 pictures as evidence). Every <b>Incomplete</b> = <code>DEPT_INCOMPLETE_FINE</code> Rs (or the department's own rate in <code>DEPT_INCOMPLETE_FINES</code>) charged to that <b>company · department</b>. See Performance → "Department fines" and the Efficiency report (Dept Fine column).<br>
      <span class="muted"><b>Example:</b> 300 tasks due in the month, 270 TRUE, 30 FALSE → efficiency 90% → grade A. Per-task: 30 × Rs 100 = Rs 3,000 (if 10 of the 30 were Accounts with <code>Accounts:200</code> → 20×100 + 10×200 = Rs 4,000). Salary %: 90% falls in 85:2 → 2% of Rs 50,000 = Rs 1,000. Total (BOTH) = Rs 4,000 or Rs 5,000.</span>
    </div></div>
    <form class="panel" id="sf"><h6>Fines, grades &amp; rules</h6>
    <table class="table table-sm table-bordered mb-2"><thead><tr><th>Setting</th><th style="width:38%">Value</th><th>Help</th></tr></thead><tbody>
    ${L.DEFAULT_SETTINGS.map(([k, , note]) => `<tr><td class="small fw-bold">${k}</td><td>${k === 'FINE_MODE' ? `<select name="${k}" class="form-select form-select-sm">${['NONE', 'PER_TASK', 'PERCENT', 'BOTH'].map((m) => `<option ${m === String(S.settings[k]).toUpperCase() ? 'selected' : ''}>${m}</option>`).join('')}</select>` : `<input name="${k}" value="${esc(S.settings[k])}" class="form-control form-control-sm">`}</td><td class="small muted">${esc(note)}</td></tr>`).join('')}
    </tbody></table><button class="btn btn-primary btn-sm">Save Settings</button></form></div>
    <div class="col-lg-4">
      <div class="panel"><h6>Import / update from Google Sheet (.xlsx)</h6><div class="small muted mb-2">Google Sheets → File → Download → Microsoft Excel (.xlsx). The task sheet can have any name (Sort_List, Sheet1 …); it is found by its headers (<b>Check List</b>, <b>1st</b> …). Every name in column <b>1st (G)</b> gets a login — password <b>Audit@123</b>, changed at first login. History comes from <b>Officer_Master_DB</b>.<br>Tasks now in database: <b>${S.tasks.length}</b>.</div>
        <input type="file" id="xf" accept=".xlsx" class="form-control form-control-sm mb-2">
        <div class="form-check small"><input class="form-check-input" type="radio" name="imode" id="im1" value="tasks" checked><label class="form-check-label" for="im1"><b>Update tasks &amp; users</b> — replace the task list with the file, add new users and missing history. Saved history and today's ticks are kept.</label></div>
        <div class="form-check small mb-2"><input class="form-check-input" type="radio" name="imode" id="im2" value="all"><label class="form-check-label" for="im2"><b>Replace everything</b> — delete all tasks AND all saved TRUE/FALSE history, then load the file.</label></div>
        <button class="btn btn-primary btn-sm w-100" id="btnImp">Import</button><div class="progress-log mt-2 d-none" id="ilog"></div></div>
      <div class="panel"><h6>Close a past day</h6><div class="small muted mb-2">Saves FALSE for every task due on that date that has no TRUE / FALSE. This also happens automatically every day.</div>
        <input type="date" id="cd" class="form-control form-control-sm mb-2"><button class="btn btn-outline-danger btn-sm w-100" id="btnClose">Close this date</button></div>
      <div class="panel"><h6>Duplicate history check</h6><div class="small muted mb-2">Finds TRUE/FALSE records saved twice for the same day, user and check list (e.g. from an import whose Branch column had #REF!). The copy with the real branch is kept.</div>
        <button class="btn btn-outline-secondary btn-sm w-100" id="btnDup">Check for duplicates</button><div class="small mt-2" id="dupOut"></div></div>
      <div class="panel"><h6>Backup</h6><button class="btn btn-outline-success btn-sm w-100" id="btnBak">⬇ Download full backup (Excel)</button></div></div></div>`);
  $('sf').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await setDoc(doc(db, 'settings', 'app'), { values: readForm(ev.target) }); await loadSettings(); log('SAVE_SETTINGS'); toast('Settings saved'); } catch (e) { fail(e); }
  };
  $('btnClose').onclick = async () => {
    const d = $('cd').value;
    if (!d) return toast('Pick a date', 'warning');
    if (d >= today()) return toast('Only past dates can be closed.', 'warning');
    if (!await askConfirm(`Save FALSE for unmarked tasks of ${d}?`)) return;
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
  $('btnDup').onclick = async () => {
    try {
      $('dupOut').textContent = 'Checking…';
      const all = (await getDocs(collection(db, 'records'))).docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
      const dupes = L.findDuplicateRecords(all, new Set(S.tasks.map((t) => t.branch)));
      if (!dupes.length) { $('dupOut').innerHTML = '<span class="text-success">No duplicates found ✔</span>'; return; }
      const by = {};
      dupes.forEach((r) => { const k = `${r.user} · branch "${r.branch}"`; by[k] = (by[k] || 0) + 1; });
      $('dupOut').innerHTML = `<div class="text-warning mb-1">${dupes.length} duplicate record(s): ${Object.entries(by).map(([k, n]) => `${esc(k)} = ${n}`).join(', ')}</div>
        <button class="btn btn-danger btn-sm w-100" id="btnDupDel">Delete these ${dupes.length} duplicates</button>`;
      $('btnDupDel').onclick = async () => {
        if (!(await askConfirm(`Delete ${dupes.length} duplicate history record(s)? The original records stay.`, 'Delete'))) return;
        for (let i = 0; i < dupes.length; i += 400) { const b = writeBatch(db); dupes.slice(i, i + 400).forEach((r) => b.delete(r.ref)); await b.commit(); }
        log('DELETE_DUPLICATES', dupes.length); clearCache();
        $('dupOut').innerHTML = `<span class="text-success">${dupes.length} duplicate(s) deleted ✔</span>`;
      };
    } catch (e) { fail(e); }
  };
  $('btnImp').onclick = () => importWorkbook($('xf').files[0], document.querySelector('input[name=imode]:checked').value);
}

async function importWorkbook(file, mode = 'tasks') {
  const lg = $('ilog'), btn = $('btnImp');      // kept even if the user opens another page meanwhile
  const say = (m) => { lg.classList.remove('d-none'); lg.textContent += m + '\n'; lg.scrollTop = lg.scrollHeight; };
  if (!file) return toast('Choose the .xlsx file first', 'warning');
  const all = mode === 'all';
  if (!await askConfirm(all ? 'REPLACE EVERYTHING: all tasks and all saved TRUE/FALSE history will be deleted and loaded again from the file. Continue?'
    : 'Update the task list and users from this file? Saved history and today\'s ticks are kept. Please stay on this page until it says "Done".')) return;
  btn.disabled = true;
  try {
    say('Reading file…');
    const wb = XLSX.read(await file.arrayBuffer(), { cellDates: false });
    const res = L.parseOldWorkbook(
      (s, r, c) => wb.Sheets[s][XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })],
      (s) => (wb.Sheets[s]['!ref'] ? XLSX.utils.decode_range(wb.Sheets[s]['!ref']).e.r + 1 : 0),
      (s) => !!wb.Sheets[s], wb.SheetNames);
    const per = {};
    res.tasks.forEach((t) => { per[t.user] = (per[t.user] || 0) + 1; });
    say(`Sheet "${res.sheet}": ${res.tasks.length} task rows (${Object.entries(per).map(([u, n]) => `${u} ${n}`).join(', ')}), ${res.records.length} history records`);
    if (!res.tasks.length) throw new Error('No task rows found in the file.');
    const kept = L.carryLinks(res.tasks, S.tasks);
    if (kept) say(`Kept ${kept} SOP / check-list link(s) from the current tasks`);

    // tasks: always replaced by the file
    const oldTasks = await getDocs(collection(db, 'tasks'));
    for (let i = 0; i < oldTasks.docs.length; i += 450) {
      const b = writeBatch(db); oldTasks.docs.slice(i, i + 450).forEach((d) => b.delete(d.ref)); await b.commit();
    }
    for (let i = 0; i < res.tasks.length; i += 450) {
      const b = writeBatch(db);
      res.tasks.slice(i, i + 450).forEach((t) => b.set(doc(collection(db, 'tasks')), t));
      await b.commit();
    }
    say(`Task list: ${oldTasks.size} old rows replaced by ${res.tasks.length}`);

    // history
    let existing = new Set();
    if (all) {
      const snap = await getDocs(collection(db, 'records'));
      for (let i = 0; i < snap.docs.length; i += 450) {
        const b = writeBatch(db); snap.docs.slice(i, i + 450).forEach((d) => b.delete(d.ref)); await b.commit();
      }
      say(`Deleted ${snap.size} saved records`);
    } else {
      existing = new Set((await getDocs(collection(db, 'records'))).docs.map((d) => d.id));
    }
    const toAdd = [];
    for (const r of res.records) { const id = await recordId(r); if (!existing.has(id)) toAdd.push([id, r]); }
    for (let i = 0; i < toAdd.length; i += 450) {
      const b = writeBatch(db);
      toAdd.slice(i, i + 450).forEach(([id, r]) => b.set(doc(db, 'records', id), r));
      await b.commit();
    }
    say(`History: ${toAdd.length} record(s) added${all ? '' : `, ${res.records.length - toAdd.length} already there (kept as they are)`}`);

    // users from column 1st (G)
    await loadUsers();
    const yest = L.addDays(today(), -1);
    for (const name of res.users) {
      const u = S.users.find((x) => x.username_lc === L.norm(name) && !x.replaced_by);
      if (u) {
        if (!u.active) await updateDoc(doc(db, 'users', u.uid), { active: true });
        say(`User "${name}" already has a login`);
        continue;
      }
      await createLogin(name, 'Audit@123', { role: 'Officer', closed_until: yest, must_change: true });
      say(`Login created: "${name}" / Audit@123 (must change at first login)`);
    }
    await Promise.all([loadTasks(), loadUsers()]);
    clearCache();
    log('IMPORT', `${mode}: ${res.tasks.length} tasks, +${toAdd.length} records, users ${res.users.join(', ')}`);
    say('Done ✔');
    toast(`Import finished: ${res.tasks.length} tasks, users: ${res.users.join(', ')}`);
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
  const adminOnly = ['admin/tasks', 'admin/task', 'admin/log', 'users', 'settings'];
  try {
    if (S.isDept && !['issues', 'issues/new', 'ireport', 'password'].includes(path)) return go('issues');
    if (adminOnly.includes(path) && !S.isAdmin) return go('tasks');
    if (path === 'issues') return await renderIssues(q);
    if (path === 'issues/new') return await renderIssueForm(q);
    if (path === 'ireport') return await renderIssueReport(q);
    if (path === 'report') return await renderReport(q);
    if (path === 'eff') return await renderEff(q);
    if (path === 'monthly') return await renderMonthly(q);
    if (path === 'admin/tasks') return renderAdminTasks(q);
    if (path === 'admin/task') return await renderTaskForm(q);
    if (path === 'admin/log') return await renderTaskLog(q);
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

// New day while the page is open (after 12:00 at night): save yesterday's unmarked tasks as FALSE
// and reload the page with the new date's tasks. Also checked when the tab becomes visible again.
async function checkNewDay() {
  if (!S.prof || !S.day || S.rolling) return;
  const t = today();
  if (t === S.day) return;
  if (S.isDept) { S.day = t; route(); return; }     // department logins have no daily tasks
  S.rolling = true;
  try {
    S.day = t;
    clearCache();
    await Promise.all([loadSettings(), loadTasks(), S.isAdmin ? loadUsers() : Promise.resolve()]);
    await new Promise((res) => setTimeout(res, Math.random() * 20000));   // spread the load when many PCs are open
    const c = await closeDay();
    toast(`Day closed: ${c.saved} tick(s) saved to the database${c.falses ? `, ${c.falses} unmarked task(s) as FALSE` : ''}. Tasks of ${t} (${L.dayName(t)}) loaded.`, 'info');
    route();
  } catch (e) { console.warn('new day', e); } finally { S.rolling = false; }
}
setInterval(checkNewDay, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNewDay(); });

async function boot(user) {
  try {
    const p = await getDoc(doc(db, 'users', user.uid));
    if (!p.exists() || !p.data().active) { await signOut(auth); return renderLogin('This login is not active. Ask the admin.'); }
    S.uid = user.uid; S.prof = p.data(); S.isAdmin = S.prof.role === 'Admin';
    S.isDept = S.prof.role === 'Department'; S.isAuditor = !S.isDept;
    $('app').innerHTML = loading;
    await Promise.all([loadSettings(), S.isDept ? Promise.resolve() : loadTasks(), S.isAdmin ? loadUsers() : Promise.resolve()]);
    if (!S.isAdmin) S.users = [{ uid: S.uid, ...S.prof }];
    updateDoc(doc(db, 'users', S.uid), { last_login: nowText() }).catch(() => {});
    document.title = S.settings.APP_TITLE;
    startIssueWatch();
    if (S.isDept) { S.day = today(); route(); return; }
    try {
      const c = await closeDay();
      if (c.saved || c.falses) toast(`Previous day saved to the database: ${c.saved} tick(s)${c.falses ? `, ${c.falses} unmarked task(s) as FALSE` : ''}`, 'info');
    } catch (e) { console.warn('day close', e); }
    S.day = today();
    route();
  } catch (e) { fail(e); renderLogin(friendly(e)); }
}

onAuthStateChanged(auth, (user) => {
  if (S.settingUp) return;          // first-admin setup is still writing the profile
  stopIssueWatch();
  S.prof = null; S.uid = null; S.isAdmin = false; S.isDept = false; S.isAuditor = false; clearCache();
  if (user) boot(user); else renderLogin();
});
