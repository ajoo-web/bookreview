'use strict';

/* ════════════════════════════════════════════════════════════
   My Book Reviews
   - Reviews live in localStorage and sync to a Google Sheet via an
     Apps Script web app (see apps-script/Code.gs).
   - Every review has a stable `id`; edits update in place and deletes
     are synced. Failed syncs are queued and retried.
   ════════════════════════════════════════════════════════════ */

const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxoYnHVYOTRg3ttWnFkitldJYy694xSjqOgn_4veQq657d44vpqfI-oyFWKJka5WSgzSA/exec';
const STORE_KEY = 'bookReviews';
const QUEUE_KEY = 'bookReviewsQueue';
const PER_PAGE = 5;
const GALLERY_MIN_CELLS = 40; // 4 cols x 10 rows; grows if a year has more books
const FIELDS = ['Title', 'CoverURL', 'Author', 'Rating', 'Format', 'Start Date', 'End Date', 'Summary', 'Thoughts', 'Quotes'];
const FORMAT_LABEL = { Print: '📖 Print', Audio: '🎧 Audiobook', eBook: '📱 eBook' };

const state = { tab: 'home', page: 1, query: '', sort: 'newest', rating: '', format: '' };
const $ = id => document.getElementById(id);

/* ───────────── helpers ───────────── */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Only allow http(s) URLs for images/links
function safeUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : '';
  } catch (e) { return ''; }
}

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function ratingNum(r) { return ((r && r.Rating) || '').split('⭐').length - 1; }

function finishedYear(r) {
  const d = (r['End Date'] || r['Start Date'] || '').slice(0, 4);
  return /^\d{4}$/.test(d) ? d : '';
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Escape text for HTML and wrap search matches in <mark>
function hlText(text, q) {
  text = String(text == null ? '' : text);
  if (!q) return esc(text);
  const re = new RegExp(escapeRegExp(q), 'gi');
  let out = '', last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out += esc(text.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

// Extract "..." / “...” / ‘...’ blocks from the quotes textarea
function parseQuotes(raw) {
  if (!raw) return [];
  const openChars = ['"', '“', '‘'];
  const closeChars = ['"', '”', '’'];
  const results = [];
  let i = 0;
  while (i < raw.length) {
    let openIdx = -1, closeChar = '';
    for (let oi = 0; oi < openChars.length; oi++) {
      const tmp = raw.indexOf(openChars[oi], i);
      if (tmp !== -1 && (openIdx === -1 || tmp < openIdx)) { openIdx = tmp; closeChar = closeChars[oi]; }
    }
    if (openIdx === -1) break;
    const closeIdx = raw.indexOf(closeChar, openIdx + 1);
    if (closeIdx === -1) break;
    const q = raw.slice(openIdx + 1, closeIdx).trim();
    if (q) results.push(q);
    i = closeIdx + 1;
  }
  return results;
}

// Coerce an object from the sheet / an import file into a clean review
function normalizeReview(row) {
  const out = { id: String(row.id || ''), updatedAt: String(row.updatedAt || '') };
  FIELDS.forEach(f => { out[f] = String(row[f] == null ? '' : row[f]).trim(); });
  ['Start Date', 'End Date'].forEach(f => { if (/^\d{4}-\d{2}-\d{2}/.test(out[f])) out[f] = out[f].slice(0, 10); });
  if (/^[1-5]$/.test(out.Rating)) out.Rating = '⭐'.repeat(Number(out.Rating));
  return out;
}

const sameBook = (a, b) =>
  (a.Title || '').toLowerCase() === (b.Title || '').toLowerCase() &&
  (a.Author || '').toLowerCase() === (b.Author || '').toLowerCase() &&
  (a['Start Date'] || '') === (b['Start Date'] || '') &&
  (a['End Date'] || '') === (b['End Date'] || '');

/* ───────────── storage ───────────── */

function load() {
  try {
    const a = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}

function save(list) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return true; }
  catch (e) { setSync('⚠️ Could not save in this browser (storage full or blocked).', 'pending'); return false; }
}

// Older entries have no id: give them one
function migrate() {
  const list = load();
  let changed = false;
  list.forEach(r => { if (!r.id) { r.id = uid(); changed = true; } });
  if (changed) save(list);
}

/* ───────────── sync (Google Sheet) ───────────── */

function getQueue() {
  try { const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); return Array.isArray(q) ? q : []; }
  catch (e) { return []; }
}
function setQueue(q) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) { /* ignore */ } }

function setSync(msg, cls) {
  const el = $('syncStatus');
  el.textContent = msg;
  el.className = 'sync-status' + (cls ? ' ' + cls : '');
}

function updateSyncStatus() {
  const n = getQueue().length;
  if (n) setSync('⏳ ' + n + ' change' + (n === 1 ? '' : 's') + ' waiting to sync', 'pending');
  else setSync('☁ Synced with Google Sheets', 'ok');
}

function enqueue(op) {
  // Only the latest operation per review matters
  const q = getQueue().filter(o => o.id !== op.id);
  q.push(op);
  setQueue(q);
  updateSyncStatus();
  flushQueue();
}

function postOp(op) {
  const body = new URLSearchParams();
  body.set('action', op.action);
  body.set('id', op.id);
  if (op.review) Object.keys(op.review).forEach(k => body.set(k, op.review[k] == null ? '' : op.review[k]));
  return fetch(SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(), mode: 'no-cors', redirect: 'follow'
  });
}

let flushing = false;
async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    let q = getQueue();
    while (q.length) {
      await postOp(q[0]);
      // Re-read: new ops may have been queued while we were sending
      q = getQueue().filter(o => !(o.id === q[0].id && o.updatedAt === q[0].updatedAt && o.action === q[0].action));
      setQueue(q);
    }
    updateSyncStatus();
  } catch (e) {
    updateSyncStatus(); // stays queued; retried on next load / when back online
  } finally { flushing = false; }
}

// Merge reviews from the sheet into local storage
function mergeRemote(rows) {
  const local = load();
  const queue = getQueue();
  const pendingDelete = new Set(queue.filter(o => o.action === 'delete').map(o => o.id));
  const pendingIds = new Set(queue.map(o => o.id));
  const remote = rows.map(normalizeReview);
  const remoteIds = new Set(remote.map(r => r.id).filter(Boolean));
  let changed = false;

  remote.forEach(r => {
    if (!r.id || pendingDelete.has(r.id)) return;
    let mine = local.find(x => x.id === r.id);
    if (!mine) {
      // Pre-id local copy of the same book: adopt the sheet's id instead of duplicating
      mine = local.find(x => !remoteIds.has(x.id) && sameBook(x, r));
      if (mine) { mine.id = r.id; changed = true; }
    }
    if (!mine) { local.push(r); changed = true; return; }
    if (!pendingIds.has(r.id) && r.updatedAt && r.updatedAt > (mine.updatedAt || '')) {
      Object.assign(mine, r); changed = true;
    }
  });
  if (changed) { save(local); refreshAll(); }
}

async function pullFromSheet() {
  try {
    const res = await fetch(SCRIPT_URL + '?action=list', { redirect: 'follow' });
    if (!res.ok) return false;
    const data = await res.json();
    if (!Array.isArray(data)) return false;
    mergeRemote(data);
    return true;
  } catch (e) { return false; } // old script without doGet, offline, etc.
}

/* ───────────── cover lookup (Open Library) ───────────── */

async function findCover(title, author) {
  const u = new URL('https://openlibrary.org/search.json');
  u.searchParams.set('title', title);
  if (author) u.searchParams.set('author', author);
  u.searchParams.set('limit', '5');
  u.searchParams.set('fields', 'cover_i,title,author_name');
  const res = await fetch(u.href);
  if (!res.ok) throw new Error('lookup failed');
  const data = await res.json();
  const hit = (data.docs || []).find(d => d.cover_i);
  return hit ? 'https://covers.openlibrary.org/b/id/' + hit.cover_i + '-L.jpg' : '';
}

function wireCoverLookup(btnId, titleId, authorId, urlId, hintId, onFound) {
  $(btnId).addEventListener('click', async () => {
    const title = $(titleId).value.trim();
    const hint = $(hintId);
    if (!title) { hint.textContent = 'Enter a title first.'; return; }
    const btn = $(btnId);
    btn.disabled = true; hint.textContent = 'Searching Open Library…';
    try {
      const url = await findCover(title, $(authorId).value.trim());
      if (url) { $(urlId).value = url; hint.textContent = 'Cover found.'; if (onFound) onFound(url); }
      else hint.textContent = 'No cover found. You can paste an image URL instead.';
    } catch (e) { hint.textContent = 'Cover lookup failed (offline?). Paste a URL instead.'; }
    btn.disabled = false;
  });
}

/* ───────────── tabs / year galleries ───────────── */

function getYears() {
  const years = new Set();
  load().forEach(r => { const y = finishedYear(r); if (y) years.add(y); });
  return Array.from(years).sort();
}

function rebuildYearTabs() {
  const bar = $('tabsBar');
  const pages = $('yearPages');
  bar.querySelectorAll('.year-tab').forEach(t => t.remove());
  pages.innerHTML = '';
  const years = getYears();

  years.forEach(year => { // year is always 4 digits (see finishedYear)
    const btn = document.createElement('button');
    btn.className = 'tab-btn year-tab';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.dataset.tab = 'year-' + year;
    btn.textContent = year;
    bar.appendChild(btn);

    const page = document.createElement('div');
    page.id = 'year-' + year;
    page.className = 'page year-page';
    page.innerHTML = '<div class="container"><h2>' + year + ' Reading Gallery <span class="gallery-count" id="count-' + year +
      '"></span></h2><div class="gallery-grid" id="gallery-' + year + '"></div></div>';
    pages.appendChild(page);
  });

  if (state.tab.startsWith('year-') && !years.includes(state.tab.slice(5))) showTab('reviews');
  else showTab(state.tab, true);
}

function buildCell(r) {
  const cell = document.createElement('div');
  cell.className = 'gallery-cell filled';
  cell.dataset.id = r.id;
  cell.tabIndex = 0;
  cell.setAttribute('role', 'button');
  cell.setAttribute('aria-label', (r.Title || 'Untitled') + (r.Author ? ' by ' + r.Author : ''));

  const title = document.createElement('div');
  title.className = 'cell-title';
  title.textContent = r.Title || '';
  const tip = document.createElement('div');
  tip.className = 'gallery-cell-tooltip';

  const url = safeUrl(r.CoverURL);
  if (url) {
    tip.textContent = r.Title || '';
    title.style.display = 'none';
    const img = new Image();
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => { img.remove(); title.style.display = ''; };
    img.src = url;
    cell.append(img, title, tip);
  } else {
    tip.textContent = r.Author || '';
    cell.append(title, tip);
  }
  return cell;
}

function renderGallery(year) {
  const grid = $('gallery-' + year);
  if (!grid) return;
  const books = load().filter(r => finishedYear(r) === year).sort((a, b) =>
    (a['End Date'] || a['Start Date'] || '').localeCompare(b['End Date'] || b['Start Date'] || ''));
  const total = Math.max(GALLERY_MIN_CELLS, Math.ceil(books.length / 4) * 4);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < total; i++) {
    if (i < books.length) frag.appendChild(buildCell(books[i]));
    else {
      const cell = document.createElement('div');
      cell.className = 'gallery-cell';
      cell.innerHTML = '<span class="cell-empty">+</span>';
      frag.appendChild(cell);
    }
  }
  grid.innerHTML = '';
  grid.appendChild(frag);
  const count = $('count-' + year);
  if (count) count.textContent = '(' + books.length + ' book' + (books.length === 1 ? '' : 's') + ')';
}

function showTab(tab, keepPage) {
  state.tab = tab;
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === tab));
  document.querySelectorAll('.tab-btn').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (tab === 'reviews') { if (!keepPage) state.page = 1; renderReviews(); }
  else if (tab === 'stats') renderStats();
  else if (tab.startsWith('year-')) renderGallery(tab.slice(5));
}

function refreshAll() { rebuildYearTabs(); }

/* ───────────── reviews list ───────────── */

function getFiltered() {
  const items = load().map((r, i) => ({ r, i }));
  const q = state.query.trim().toLowerCase();
  let list = items.filter(({ r }) => {
    if (state.format && r.Format !== state.format) return false;
    if (state.rating !== '' && ratingNum(r) !== Number(state.rating)) return false;
    if (!q) return true;
    return ['Title', 'Author', 'Summary', 'Thoughts', 'Quotes'].some(f => (r[f] || '').toLowerCase().includes(q));
  });
  const cmp = {
    newest: (a, b) => b.i - a.i,
    oldest: (a, b) => a.i - b.i,
    finished: (a, b) => (b.r['End Date'] || '').localeCompare(a.r['End Date'] || '') || b.i - a.i,
    high: (a, b) => ratingNum(b.r) - ratingNum(a.r) || b.i - a.i,
    low: (a, b) => ratingNum(a.r) - ratingNum(b.r) || b.i - a.i,
    title: (a, b) => (a.r.Title || '').localeCompare(b.r.Title || '')
  }[state.sort] || ((a, b) => b.i - a.i);
  list.sort(cmp);
  return list.map(x => x.r);
}

function renderReviews() {
  const filtered = getFiltered();
  const container = $('reviews-list');
  const pg = $('pagination');
  $('resultCount').textContent = filtered.length + ' review' + (filtered.length === 1 ? '' : 's');
  if (filtered.length === 0) {
    container.innerHTML = '<p id="no-reviews">No reviews found.</p>';
    pg.innerHTML = '';
    return;
  }
  const totalPages = Math.ceil(filtered.length / PER_PAGE);
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * PER_PAGE;
  const q = state.query.trim();

  container.innerHTML = filtered.slice(start, start + PER_PAGE).map(r => {
    const cover = safeUrl(r.CoverURL);
    const coverHTML = cover ? '<img class="cover" loading="lazy" alt="" src="' + esc(cover) + '" onerror="this.style.display=\'none\'" />' : '';
    const quotesHTML = parseQuotes(r.Quotes).map(t => '<blockquote>' + hlText(t, q) + '</blockquote>').join('');
    return '<div class="review-card">' +
      '<div class="card-actions">' +
        '<button class="icon-btn" data-action="edit" data-id="' + esc(r.id) + '" title="Edit" aria-label="Edit review">✏️</button>' +
        '<button class="icon-btn del" data-action="delete" data-id="' + esc(r.id) + '" title="Delete" aria-label="Delete review">🗑️</button>' +
      '</div>' + coverHTML +
      '<h3>' + hlText(r.Title || 'Untitled', q) + '</h3>' +
      '<div class="meta">by ' + hlText(r.Author || '', q) + ' &nbsp;·&nbsp; ' + esc(FORMAT_LABEL[r.Format] || r.Format || '') +
        ' &nbsp;·&nbsp; ' + esc(r['Start Date'] || '?') + ' → ' + esc(r['End Date'] || '?') + '</div>' +
      '<div class="stars-display">' + esc(r.Rating || '') + '</div>' +
      (r.Summary ? '<p><strong>Summary:</strong> ' + hlText(r.Summary, q) + '</p>' : '') +
      (r.Thoughts ? '<p><strong>Thoughts:</strong> ' + hlText(r.Thoughts, q) + '</p>' : '') +
      quotesHTML + '</div>';
  }).join('');

  let btns = '<button data-page="' + (state.page - 1) + '"' + (state.page === 1 ? ' disabled' : '') + '>‹ Prev</button>';
  for (let i = 1; i <= totalPages; i++)
    btns += '<button class="' + (i === state.page ? 'active' : '') + '" data-page="' + i + '">' + i + '</button>';
  btns += '<button data-page="' + (state.page + 1) + '"' + (state.page === totalPages ? ' disabled' : '') + '>Next ›</button>';
  pg.innerHTML = btns;
}

function deleteReview(id) {
  if (!confirm('Delete this review?')) return;
  save(load().filter(r => r.id !== id));
  enqueue({ action: 'delete', id, updatedAt: new Date().toISOString() });
  refreshAll();
}

/* ───────────── edit modal ───────────── */

let lastFocus = null;

function openEdit(id) {
  const r = load().find(x => x.id === id);
  if (!r) return;
  $('edit-id').value = r.id;
  $('edit-Title').value = r.Title || '';
  $('edit-CoverURL').value = r.CoverURL || '';
  $('edit-Author').value = r.Author || '';
  $('edit-Format').value = r.Format || 'Print';
  $('edit-StartDate').value = r['Start Date'] || '';
  $('edit-EndDate').value = r['End Date'] || '';
  $('edit-Summary').value = r.Summary || '';
  $('edit-Thoughts').value = r.Thoughts || '';
  $('edit-Quotes').value = r.Quotes || '';
  document.querySelectorAll('input[name="editRating"]').forEach(el => { el.checked = el.value === r.Rating; });
  $('editError').textContent = '';
  $('editCoverHint').textContent = '';
  lastFocus = document.activeElement;
  $('editModal').classList.add('open');
  $('edit-Title').focus();
}

function closeModal() {
  $('editModal').classList.remove('open');
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

function saveEdit() {
  const id = $('edit-id').value;
  const start = $('edit-StartDate').value, end = $('edit-EndDate').value;
  if (!$('edit-Title').value.trim() || !$('edit-Author').value.trim()) { $('editError').textContent = 'Title and author are required.'; return; }
  if (start && end && end < start) { $('editError').textContent = 'End date is before the start date.'; return; }

  const list = load();
  const idx = list.findIndex(r => r.id === id);
  if (idx === -1) { closeModal(); return; }
  const ratingEl = document.querySelector('input[name="editRating"]:checked');
  const updated = {
    id,
    updatedAt: new Date().toISOString(),
    Title: $('edit-Title').value.trim(),
    CoverURL: $('edit-CoverURL').value.trim(),
    Author: $('edit-Author').value.trim(),
    Rating: ratingEl ? ratingEl.value : '',
    Format: $('edit-Format').value,
    'Start Date': start,
    'End Date': end,
    Summary: $('edit-Summary').value,
    Thoughts: $('edit-Thoughts').value,
    Quotes: $('edit-Quotes').value
  };
  list[idx] = updated;
  save(list);
  closeModal();
  enqueue({ action: 'update', id, updatedAt: updated.updatedAt, review: updated });
  refreshAll();
}

/* ───────────── gallery popout ───────────── */

function openGpop(id) {
  const r = load().find(x => x.id === id);
  if (!r) return;
  const box = $('gpopBody');
  box.innerHTML = '';
  const add = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.textContent = text;
    box.appendChild(el);
    return el;
  };

  const cover = safeUrl(r.CoverURL);
  if (cover) {
    const img = new Image();
    img.alt = '';
    img.onerror = () => img.remove();
    img.src = cover;
    box.appendChild(img);
  }
  add('h3', '', r.Title || '');
  add('div', 'meta', 'by ' + (r.Author || '') + ' · ' + (FORMAT_LABEL[r.Format] || r.Format || '') + ' · ' + (r['Start Date'] || '?') + ' → ' + (r['End Date'] || '?'));
  add('div', 'stars-display', r.Rating || '');
  [['Summary', r.Summary], ['Thoughts', r.Thoughts]].forEach(([label, text]) => {
    if (!text) return;
    const p = document.createElement('p');
    const b = document.createElement('strong');
    b.textContent = label + ': ';
    p.append(b, document.createTextNode(text));
    box.appendChild(p);
  });
  parseQuotes(r.Quotes).forEach(q => add('blockquote', '', q));
  lastFocus = document.activeElement;
  $('gpopOverlay').classList.add('open');
  $('gpopClose').focus();
}

function closeGpop() {
  $('gpopOverlay').classList.remove('open');
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

/* ───────────── stats ───────────── */

function barRows(entries, max) {
  return entries.map(([label, n]) =>
    '<div class="bar-row"><span class="bar-label" title="' + esc(label) + '">' + esc(label) + '</span>' +
    '<span class="bar-track"><div class="bar" style="width:' + (max ? Math.round(n / max * 100) : 0) + '%"></div></span>' +
    '<span class="bar-count">' + n + '</span></div>').join('');
}

function renderStats() {
  const list = load();
  const body = $('statsBody');
  if (!list.length) { body.innerHTML = '<p id="no-reviews">Nothing to show yet. Add your first review!</p>'; return; }

  const rated = list.filter(r => ratingNum(r) > 0);
  const avg = rated.length ? (rated.reduce((s, r) => s + ratingNum(r), 0) / rated.length).toFixed(1) : '–';
  const thisYear = String(new Date().getFullYear());
  const countBy = (keyFn) => {
    const m = new Map();
    list.forEach(r => { const k = keyFn(r); if (k) m.set(k, (m.get(k) || 0) + 1); });
    return m;
  };
  const years = Array.from(countBy(finishedYear)).sort((a, b) => a[0].localeCompare(b[0]));
  const formats = Array.from(countBy(r => FORMAT_LABEL[r.Format] || r.Format)).sort((a, b) => b[1] - a[1]);
  const authors = Array.from(countBy(r => (r.Author || '').trim())).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  const dist = [5, 4, 3, 2, 1].map(n => ['⭐'.repeat(n), list.filter(r => ratingNum(r) === n).length]);
  const maxOf = arr => Math.max(1, ...arr.map(e => e[1]));

  body.innerHTML =
    '<div class="stat-grid">' +
      '<div class="stat"><b>' + list.length + '</b><span>books reviewed</span></div>' +
      '<div class="stat"><b>' + (countBy(finishedYear).get(thisYear) || 0) + '</b><span>finished in ' + thisYear + '</span></div>' +
      '<div class="stat"><b>' + avg + '</b><span>average rating</span></div>' +
      '<div class="stat"><b>' + new Set(list.map(r => (r.Author || '').toLowerCase()).filter(Boolean)).size + '</b><span>authors</span></div>' +
    '</div>' +
    (years.length ? '<div class="stats-section"><h3>Books per year</h3>' + barRows(years, maxOf(years)) + '</div>' : '') +
    '<div class="stats-section"><h3>Ratings</h3>' + barRows(dist, maxOf(dist)) + '</div>' +
    (formats.length ? '<div class="stats-section"><h3>Formats</h3>' + barRows(formats, maxOf(formats)) + '</div>' : '') +
    (authors.length ? '<div class="stats-section"><h3>Most-read authors</h3>' + barRows(authors, maxOf(authors)) + '</div>' : '');
}

/* ───────────── export / import ───────────── */

function exportBackup() {
  const blob = new Blob([JSON.stringify(load(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'book-reviews-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  $('dataHint').textContent = 'Backup downloaded.';
}

function importBackup(file) {
  const hint = $('dataHint');
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data)) throw new Error('not a list');
      const list = load();
      let added = 0, updated = 0;
      data.filter(x => x && typeof x === 'object').map(normalizeReview).forEach(r => {
        if (!r.Title) return;
        const mine = (r.id && list.find(x => x.id === r.id)) || list.find(x => sameBook(x, r));
        if (mine) {
          if ((r.updatedAt || '') > (mine.updatedAt || '')) { Object.assign(mine, r, { id: mine.id }); updated++; enqueue({ action: 'update', id: mine.id, updatedAt: mine.updatedAt, review: mine }); }
        } else {
          if (!r.id) r.id = uid();
          if (!r.updatedAt) r.updatedAt = new Date().toISOString();
          list.push(r); added++;
          enqueue({ action: 'add', id: r.id, updatedAt: r.updatedAt, review: r });
        }
      });
      save(list);
      refreshAll();
      hint.textContent = 'Import complete: ' + added + ' added, ' + updated + ' updated.';
    } catch (e) { hint.textContent = 'That file is not a valid backup.'; }
  };
  reader.readAsText(file);
}

/* ───────────── events ───────────── */

$('tabsBar').addEventListener('click', e => {
  const b = e.target.closest('.tab-btn');
  if (b) showTab(b.dataset.tab);
});

$('searchInput').addEventListener('input', e => { state.query = e.target.value; state.page = 1; renderReviews(); });
$('sortSelect').addEventListener('change', e => { state.sort = e.target.value; state.page = 1; renderReviews(); });
$('ratingFilter').addEventListener('change', e => { state.rating = e.target.value; state.page = 1; renderReviews(); });
$('formatFilter').addEventListener('change', e => { state.format = e.target.value; state.page = 1; renderReviews(); });

$('reviews-list').addEventListener('click', e => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  if (b.dataset.action === 'edit') openEdit(b.dataset.id);
  else if (b.dataset.action === 'delete') deleteReview(b.dataset.id);
});

$('pagination').addEventListener('click', e => {
  const b = e.target.closest('button[data-page]');
  if (!b || b.disabled) return;
  state.page = Number(b.dataset.page);
  renderReviews();
  window.scrollTo(0, 0);
});

// Gallery cells (event delegation; works for dynamically created year pages)
document.addEventListener('click', e => {
  const c = e.target.closest('.gallery-cell.filled');
  if (c) openGpop(c.dataset.id);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if ($('editModal').classList.contains('open')) closeModal();
    if ($('gpopOverlay').classList.contains('open')) closeGpop();
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('gallery-cell') && e.target.classList.contains('filled')) {
    e.preventDefault();
    openGpop(e.target.dataset.id);
  }
});

$('gpopOverlay').addEventListener('click', e => { if (e.target === $('gpopOverlay')) closeGpop(); });
$('gpopClose').addEventListener('click', closeGpop);
$('editModal').addEventListener('click', e => { if (e.target === $('editModal')) closeModal(); });
$('editClose').addEventListener('click', closeModal);
$('editCancel').addEventListener('click', closeModal);
$('editSave').addEventListener('click', saveEdit);

// Cover preview + lookup (new-review form)
function previewCover(url) {
  const img = $('cover-preview');
  const safe = safeUrl(url);
  if (safe) { img.src = safe; img.style.display = 'block'; } else { img.style.display = 'none'; }
}
$('coverURLInput').addEventListener('input', e => previewCover(e.target.value));
wireCoverLookup('findCoverBtn', 'f-title', 'f-author', 'coverURLInput', 'coverHint', previewCover);
wireCoverLookup('editFindCoverBtn', 'edit-Title', 'edit-Author', 'edit-CoverURL', 'editCoverHint');

// New review
$('reviewForm').addEventListener('submit', function (e) {
  e.preventDefault();
  const status = $('status');
  const raw = Object.fromEntries(new FormData(this).entries());
  if (raw['Start Date'] && raw['End Date'] && raw['End Date'] < raw['Start Date']) {
    status.textContent = '⚠️ End date is before the start date.';
    return;
  }
  const entry = normalizeReview(raw);
  // keep text areas as typed (normalize trims them)
  entry.id = uid();
  entry.updatedAt = new Date().toISOString();
  const list = load();
  list.push(entry);
  if (!save(list)) { status.textContent = '⚠️ Could not save.'; return; }
  status.textContent = '✅ Review saved!';
  enqueue({ action: 'add', id: entry.id, updatedAt: entry.updatedAt, review: entry });
  this.reset();
  $('cover-preview').style.display = 'none';
  $('coverHint').textContent = '';
  refreshAll();
});

// Data tools
$('exportBtn').addEventListener('click', exportBackup);
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });
$('refreshBtn').addEventListener('click', async () => {
  $('dataHint').textContent = 'Refreshing…';
  await flushQueue();
  const ok = await pullFromSheet();
  $('dataHint').textContent = ok ? 'Up to date with the sheet.' : 'Could not load from the sheet. It needs the updated Apps Script (see README).';
});

window.addEventListener('online', flushQueue);

/* ───────────── init ───────────── */

migrate();
rebuildYearTabs();
updateSyncStatus();
flushQueue().then(pullFromSheet);
