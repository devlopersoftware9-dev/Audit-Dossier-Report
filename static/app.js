/* Audit Dossier Portal — small client helpers (marking, collapse, detail popup, toasts). */
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function toast(msg, type) {
  var t = document.getElementById('toast');
  if (!t || !window.bootstrap) { return; }
  t.className = 'toast border-0 text-white bg-' + (type || 'success');
  document.getElementById('toastBody').textContent = msg;
  bootstrap.Toast.getOrCreateInstance(t, { delay: 2500 }).show();
}

function showModal(title, html) {
  document.getElementById('detailTitle').textContent = title;
  document.getElementById('detailBody').innerHTML = html;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('detailModal')).show();
}

document.addEventListener('click', function (ev) {
  // check-list popup
  var btn = ev.target.closest('[data-detail]');
  if (btn) {
    var d = JSON.parse(btn.getAttribute('data-detail'));
    var h = '<div class="small muted mb-2">' + esc(d.meta) + '</div>';
    h += d.details.length ? d.details.map(function (x, i) {
      return '<div class="detail-item"><b>' + (i + 1) + '.</b> ' + esc(x) + '</div>';
    }).join('') : '<div class="muted">No detail written.</div>';
    if (d.sop_url) h += '<div class="mt-2">SOP: <a target="_blank" rel="noopener" href="' + esc(d.sop_url) + '">' + esc(d.sop || d.sop_url) + '</a></div>';
    else if (d.sop) h += '<div class="mt-2">SOP: ' + esc(d.sop) + '</div>';
    if (d.url) h += '<div class="mt-1"><a target="_blank" rel="noopener" href="' + esc(d.url) + '">Open linked check list</a></div>';
    showModal(d.title, h);
    return;
  }
  // collapse / expand groups
  var grp = ev.target.closest('.grp-row');
  if (grp) {
    var cls = 'b-' + grp.dataset.bucket.replace(/[ \/]/g, '');
    document.querySelectorAll('tr.' + cls).forEach(function (tr) { tr.classList.toggle('d-none'); });
  }
  // "details" buttons on monthly page
  var md = ev.target.closest('[data-monthly]');
  if (md) {
    var tpl = document.getElementById(md.getAttribute('data-monthly'));
    showModal(md.getAttribute('data-title'), tpl.innerHTML);
  }
});

function saveMark(tr, status, fromBox) {
  var box = tr.querySelector('.mark-box'), rem = tr.querySelector('.remarks-in');
  tr.classList.add('saving');
  fetch('/api/mark', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: tr.dataset.key, status: status, remarks: rem.value })
  }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Error'); return j; }); })
    .then(function (res) {
      tr.classList.toggle('row-done', res.status);
      box.title = 'Saved ' + res.marked_at;
      toast((res.status ? '✔ TRUE' : '✖ FALSE') + ' saved' + (res.source === 'Extra' ? ' (not due today)' : ''), res.status ? 'success' : 'secondary');
      var d = res.dash, set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
      if (d && document.querySelector('.pill-bar .btn-dark')) {
        set('cTotal', d.total); set('cDone', d.done); set('cPending', d.pending); set('cPct', d.pct + '%');
      }
    })
    .catch(function (e) { if (fromBox) box.checked = !status; toast(e.message, 'danger'); })
    .finally(function () { tr.classList.remove('saving'); });
}

document.addEventListener('change', function (ev) {
  var tr = ev.target.closest('tr[data-key]');
  if (!tr) return;
  if (ev.target.classList.contains('mark-box')) saveMark(tr, ev.target.checked, true);
  else if (ev.target.classList.contains('remarks-in')) saveMark(tr, tr.querySelector('.mark-box').checked, false);
});

// "select all" checkboxes in the task manager
document.addEventListener('change', function (ev) {
  if (ev.target.id === 'selAll') {
    document.querySelectorAll('input[name=ids]').forEach(function (c) { c.checked = ev.target.checked; });
  }
});
