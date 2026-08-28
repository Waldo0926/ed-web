/* Ed 课程论坛整理 —— 纯前端。
 *
 * 这个文件里 fetch 的去处只有两个：edstem.org 的 API，以及本页面的相对路径。
 * token 存 sessionStorage，抓下来的数据存 IndexedDB，都不上传。
 */
'use strict';

const API = 'https://edstem.org/api';
const TOK_KEY = 'ed-web.token';
const CONCURRENCY = 4;          // 别再往上加了，Ed 会开始丢 429

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let STATE = { user: null, courses: [], data: [], active: null, filters: new Set() };

/* ---------------------------------------------------------------- Ed API */

async function edGet(path, token) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(API + path, { headers: { 'x-token': token } });
    if (r.ok) return r.json();
    if (r.status === 401 || r.status === 403) {
      const e = new Error('token 无效或已过期（HTTP ' + r.status + '）');
      e.auth = true;
      throw e;
    }
    if (r.status === 429 || r.status >= 500) {
      await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
      continue;
    }
    throw new Error('HTTP ' + r.status + ' ' + path);
  }
  throw new Error('重试多次仍然失败：' + path);
}

/* Ed 的正文是一段 XML，转成能读的纯文本 */
function docToText(doc) {
  if (!doc) return '';
  let s = String(doc)
    .replace(/<pre[^>]*>|<snippet[^>]*>/g, '\n```\n')
    .replace(/<\/pre>|<\/snippet>/g, '\n```\n')
    .replace(/<\/?(paragraph|heading|list-item|callout)[^>]*>/g, '\n')
    .replace(/<break[^>]*\/?>/g, '\n')
    .replace(/<image[^>]*src="([^"]*)"[^>]*\/?>/g, '\n[图片: $1]\n')
    .replace(/<link[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/link>/g, '$2 ($1)')
    .replace(/<[^>]+>/g, '');
  const ta = document.createElement('textarea');
  ta.innerHTML = s;
  return ta.value.replace(/\n{3,}/g, '\n\n').trim();
}

function usersIndex(arr) {
  const m = {};
  for (const u of arr || []) if (u && u.id != null) m[String(u.id)] = u;
  return m;
}

const ROLE = { admin: '教师', staff: '助教' };

function authorOf(obj, users) {
  if (obj.is_anonymous) return '匿名';
  const u = obj.user || users[String(obj.user_id)] || {};
  const role = u.course_role || u.role;
  return (u.name || '未知') + (role && role !== 'student' ? '·' + (ROLE[role] || role) : '');
}

function isStaff(obj, users) {
  const u = obj.user || users[String(obj.user_id)] || {};
  return ['admin', 'staff'].includes(u.course_role || u.role);
}

function flattenReplies(thread, users) {
  const out = [];
  const walk = (items, kind, depth) => {
    for (const it of items || []) {
      if (it.deleted_at) continue;
      out.push({
        kind, depth,
        author: authorOf(it, users),
        staff: isStaff(it, users),
        endorsed: !!it.is_endorsed,
        created_at: it.created_at,
        text: docToText(it.document || it.content),
      });
      walk(it.comments, 'reply', depth + 1);
      walk(it.replies, 'reply', depth + 1);
    }
  };
  walk(thread.answers, 'answer', 0);
  walk(thread.comments, 'comment', 0);
  return out;
}

/* -------------------------------------------------------- 规则式"总结" */

const ALERTS = [
  [/\b(due date|due on|due:|deadline|extension|extended|postponed|pushed back|new date)\b/i, '截止/延期'],
  [/\b(cancell?ed|reschedul\w*|replacement (class|workshop|tutorial|session)|room change|venue|moved to|no class|public holiday)\b/i, '时间/地点变动'],
  [/\b(marks?|grades?|results) (are |have been |now )?(released|available|up|out)\b|\bfeedback (is |are )?(released|available|now)\b/i, '成绩发布'],
  [/\b(quiz|test|exam) \d\b[\s\S]*?\b(week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(st|nd|rd|th)?[/ ]\d)/i, '考试安排'],
];

function tagsFor(text) {
  const out = [];
  for (const [re, label] of ALERTS) if (re.test(text) && !out.includes(label)) out.push(label);
  return out;
}

/* 取前 n 句。中英文标点都切。 */
function firstSentences(text, n, cap) {
  const clean = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const parts = clean.split(/(?<=[.。!?！？])\s+/).filter(Boolean);
  let s = parts.slice(0, n).join(' ');
  if (s.length > cap) s = s.slice(0, cap) + '…';
  return s;
}

/* 一句话结论：老师答了就用老师的话，否则用提问本身 */
function gistOf(t) {
  const staffReply = t.replies.find((r) => r.staff && (r.text || '').trim().length > 8);
  if (staffReply) {
    const s = firstSentences(staffReply.text, 2, 150);
    if (s) return { label: '老师答', text: s };
  }
  const anyReply = t.replies.find((r) => (r.text || '').trim().length > 25);
  if (t.type === 'question' && anyReply) {
    const s = firstSentences(anyReply.text, 2, 150);
    if (s) return { label: '同学答', text: s };
  }
  return { label: '', text: firstSentences(t.body, 2, 170) || '（无正文）' };
}

/* ---------------------------------------------------------------- 抓取 */

async function fetchCourse(cid, token, onTick) {
  const seen = new Set();
  let list = [], off = 0, users = {};
  for (;;) {
    const d = await edGet(`/courses/${cid}/threads?limit=100&offset=${off}&sort=new`, token);
    const batch = d.threads || [];
    if (!batch.length) break;
    Object.assign(users, usersIndex(d.users));
    for (const th of batch) if (!seen.has(th.id)) { seen.add(th.id); list.push(th); }
    if (batch.length < 100) break;
    off += 100;
    if (off > 3000) break;
  }
  onTick(0, list.length);

  const out = [];
  let idx = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (idx < list.length) {
      const th = list[idx++];
      try {
        const full = await edGet(`/threads/${th.id}?view=1`, token);
        const tu = Object.assign({}, users, usersIndex(full.users));
        const f = full.thread || th;
        out.push({
          id: th.id, number: th.number, type: th.type,
          title: th.title || '(无标题)',
          category: th.category || '未分类', subcategory: th.subcategory || '',
          author: authorOf(th, tu),
          created_at: th.created_at,
          reply_count: th.reply_count || 0,
          pinned: !!th.is_pinned, private: !!th.is_private,
          staff_answered: !!th.is_staff_answered,
          student_answered: !!th.is_student_answered,
          url: `https://edstem.org/au/courses/${cid}/discussion/${th.id}`,
          body: docToText(f.document || f.content),
          replies: flattenReplies(f, tu),
        });
      } catch (e) {
        if (e.auth) throw e;
        console.warn('抓取失败', th.id, e);
      }
      onTick(++done, list.length);
    }
  }));
  out.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return out;
}

/* ------------------------------------------------------------ IndexedDB */

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ed-web', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('dump');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function saveDump(payload) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction('dump', 'readwrite');
      tx.objectStore('dump').put(payload, 'latest');
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch (e) { console.warn('存本地失败（不影响使用）', e); }
}

async function loadDump() {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const tx = db.transaction('dump', 'readonly');
      const q = tx.objectStore('dump').get('latest');
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => rej(q.error);
    });
  } catch { return null; }
}

/* ---------------------------------------------------------------- 渲染 */

const fmt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate())
    .padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function decorate(t) {
  const created = t.created_at ? new Date(t.created_at) : null;
  t._new = !!created && (Date.now() - created.getTime() < 48 * 3600 * 1000);
  t._unanswered = t.type === 'question' && !t.staff_answered && !t.student_answered;
  t._tags = tagsFor(t.title + '\n' + t.body);
  t._gist = gistOf(t);
  t._hay = (t.title + ' ' + t.body + ' ' + t.replies.map((r) => r.text).join(' ')).toLowerCase().slice(0, 4000);
  return t;
}

function cardHTML(t) {
  const chips = [];
  if (t._new) chips.push('<span class="chip new">新</span>');
  if (t.private) chips.push('<span class="chip warn">私密</span>');
  if (t.pinned) chips.push('<span class="chip">置顶</span>');
  if (t.staff_answered) chips.push('<span class="chip ok">老师已答</span>');
  else if (t._unanswered) chips.push('<span class="chip q">待解答</span>');
  for (const tag of t._tags) chips.push(`<span class="chip warn">${esc(tag)}</span>`);

  const flags = [t._new && 'new', t._unanswered && 'unanswered',
                 t._tags.length && 'alert', t.staff_answered && 'staff'].filter(Boolean).join(' ');

  const gist = t._gist.label
    ? `<b>${esc(t._gist.label)}：</b>${esc(t._gist.text)}`
    : esc(t._gist.text);

  const replies = t.replies.map((r) => `
    <div class="${r.staff ? 'reply staff' : 'reply'}" style="margin-left:${Math.min(r.depth, 3) * 16}px">
      <div class="rmeta">${esc(r.author)} · ${r.kind === 'answer' ? '回答' : '评论'}${
        r.endorsed ? ' · 已认可' : ''} · ${fmt(r.created_at)}</div>${esc(r.text)}</div>`).join('');

  return `<details class="t" data-flags="${flags}" data-text="${esc(t._hay)}">
    <summary><span class="title">${esc(t.title)}</span>${chips.join('')}
      <span class="meta">${esc(t.author)} · ${fmt(t.created_at)} · ${t.reply_count} 回复 ·
        <a href="${esc(t.url)}" target="_blank" rel="noopener">在 Ed 打开</a></span>
      <div class="gist">${gist}</div></summary>
    <div class="body">${esc(t.body || '（无正文）')}</div>${replies}</details>`;
}

function renderTabs() {
  $('tabs').innerHTML = STATE.data.map((c) =>
    `<button data-cid="${c.id}" class="${c.id === STATE.active ? 'on' : ''}">${
      esc((c.code || '').split(' ')[0])} <span class="meta">${c.threads.length}</span></button>`).join('');
  for (const b of $('tabs').children) {
    b.onclick = () => { STATE.active = Number(b.dataset.cid); renderTabs(); renderList(); };
  }
}

function renderList() {
  const course = STATE.data.find((c) => c.id === STATE.active);
  if (!course) return;
  const byCat = {};
  for (const t of course.threads) {
    const k = t.category + (t.subcategory ? ' / ' + t.subcategory : '');
    (byCat[k] ||= []).push(t);
  }
  const cats = Object.entries(byCat).sort((a, b) => b[1].length - a[1].length);
  const unans = course.threads.filter((t) => t._unanswered).length;
  $('list').innerHTML =
    `<div class="sub">${esc(course.name || '')} · ${course.threads.length} 帖 · ${unans} 个未解答</div>` +
    cats.map(([cat, items]) =>
      `<h3 class="cat">${esc(cat)}（${items.length}）</h3>` + items.map(cardHTML).join('')).join('');
  applyFilters();
}

function applyFilters() {
  const q = $('q').value.trim().toLowerCase();
  for (const c of document.querySelectorAll('details.t')) {
    const f = c.dataset.flags.split(' ');
    const okText = !q || c.dataset.text.includes(q) ||
      c.querySelector('.title').textContent.toLowerCase().includes(q);
    const okFlag = [...STATE.filters].every((x) => f.includes(x));
    c.classList.toggle('hidden', !(okText && okFlag));
  }
  for (const h of document.querySelectorAll('h3.cat')) {
    let n = h.nextElementSibling, any = false;
    while (n && n.tagName === 'DETAILS') { if (!n.classList.contains('hidden')) any = true; n = n.nextElementSibling; }
    h.classList.toggle('hidden', !any);
  }
}

/* ------------------------------------------------------------------ 流程 */

function show(step) {
  for (const id of ['p-auth', 'p-pick', 'p-view']) $(id).classList.toggle('hide', id !== step);
}

function renderCourses(courses) {
  $('courses').innerHTML = courses.map((c) => `
    <label class="cbox">
      <input type="checkbox" value="${c.id}" ${c.status === 'active' ? 'checked' : ''}>
      <span><span class="code">${esc(c.code || '')}</span><br>
        <span class="nm">${esc(c.name || '')}</span>
        ${c.status !== 'active' ? '<br><span class="arch">已归档</span>' : ''}</span>
    </label>`).join('');
}

async function connect() {
  const token = $('tok').value.trim();
  $('autherr').textContent = '';
  if (!token.startsWith('ey')) {
    $('autherr').textContent = '这看起来不像 Ed 的 token —— 应该是一长串以 ey 开头的字符。';
    return;
  }
  $('go').disabled = true;
  try {
    const me = await edGet('/user', token);
    sessionStorage.setItem(TOK_KEY, token);
    STATE.user = me.user;
    STATE.courses = (me.courses || []).map((x) => ({
      id: x.course.id, code: x.course.code, name: x.course.name, status: x.course.status,
    })).sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1));
    $('who').textContent = `${me.user.name} · ${me.user.email} · 共 ${STATE.courses.length} 门课`;
    renderCourses(STATE.courses);
    show('p-pick');
  } catch (e) {
    $('autherr').textContent = e.message;
  } finally {
    $('go').disabled = false;
  }
}

async function crawl() {
  const picked = [...document.querySelectorAll('#courses input:checked')].map((i) => Number(i.value));
  $('crawlerr').textContent = '';
  if (!picked.length) { $('crawlerr').textContent = '至少选一门课。'; return; }
  const token = sessionStorage.getItem(TOK_KEY);
  $('crawl').disabled = true;
  $('prog').classList.remove('hidden');

  const data = [];
  try {
    for (let i = 0; i < picked.length; i++) {
      const c = STATE.courses.find((x) => x.id === picked[i]);
      const threads = await fetchCourse(picked[i], token, (done, total) => {
        $('progtext').textContent =
          `[${i + 1}/${picked.length}] ${c.code} — ${done}/${total} 帖`;
        $('prog').value = total ? ((i + done / total) / picked.length) * 100 : 0;
      });
      data.push({ ...c, threads: threads.map(decorate) });
    }
  } catch (e) {
    $('crawlerr').textContent = e.auth
      ? 'token 在抓取途中失效了。回上一步换一张新的。'
      : '抓取出错：' + e.message;
    $('crawl').disabled = false;
    return;
  }

  STATE.data = data;
  STATE.active = data[0].id;
  await saveDump({ saved_at: new Date().toISOString(), user: STATE.user, data });
  $('crawl').disabled = false;
  $('prog').classList.add('hidden');
  $('progtext').textContent = '';
  show('p-view');
  renderTabs();
  renderList();
}

function exportJSON() {
  const blob = new Blob([JSON.stringify({ saved_at: new Date().toISOString(), data: STATE.data })],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ed-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

function adoptDump(d) {
  if (!d || !Array.isArray(d.data) || !d.data.length) return false;
  STATE.data = d.data.map((c) => ({ ...c, threads: (c.threads || []).map(decorate) }));
  STATE.active = STATE.data[0].id;
  show('p-view');
  renderTabs();
  renderList();
  return true;
}

/* ------------------------------------------------------------------ 绑定 */

$('go').onclick = connect;
$('tok').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.metaKey) connect(); });
$('crawl').onclick = crawl;
$('back').onclick = () => show('p-auth');
$('restart').onclick = () => show('p-pick');
$('export').onclick = exportJSON;
$('selall').onclick = () =>
  document.querySelectorAll('#courses input').forEach((i) => { i.checked = true; });
$('selactive').onclick = () =>
  document.querySelectorAll('#courses input').forEach((i) => {
    i.checked = STATE.courses.find((c) => c.id === Number(i.value)).status === 'active';
  });

$('loadfile').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    if (!adoptDump(JSON.parse(await f.text()))) throw new Error('文件里没有可用的数据');
  } catch (err) {
    $('autherr').textContent = '读不了这个文件：' + err.message;
  }
};

$('q').addEventListener('input', applyFilters);
document.querySelectorAll('.btn[data-f]').forEach((b) => {
  b.onclick = () => {
    const k = b.dataset.f;
    STATE.filters.has(k) ? STATE.filters.delete(k) : STATE.filters.add(k);
    b.classList.toggle('on');
    applyFilters();
  };
});
$('expand').onclick = (e) => {
  const vis = [...document.querySelectorAll('details.t')].filter((c) => !c.classList.contains('hidden'));
  const open = vis.some((c) => !c.open);
  vis.forEach((c) => { c.open = open; });
  e.target.textContent = open ? '收起全部' : '展开全部';
};

/* 回到页面时，如果本地还留着上次的结果就直接显示 */
(async () => {
  const saved = sessionStorage.getItem(TOK_KEY);
  if (saved) $('tok').value = saved;
  const d = await loadDump();
  if (d && adoptDump(d)) {
    $('progtext').textContent = '';
    console.info('已从本地读回上次抓取的结果', d.saved_at);
  }
})();
