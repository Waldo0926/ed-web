/* Ed 课程论坛整理 —— 纯前端。
 *
 * 这个文件里 fetch 的去处只有三个：edstem.org 的 API、Ed 的课程文件
 * （static.edusercontent.com，一键下载时拉 PDF 用，不带 token），以及本页面的相对路径。
 * token 存 sessionStorage，抓下来的数据存 IndexedDB，都不上传。
 */
'use strict';

const API = 'https://edstem.org/api';
const TOK_KEY = 'ed-web.token';
const THEME_KEY = 'ed-web.theme';
const CONCURRENCY = 4;          // 别再往上加了，Ed 会开始丢 429
const DUMP_VERSION = 2;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------------------------------------------------------- token */

/* Ed 设置页（settings/api-tokens）生成的 API 令牌不过期，形如 xxxx.yyyy；
 * 从 localStorage 取的是三段式 JWT，14 天过期。两种令牌走的请求头不一样，跟 ed-digest 一致。 */
function tokenKind(token) {
  return String(token || '').split('.').length === 3 ? 'jwt' : 'api';
}

function authHeaders(token) {
  return tokenKind(token) === 'jwt' ? { 'x-token': token } : { authorization: 'Bearer ' + token };
}

/* 读 JWT 的 exp（不校验签名，只是为了提醒还剩几天）。API 令牌没有到期时间，返回 null。 */
function tokenExpiry(token) {
  if (tokenKind(token) !== 'jwt') return null;
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const data = JSON.parse(atob(payload + '='.repeat((4 - payload.length % 4) % 4)));
    return data.exp ? new Date(data.exp * 1000) : null;
  } catch { return null; }
}

function tokenLooksValid(token) {
  return /^[A-Za-z0-9._~+/=-]{20,}$/.test(token);
}

/* 帖子的变更指纹，跟 ed-digest 的 content_stamp 一样：updated_at 之外再带几个计数和状态位，
 * 这样只有内容真变了才重抓正文。 */
function contentStamp(t) {
  return [t.updated_at, t.reply_count, t.unresolved_count, t.vote_count, t.is_staff_answered,
          t.is_answered, t.is_locked, t.title].map((x) => String(x ?? '')).join('|');
}

/* 搜索：每个词都要出现，不分大小写（ed-digest 的 search 也是这个规则）。 */
function matchWords(hay, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const low = String(hay || '').toLowerCase();
  return words.every((w) => low.includes(w));
}

let STATE = { user: null, courses: [], data: [], active: null, view: 'threads',
              filters: new Set(), lessonFilters: new Set(),
              syncedAt: null, prevSyncedAt: null, syncingAt: null, failed: 0 };

/* ---------------------------------------------------------------- Ed API */

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

async function edGet(path, token) {
  for (let i = 0; i < 4; i++) {
    let r;
    try {
      r = await fetch(API + path, { headers: authHeaders(token) });
    } catch (err) {
      // 连不上，或者浏览器的跨域预检被 Ed 拒了（fetch 只会抛 TypeError，拿不到状态码）
      const e = new Error(tokenKind(token) === 'api'
        ? '请求没发出去。可能是网络问题，也可能是 Ed 不允许浏览器用 API 令牌，换成浏览器 token 再试。'
        : '连不上 Ed（' + err.message + '）');
      e.network = true;
      throw e;
    }
    if (r.ok) return r.json();
    if (r.status === 401 || r.status === 403) {
      const e = new Error('token 无效或已过期（HTTP ' + r.status + '）');
      e.auth = true;
      throw e;
    }
    if (r.status === 429 || r.status >= 500) {
      // Ed 给了 Retry-After 就听它的（浏览器拿得到的话），没给就 1.5s、3s、4.5s
      const ra = Number(r.headers.get('retry-after'));
      await sleep(ra > 0 ? Math.min(ra, 60) * 1000 : 1500 * (i + 1));
      continue;
    }
    throw new Error('HTTP ' + r.status + ' ' + path);
  }
  throw new Error('重试多次仍然失败：' + path);
}

/* ------------------------------------------------ Ed 的正文：XML → 纯文本 / HTML */

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unescapeXml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  }
  return ENTITY[e.toLowerCase()] ?? m;
});

/* 纯文本版：给一句话结论和搜索用。附件、图片、链接的网址都留着，不然搜不到。 */
function docToText(doc) {
  if (!doc) return '';
  let s = String(doc);
  if (!s.trim().startsWith('<document')) return s.trim();
  s = s.replace(/<pre[^>]*>|<snippet[^>]*>/g, '\n```\n')
    .replace(/<\/pre>|<\/snippet>/g, '\n```\n')
    .replace(/<\/?(paragraph|heading|list-item|callout|blockquote)[^>]*>/g, '\n')
    .replace(/<break[^>]*\/?>/g, '\n')
    .replace(/<image[^>]*src="([^"]*)"[^>]*\/?>/g, '\n[图片: $1]\n')
    .replace(/<file[^>]*?(?:url="([^"]*)"[^>]*?filename="([^"]*)"|filename="([^"]*)"[^>]*?url="([^"]*)")[^>]*\/?>/g,
      (m, u1, n1, n2, u2) => `\n[附件: ${n1 || n2} ${u1 || u2}]\n`)
    .replace(/<video[^>]*src="([^"]*)"[^>]*\/?>/g, '\n[视频: $1]\n')
    .replace(/<link[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/link>/g, '$2 ($1)')
    .replace(/<[^>]+>/g, '');
  return unescapeXml(s).replace(/\n{3,}/g, '\n\n').trim();
}

const safeHref = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : null);

/* 富文本版：段落、粗体、代码、链接、图片、附件都渲染出来。只认 http(s) 链接，
 * 输出的每一段文字都经过 esc，XML 解析失败就退回纯文本。 */
function docToHTML(doc) {
  if (!doc) return '';
  const s = String(doc).trim();
  if (!s.startsWith('<document')) return esc(s);
  let root;
  try {
    const x = new DOMParser().parseFromString(s, 'text/xml');
    if (x.getElementsByTagName('parsererror').length) throw new Error('bad xml');
    root = x.documentElement;
  } catch {
    return esc(docToText(doc));
  }
  const link = (href, label, cls) => {
    const h = safeHref(href);
    return h ? `<a class="${cls}" href="${esc(h)}" target="_blank" rel="noopener">${esc(label)}</a>`
             : `<span class="${cls}">${esc(label)}</span>`;
  };
  const walk = (node) => {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += esc(n.nodeValue); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.nodeName, inner = () => walk(n), a = (k) => n.getAttribute(k) || '';
      switch (tag) {
        case 'paragraph': out += `<p>${inner()}</p>`; break;
        case 'heading': out += `<h4>${inner()}</h4>`; break;
        case 'bold': out += `<b>${inner()}</b>`; break;
        case 'italic': out += `<i>${inner()}</i>`; break;
        case 'underline': out += `<u>${inner()}</u>`; break;
        case 'strike': out += `<s>${inner()}</s>`; break;
        case 'code': out += `<code>${esc(n.textContent)}</code>`; break;
        case 'math': out += `<code class="math">${esc(n.textContent)}</code>`; break;
        case 'pre': case 'snippet':
          out += `<pre data-lang="${esc(a('language'))}"><code>${esc(n.textContent.replace(/\n$/, ''))}</code></pre>`; break;
        case 'link': out += link(a('href'), n.textContent || a('href'), 'lnk'); break;
        case 'mention': out += `<span class="mention">@${esc(n.textContent)}</span>`; break;
        case 'break': out += '<br>'; break;
        case 'image': out += `<div class="att">${link(a('src'), '🖼 图片', 'attlink')}</div>`; break;
        case 'file': out += `<div class="att">${link(a('url'), '📎 ' + (a('filename') || '附件'), 'attlink')}</div>`; break;
        case 'video': out += `<div class="att">${link(a('src'), '▶ 视频', 'attlink')}</div>`; break;
        case 'list': {
          const t = a('style') === 'number' ? 'ol' : 'ul';
          out += `<${t}>${inner()}</${t}>`; break;
        }
        case 'list-item': out += `<li>${inner()}</li>`; break;
        case 'blockquote': case 'callout': out += `<blockquote>${inner()}</blockquote>`; break;
        case 'table': out += `<div class="tbl"><table>${inner()}</table></div>`; break;
        case 'table-row': out += `<tr>${inner()}</tr>`; break;
        case 'table-cell': case 'table-header': out += `<td>${inner()}</td>`; break;
        default: out += inner();
      }
    }
    return out;
  };
  return walk(root);
}

/* 正文里的附件、图片、视频清单：给卡片上的 📎 计数用 */
function docAttachments(doc) {
  const s = String(doc || '');
  if (!s.trim().startsWith('<document')) return [];
  const out = [];
  for (const m of s.matchAll(/<(file|image|video)\b([^>]*)\/?>/g)) {
    const attrs = Object.fromEntries([...m[2].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], unescapeXml(x[2])]));
    const url = attrs.url || attrs.src;
    if (url) out.push({ kind: m[1], name: attrs.filename || url.split('/').pop(), url });
  }
  return out;
}

function usersIndex(arr) {
  const m = {};
  for (const u of arr || []) if (u && u.id != null) m[String(u.id)] = u;
  return m;
}

const ROLE = { admin: '教师', staff: '助教', mentor: '导师' };

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

/* 把 answers/comments 的嵌套结构拍平。被删的回复本身不要，但它下面别人的回复还在 Ed 上显示，照样收进来。 */
function flattenReplies(thread, users) {
  const out = [];
  const walk = (items, kind, depth, parent) => {
    for (const it of items || []) {
      if (it.deleted_at) {
        walk(it.comments, 'reply', depth + 1, it.id);
        walk(it.replies, 'reply', depth + 1, it.id);
        continue;
      }
      const xml = it.content || it.document || '';
      out.push({
        id: it.id, parent_id: parent, kind, depth,
        author: authorOf(it, users),
        staff: isStaff(it, users),
        endorsed: !!it.is_endorsed,
        votes: it.vote_count || 0,
        created_at: it.created_at,
        text: docToText(xml),
        xml: String(xml).trim().startsWith('<document') ? xml : '',
      });
      walk(it.comments, 'reply', depth + 1, it.id);
      walk(it.replies, 'reply', depth + 1, it.id);
    }
  };
  walk(thread.answers, 'answer', 0, null);
  walk(thread.comments, 'comment', 0, null);
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
  const clean = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/\[(图片|附件|视频):[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const parts = clean.split(/(?<=[.。!?！？])\s+/).filter(Boolean);
  let s = parts.slice(0, n).join(' ');
  if (s.length > cap) s = s.slice(0, cap) + '…';
  return s;
}

/* 一句话结论：帖子的价值几乎总在“老师最后怎么说的”，所以取最后一条教职工回复；
 * 没有就取第一条像样的同学回答；再没有就用提问本身。 */
function gistOf(t) {
  const staffReply = [...t.replies].reverse().find((r) => r.staff && (r.text || '').trim().length > 8);
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

/* ---------------------------------------------------------------- 抓取：帖子 */

async function fetchThreadList(cid, token) {
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
    if (off > 10000) break;     // 保险丝
  }
  return { list, users };
}

/* 列表项里“跟我有关”的状态：收藏、关注、看过没有、几条没看过的回复。这些变了 updated_at 不会变，
 * 所以不进指纹，每次刷新都按列表整批覆盖。 */
function listState(th, me) {
  return {
    number: th.number, type: th.type, title: th.title || '(无标题)',
    category: th.category || '未分类', subcategory: th.subcategory || '',
    pinned: !!th.is_pinned, private: !!th.is_private, locked: !!th.is_locked,
    staff_answered: !!th.is_staff_answered, student_answered: !!th.is_student_answered,
    starred: !!th.is_starred, watched: !!th.is_watched, seen: th.is_seen !== false,
    unread: th.new_reply_count || 0, accepted_id: th.accepted_id || null,
    mine: !!me && th.user_id === me, reply_count: th.reply_count || 0, votes: th.vote_count || 0,
    stamp: contentStamp(th),
  };
}

/* 增量抓一门课的帖子：先拉列表，只对指纹变了或新出现的帖子抓正文和回复，其余沿用上次的。
 * 跟 ed-digest 的 sync 同一个思路：平时刷新一次只有几十个请求。 */
async function fetchCourse(cid, token, prev, onTick) {
  const { list, users } = await fetchThreadList(cid, token);
  const me = STATE.user && STATE.user.id;
  const prevById = {};
  for (const t of (prev && prev.threads) || []) prevById[t.id] = t;
  const now = STATE.syncingAt || new Date().toISOString();
  const out = [], todo = [];
  for (const th of list) {
    const old = prevById[th.id], st = listState(th, me);
    if (old && old.stamp === st.stamp && old.xml !== undefined) {
      out.push({ ...old, ...st, author: authorOf(th, users) });
    } else todo.push([th, old]);
  }
  onTick(0, todo.length, list.length);

  let idx = 0, done = 0, failed = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (idx < todo.length) {
      const [th, old] = todo[idx++];
      try {
        // 别带 ?view=1：它会把帖子算作"你看过了"并把 updated_at 顶成现在，
        // 抓一次就等于把所有帖子在 Ed 里标成已读。不带它返回的正文、回复、users 完全一样。
        const full = await edGet(`/threads/${th.id}`, token);
        const tu = Object.assign({}, users, usersIndex(full.users));
        const f = full.thread || th;
        const xml = f.content || f.document || '';
        const oldReplies = {};
        for (const r of (old && old.replies) || []) oldReplies[r.id] = r;
        const replies = flattenReplies(f, tu).map((r) => ({
          ...r, first_seen: oldReplies[r.id] ? oldReplies[r.id].first_seen || old.first_seen : now }));
        out.push({
          id: th.id, ...listState(th, me),
          author: authorOf(th, tu),
          created_at: th.created_at,
          url: `https://edstem.org/au/courses/${cid}/discussion/${th.id}`,
          body: docToText(xml),
          xml: String(xml).trim().startsWith('<document') ? xml : '',
          attachments: docAttachments(xml),
          replies,
          first_seen: old ? old.first_seen || now : now,
          fetched_at: now,
        });
      } catch (e) {
        if (e.auth || e.network) throw e;
        console.warn('抓取失败', th.id, e);
        failed++;
        if (old) out.push({ ...old, ...listState(th, me), stamp: old.stamp });   // 下次再试
      }
      onTick(++done, todo.length, list.length);
    }
  }));
  STATE.failed += failed;
  out.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return out;
}

/* ------------------------------------------------------- 抓取：课程内容（Lessons） */

/* 列表接口不带页面内容，slide 的 file_url / webpage 的 url / 文字页的正文都要进详情接口才有 */
async function fetchLessonDetail(l, token) {
  const d = await edGet(`/lessons/${l.id}`, token);
  const slides = ((d.lesson || {}).slides || []).filter((s) => !s.is_hidden);
  l.files = slides
    .filter((s) => (s.type === 'pdf' && s.file_url) || (s.type === 'webpage' && s.url))
    .map((s) => ({ id: s.id, type: s.type, title: s.title || '', file_url: s.file_url || null, url: s.url || null }));
  // Ed 自己的文字页（阅读材料）内容就在详情里，不用再请求，存下来能读也能搜
  l.readings = slides.filter((s) => s.type === 'document' && docToText(s.content))
    .map((s) => ({ id: s.id, title: s.title || '', xml: s.content, text: docToText(s.content) }));
  // 测验题：Ed 不给学生看答案，只有题面，拿来当复习清单
  l.quizzes = [];
  for (const s of slides.filter((s) => s.type === 'quiz')) {
    try {
      const q = await edGet(`/lessons/slides/${s.id}/questions`, token);
      l.quizzes.push({ id: s.id, title: s.title || '', questions: (q.questions || []).map((x) => {
        const d = x.data || {};
        return { question: docToText(d.content), multiple: !!d.multiple_selection,
                 options: (d.answers || []).map(docToText) };
      }) });
    } catch (e) {
      if (e.auth || e.network) throw e;
      console.warn('测验题抓取失败', s.id, e);
    }
  }
}

async function fetchLessons(cid, token) {
  const d = await edGet(`/courses/${cid}/lessons`, token);
  const modules = (d.modules || []).slice().sort((a, b) => a.id - b.id);
  const lessons = (d.lessons || [])
    .filter((l) => !l.is_hidden)
    .sort((a, b) => (a.index ?? -1) - (b.index ?? -1));

  let idx = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (idx < lessons.length) {
      const l = lessons[idx++];
      try {
        await fetchLessonDetail(l, token);
      } catch (e) {
        if (e.auth || e.network) throw e;
        console.warn('lesson 详情抓取失败', l.id, e);
        l.files = []; l.readings = []; l.quizzes = [];
      }
    }
  }));
  return { modules, lessons };
}

/* ------------------------------------------------------------ 一键下载资料 */

/* 在浏览器里把一门课的 PDF 拉下来打成 zip，解压后是
 *   FIT2109/Week 1 - Introduction to the Shell/16 workshop 1 slides.pdf
 * 外部链接生成一个 .html 快捷方式，双击用浏览器打开。命名规则跟 ed-digest 的课程资料页一致。
 * Ed 的文件域名返回 Access-Control-Allow-Origin: *，所以不需要任何代理。 */

const cleanName = (name) => {
  const s = String(name || '').replace(/: /g, ' - ').replace(/[\\/:]/g, '-')
    .replace(/[*?"<>|]+/g, '').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '');
  return s || '资料';
};

/* 返回 [{ path, url } | { path, text }]，顺序就是"课程内容"页的顺序 */
function courseZipEntries(course) {
  const root = cleanName((course.code || '').split(' ')[0] || String(course.id));
  const modName = {};
  for (const m of course.modules || []) modName[m.id] = m.name;
  const groups = {}, order = [];
  for (const m of course.modules || []) { groups[m.id] = []; order.push(m.id); }
  for (const l of course.lessons || []) {
    const k = l.module_id != null && l.module_id in groups ? l.module_id : 'none';
    if (!groups[k]) { groups[k] = []; order.push(k); }
    groups[k].push(l);
  }
  const out = [];
  for (const k of order) {
    const week = cleanName(k === 'none' ? '未分类' : modName[k]);
    let n = 0;
    for (const l of groups[k]) {
      for (const f of l.files || []) {
        const stem = `${String(++n).padStart(2, '0')} ${cleanName(f.title || l.title)}`.slice(0, 150);
        if (f.type === 'pdf' && f.file_url) out.push({ path: `${root}/${week}/${stem}.pdf`, url: f.file_url });
        else if (f.type === 'webpage' && f.url) {
          const t = esc(f.title || f.url), u = esc(f.url);
          out.push({ path: `${root}/${week}/${stem}.html`,
                     text: `<!doctype html><meta charset="utf-8"><title>${t}</title>` +
                           `<meta http-equiv="refresh" content="0; url=${u}"><p><a href="${u}">${t}</a></p>\n` });
        } else n--;
      }
    }
  }
  return out;
}

/* 最小的 zip 写入器：只存不压（PDF 本来就压过），文件名按 UTF-8 标记，单个文件 < 4GB */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path), data = f.data, crc = crc32(data);
    const head = (sig, extra) => {
      const b = new DataView(new ArrayBuffer(extra ? 46 : 30));
      let o = 0;
      const u16 = (v) => { b.setUint16(o, v, true); o += 2; };
      const u32 = (v) => { b.setUint32(o, v, true); o += 4; };
      u32(sig);
      // version made by：高字节 3 = Unix。写 0（MS-DOS）的话，老版 unzip 会无视 UTF-8 标记，
      // 按 DOS 代码页读文件名，中文目录名（"未分类"）就解不出来
      if (extra) u16((3 << 8) | 20);
      u16(20); u16(0x0800); u16(0);         // version needed, UTF-8 名字, 不压缩
      u16(time); u16(date); u32(crc); u32(data.length); u32(data.length);
      u16(name.length); u16(0);
      if (extra) { u16(0); u16(0); u16(0); u32((0o100644 << 16) >>> 0); u32(offset); }  // 外部属性：普通文件 rw-r--r--
      return new Uint8Array(b.buffer);
    };
    const local = head(0x04034b50, false);
    parts.push(local, name, data);
    central.push(head(0x02014b50, true), name);
    offset += local.length + name.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function downloadCourseZip() {
  const course = activeCourse();
  const btn = $('dlzip'), msg = $('dlmsg');
  const entries = course ? courseZipEntries(course) : [];
  const pdfs = entries.filter((e) => e.url);
  if (!pdfs.length) {
    notice('这门课没有可下载的资料（没开 Lessons，或者是更新前抓的数据，刷新一次就有）。');
    return;
  }
  btn.disabled = true;
  const enc = new TextEncoder(), failed = [];
  let idx = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (idx < pdfs.length) {
      const e = pdfs[idx++];
      try {
        const r = await fetch(e.url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        e.data = new Uint8Array(await r.arrayBuffer());
      } catch (err) {
        failed.push(`${e.path}\n  ${e.url}\n  ${err.message}`);
      }
      msg.textContent = `正在下载 PDF：${++done}/${pdfs.length}`;
    }
  }));
  const files = entries
    .map((e) => (e.text != null ? { path: e.path, data: enc.encode(e.text) } : e.data && { path: e.path, data: e.data }))
    .filter(Boolean);
  const root = entries[0].path.split('/')[0];
  if (failed.length) {
    files.push({ path: `${root}/下载失败的文件.txt`,
                 data: enc.encode('这些文件没能下载，可以在 Ed 里手动打开：\n\n' + failed.join('\n\n') + '\n') });
  }
  saveBlob(makeZip(files), `${root} 课程资料.zip`);
  notice(failed.length
    ? `已打包 ${pdfs.length - failed.length} 个 PDF，${failed.length} 个下载失败（清单在 zip 里）`
    : `已打包 ${pdfs.length} 个 PDF 和 ${entries.length - pdfs.length} 个链接`);
  btn.disabled = false;
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

function dumpPayload() {
  return { version: DUMP_VERSION, saved_at: new Date().toISOString(), synced_at: STATE.syncedAt,
           prev_synced_at: STATE.prevSyncedAt, user: STATE.user, data: STATE.data };
}

/* ---------------------------------------------------------------- 渲染：公共 */

const pad2 = (n) => String(n).padStart(2, '0');
const fmt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtFull = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const activeCourse = () => STATE.data.find((c) => c.id === STATE.active);

function notice(text, kind) {
  const el = $('dlmsg');
  el.textContent = text || '';
  el.className = 'notice' + (kind ? ' ' + kind : '') + (text ? '' : ' hide');
}

/* “新”的定义：刷新过，就是“这次刷新才第一次见到的”（first_seen 不早于这次抓取的开始时刻）；
 * 第一次抓没有基准，退回“48 小时内发的”，跟 ed-digest 的站点一个思路。 */
function isFresh(firstSeen) {
  return !!STATE.prevSyncedAt && !!firstSeen && firstSeen >= STATE.syncedAt;
}

function decorate(t) {
  const created = t.created_at ? new Date(t.created_at).getTime() : 0;
  t._new = STATE.prevSyncedAt ? isFresh(t.first_seen) : created > Date.now() - 48 * 3600 * 1000;
  t._newReplies = t._new ? 0 : t.replies.filter((r) => isFresh(r.first_seen)).length;
  t._unanswered = t.type === 'question' && !t.staff_answered && !t.student_answered;
  t._tags = tagsFor(t.title + '\n' + t.body);
  t._gist = gistOf(t);
  t._hay = (t.title + ' ' + t.body + ' ' + t.replies.map((r) => r.text).join(' ')).toLowerCase().slice(0, 6000);
  return t;
}

/* ---------------------------------------------------------------- 渲染：帖子 */

function replyHTML(r, t) {
  const isNew = isFresh(r.first_seen);
  const cls = ['reply', r.staff && 'staff', isNew && 'fresh'].filter(Boolean).join(' ');
  const marks = [];
  if (t.accepted_id && r.id === t.accepted_id) marks.push('<span class="mark ok">✔ 已采纳</span>');
  if (r.endorsed) marks.push('<span class="mark ok">已认可</span>');
  if (isNew) marks.push('<span class="mark new">新</span>');
  return `<div class="${cls}" style="margin-left:${Math.min(r.depth, 3) * 18}px">
    <div class="rmeta"><b>${esc(r.author)}</b> · ${r.kind === 'answer' ? '回答' : '评论'} · ${fmt(r.created_at)}${
      r.votes ? ' · ▲' + r.votes : ''} ${marks.join(' ')}</div>
    <div class="rich">${r.xml ? docToHTML(r.xml) : esc(r.text)}</div></div>`;
}

function cardHTML(t) {
  const chips = [];
  if (t._new) chips.push('<span class="chip new">新</span>');
  else if (t._newReplies) chips.push(`<span class="chip new">+${t._newReplies} 新回复</span>`);
  if (t.unread) chips.push(`<span class="chip unread" title="Ed 记的：你还没看过的回复">${t.unread} 未读</span>`);
  if (t.private) chips.push('<span class="chip priv">私密</span>');
  if (t.pinned) chips.push('<span class="chip">置顶</span>');
  if (t.mine) chips.push('<span class="chip me">我发的</span>');
  if (t.starred) chips.push('<span class="chip star">★ 收藏</span>');
  else if (t.watched) chips.push('<span class="chip">关注中</span>');
  if (t.staff_answered) chips.push('<span class="chip ok">老师已答</span>');
  else if (t._unanswered) chips.push('<span class="chip q">待解答</span>');
  for (const tag of t._tags) chips.push(`<span class="chip warn">${esc(tag)}</span>`);
  if (t.attachments && t.attachments.length) chips.push(`<span class="chip">📎 ${t.attachments.length}</span>`);

  const flags = [(t._new || t._newReplies) && 'new', t._unanswered && 'unanswered',
                 t._tags.length && 'alert', t.staff_answered && 'staff', t.mine && 'mine',
                 (t.unread || t._newReplies) && 'unread', t.starred && 'starred',
                 t.type === 'announcement' && 'announcement'].filter(Boolean).join(' ');

  const gist = t._gist.label
    ? `<b>${esc(t._gist.label)}：</b>${esc(t._gist.text)}`
    : esc(t._gist.text);

  const replies = t.replies.map((r) => replyHTML(r, t)).join('');
  const kind = { question: '提问', announcement: '公告', post: '帖子' }[t.type] || t.type;

  return `<details class="t" data-flags="${flags}" data-text="${esc(t._hay)}">
    <summary>
      <div class="trow"><span class="title">${esc(t.title)}</span>${chips.join('')}</div>
      <div class="gist">${gist}</div>
      <div class="meta">${esc(t.author)} · ${kind} · ${fmt(t.created_at)} · ${t.reply_count} 回复 ·
        <a href="${esc(t.url)}" target="_blank" rel="noopener">在 Ed 打开 ↗</a></div>
    </summary>
    <div class="tbody">
      <div class="rich body">${t.xml ? docToHTML(t.xml) : esc(t.body || '（无正文）')}</div>
      ${replies ? `<div class="replies">${replies}</div>` : '<div class="noreply">还没有回复</div>'}
    </div></details>`;
}

function renderList() {
  const course = activeCourse();
  if (!course) return;
  const byCat = {};
  const sorted = [...course.threads].sort((a, b) =>
    (b.pinned - a.pinned) || (b.created_at || '').localeCompare(a.created_at || ''));
  for (const t of sorted) {
    const k = t.category + (t.subcategory ? ' / ' + t.subcategory : '');
    (byCat[k] ||= []).push(t);
  }
  const cats = Object.entries(byCat).sort((a, b) => b[1].length - a[1].length);
  $('list').innerHTML = cats.length
    ? cats.map(([cat, items]) =>
        `<section class="group"><h3 class="cat">${esc(cat)}<span class="n">${items.length}</span></h3>` +
        items.map(cardHTML).join('') + '</section>').join('')
    : '<div class="empty">这门课还没有帖子</div>';
  applyFilters();
}

/* -------------------------------------------------------- 渲染：课程内容 */

const LSTATUS_LABEL = { completed: '已完成', attempted: '进行中', unattempted: '未开始' };

/* Ed 没直接给"临近截止"这种结论，这里只根据 due_at 算，跟帖子那边的规则式标签是一个思路 */
function decorateLesson(l) {
  const dueRaw = l.effective_due_at || l.due_at;
  const due = dueRaw ? new Date(dueRaw) : null;
  l._due = due && !isNaN(due) ? due : null;
  l._overdue = !!l._due && l._due.getTime() < Date.now() && l.status !== 'completed';
  l._dueSoon = !!l._due && !l._overdue && (l._due.getTime() - Date.now()) < 7 * 24 * 3600 * 1000;
  l._hay = [l.title, ...(l.readings || []).map((r) => r.title + ' ' + r.text),
            ...(l.files || []).map((f) => f.title),
            ...(l.quizzes || []).flatMap((q) => [q.title, ...q.questions.map((x) => x.question)])]
    .join(' ').toLowerCase().slice(0, 6000);
  return l;
}

const FTYPE_LABEL = { pdf: 'PDF', webpage: '链接' };

function fileRowHTML(s) {
  const href = s.type === 'pdf' ? s.file_url : s.url;
  return `<div class="lfile"><span class="ftype">${esc(FTYPE_LABEL[s.type] || s.type)}</span>
    <a href="${esc(href)}" target="_blank" rel="noopener">${esc(s.title || href)}</a></div>`;
}

function readingHTML(r) {
  return `<details class="reading"><summary>📖 ${esc(r.title || '阅读材料')}</summary>
    <div class="rich">${docToHTML(r.xml)}</div></details>`;
}

function quizHTML(q) {
  if (!q.questions.length) return '';
  return `<details class="reading"><summary>✎ ${esc(q.title || '测验')} · ${q.questions.length} 题（Ed 不给学生看答案）</summary>
    <ol class="quiz">${q.questions.map((x) => `<li><div>${esc(x.question)}${x.multiple ? ' <span class="chip">多选</span>' : ''}</div>${
      x.options.length ? `<ul>${x.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ol></details>`;
}

function lessonCardHTML(l) {
  const files = l.files || [], readings = l.readings || [], quizzes = (l.quizzes || []).filter((q) => q.questions.length);
  const flags = [l.status, l._overdue && 'overdue', l._dueSoon && 'duesoon',
                 files.length && 'hasfiles'].filter(Boolean).join(' ');
  const chips = [];
  if (l._overdue) chips.push('<span class="chip warn">已截止</span>');
  else if (l._dueSoon) chips.push('<span class="chip warn">临近截止</span>');
  if (l.is_timed) chips.push(`<span class="chip">限时 ${l.timer_duration} 分</span>`);
  if (files.length) chips.push(`<span class="chip">📎 ${files.length}</span>`);
  if (readings.length) chips.push(`<span class="chip">📖 ${readings.length}</span>`);
  if (quizzes.length) chips.push(`<span class="chip">✎ 测验</span>`);
  const due = l._due ? ' · 截止 ' + fmt(l._due.toISOString()) : '';
  const extra = files.length + readings.length + quizzes.length;

  const row = `<span class="lstatus ${l.status}" title="${esc(LSTATUS_LABEL[l.status] || l.status)}"></span>
    <a class="ltitle" href="https://edstem.org/au/courses/${l.course_id}/lessons/${l.id}"
       target="_blank" rel="noopener">${esc(l.title || '(无标题)')}</a>
    ${chips.join('')}
    <span class="meta">${esc(LSTATUS_LABEL[l.status] || '')} · ${l.slide_count ?? 0} 页${due}</span>`;

  if (!extra) {
    return `<div class="lesson" data-flags="${flags}" data-text="${esc(l._hay)}">${row}</div>`;
  }
  return `<details class="lesson" data-flags="${flags}" data-text="${esc(l._hay)}">
    <summary>${row}</summary>
    <div class="lfiles">${files.map(fileRowHTML).join('')}${readings.map(readingHTML).join('')}${quizzes.map(quizHTML).join('')}</div>
  </details>`;
}

function renderLessons() {
  const course = activeCourse();
  if (!course) return;
  const byMod = {};
  for (const l of course.lessons || []) (byMod[l.module_id ?? 'none'] ||= []).push(l);
  // 不属于任何模块（或模块被隐藏）的内容放到最后的"未分类"，不然只算进总数、页面上却找不到
  const known = new Set((course.modules || []).map((m) => String(m.id)));
  const orphans = Object.keys(byMod).filter((k) => !known.has(k)).flatMap((k) => byMod[k]);
  const mods = (course.modules || []).filter((m) => byMod[m.id] && byMod[m.id].length)
    .map((m) => ({ name: m.name, items: byMod[m.id] }));
  if (orphans.length) mods.push({ name: '未分类', items: orphans });

  $('list').innerHTML = mods.length
    ? mods.map((m) => {
        const done = m.items.filter((l) => l.status === 'completed').length;
        const pct = Math.round(done / m.items.length * 100);
        return `<section class="group"><h3 class="cat">${esc(m.name)}<span class="n">${done}/${m.items.length}</span>
          <span class="bar-mini" title="已完成 ${pct}%"><i style="width:${pct}%"></i></span></h3>` +
          m.items.map(lessonCardHTML).join('') + '</section>';
      }).join('')
    : '<div class="empty">这门课没有课程内容，或者这门课没开 Lessons 功能</div>';
  applyFilters();
}

function renderContent() {
  if (STATE.view === 'lessons') renderLessons(); else renderList();
  renderStats();
}

/* ------------------------------------------------------- 侧栏、统计、状态 */

function courseStats(c) {
  const th = c.threads || [], ls = c.lessons || [];
  return {
    threads: th.length,
    fresh: th.filter((t) => t._new || t._newReplies).length,
    unanswered: th.filter((t) => t._unanswered).length,
    unread: th.filter((t) => t.unread).length,
    lessons: ls.length,
    done: ls.filter((l) => l.status === 'completed').length,
    overdue: ls.filter((l) => l._overdue).length,
    dueSoon: ls.filter((l) => l._dueSoon).length,
  };
}

function renderTabs() {
  $('tabs').innerHTML = STATE.data.map((c) => {
    const s = courseStats(c);
    const badge = s.fresh ? `<span class="badge" title="新内容">${s.fresh}</span>` : '';
    return `<button data-cid="${c.id}" class="${c.id === STATE.active ? 'on' : ''}">
      <span class="code">${esc((c.code || '').split(' ')[0])}</span>
      <span class="nm">${esc(c.name || '')}</span>${badge}</button>`;
  }).join('');
  for (const b of $('tabs').children) {
    b.onclick = () => {
      STATE.active = Number(b.dataset.cid);
      notice('');
      renderTabs(); renderContent();
    };
  }
}

function renderStats() {
  const c = activeCourse();
  if (!c) return;
  const s = courseStats(c);
  const tile = (n, label, filter, view) =>
    `<button class="tile${n ? '' : ' zero'}" data-tile="${filter}" data-view="${view}"><b>${n}</b><span>${label}</span></button>`;
  $('stats').innerHTML = STATE.view === 'threads'
    ? tile(s.fresh, STATE.prevSyncedAt ? '上次刷新后新增' : '近 48 小时', 'new', 'threads') +
      tile(s.unanswered, '待解答', 'unanswered', 'threads') +
      tile(s.unread, 'Ed 未读回复', 'unread', 'threads') +
      tile(s.lessons - s.done, '课程内容未完成', 'unattempted', 'lessons')
    : tile(s.done, `已完成 / ${s.lessons}`, 'completed', 'lessons') +
      tile(s.dueSoon, '7 天内截止', 'duesoon', 'lessons') +
      tile(s.overdue, '已截止未完成', 'overdue', 'lessons') +
      tile(s.unanswered, '帖子待解答', 'unanswered', 'threads');
  for (const b of $('stats').querySelectorAll('.tile')) {
    b.onclick = () => {
      const want = b.dataset.view, k = b.dataset.tile;
      if (want !== STATE.view) switchView(want);
      const set = want === 'threads' ? STATE.filters : STATE.lessonFilters;
      set.clear();
      if (k !== 'completed') set.add(k);
      syncFilterButtons();
      applyFilters();
    };
  }
  $('crumb').innerHTML = `<b>${esc((c.code || '').split(' ')[0])}</b> <span>${esc(c.name || '')}</span>`;
}

function renderStatus() {
  const bits = [];
  if (STATE.user && STATE.user.name) bits.push(esc(STATE.user.name));
  if (STATE.syncedAt) bits.push('抓取于 ' + fmt(STATE.syncedAt));
  const tok = sessionStorage.getItem(TOK_KEY);
  if (tok) {
    const exp = tokenExpiry(tok);
    if (!exp) bits.push(tokenKind(tok) === 'api' ? 'API 令牌' : 'token');
    else {
      const days = Math.floor((exp.getTime() - Date.now()) / 86400000);
      bits.push(days < 0 ? '<span class="bad">token 已过期</span>'
        : days <= 3 ? `<span class="bad">token 还剩 ${days} 天</span>` : `token 还剩 ${days} 天`);
    }
  } else if (STATE.data.length) bits.push('token 未保存，刷新要重新填');
  $('status').innerHTML = bits.join(' · ');
}

function syncFilterButtons() {
  document.querySelectorAll('.chipbtn[data-f]').forEach((b) => b.classList.toggle('on', STATE.filters.has(b.dataset.f)));
  document.querySelectorAll('.chipbtn[data-lf]').forEach((b) => b.classList.toggle('on', STATE.lessonFilters.has(b.dataset.lf)));
}

function switchView(v) {
  STATE.view = v;
  for (const b of $('viewseg').children) b.classList.toggle('on', b.dataset.v === v);
  $('filters-threads').classList.toggle('hide', v !== 'threads');
  $('filters-lessons').classList.toggle('hide', v !== 'lessons');
  $('q').placeholder = v === 'threads' ? '搜标题、正文、回复，多个词都要出现' : '搜课程内容、阅读材料、测验题';
  notice('');
  renderContent();
}

function applyFilters() {
  const q = $('q').value.trim();
  const sel = STATE.view === 'threads' ? 'details.t' : '.lesson';
  const want = STATE.view === 'threads' ? STATE.filters : STATE.lessonFilters;
  let shown = 0;
  for (const c of document.querySelectorAll(sel)) {
    const f = c.dataset.flags.split(' ');
    const okText = !q || matchWords(c.dataset.text, q);
    const okFlag = [...want].every((x) => f.includes(x));
    const ok = okText && okFlag;
    c.classList.toggle('hidden', !ok);
    if (ok) shown++;
  }
  for (const g of document.querySelectorAll('section.group')) {
    g.classList.toggle('hidden', !g.querySelector(`${sel}:not(.hidden)`));
  }
  $('count').textContent = (q || want.size) ? `${shown} 条匹配` : '';
}

/* ------------------------------------------------------------------ 流程 */

function show(step) {
  for (const id of ['p-auth', 'p-pick', 'p-view']) $(id).classList.toggle('hide', id !== step);
  document.body.dataset.step = step;
  if (step !== 'p-view') $('tabs').innerHTML = '';
}

function renderCourses(courses) {
  const box = (c) => `
    <label class="cbox">
      <input type="checkbox" value="${c.id}" ${c.status === 'active' ? 'checked' : ''}>
      <span><span class="code">${esc((c.code || '').split(' ')[0])}</span>
        <span class="term">${esc((c.code || '').split(' ').slice(1).join(' '))}</span><br>
        <span class="nm">${esc(c.name || '')}</span></span>
    </label>`;
  const active = courses.filter((c) => c.status === 'active'), rest = courses.filter((c) => c.status !== 'active');
  $('courses').innerHTML = active.map(box).join('') +
    (rest.length ? `<details class="archived"><summary>已归档的 ${rest.length} 门</summary><div class="courses">${rest.map(box).join('')}</div></details>` : '');
}

function tokenHint() {
  const token = $('tok').value.trim();
  const el = $('tokhint');
  if (!token) { el.textContent = ''; return; }
  if (!tokenLooksValid(token)) { el.textContent = '这看起来不像 token：应该是一长串字母数字，中间没有空格。'; return; }
  if (tokenKind(token) === 'api') { el.textContent = '识别为 API 令牌：不会过期，在 Ed 的设置页可以随时吊销。'; return; }
  const exp = tokenExpiry(token);
  const days = exp ? Math.floor((exp.getTime() - Date.now()) / 86400000) : null;
  el.textContent = '识别为浏览器 token' + (days == null ? '' : days < 0 ? '，已经过期了，去 Ed 重新取一张' : `，${days} 天后到期`) + '。';
}

async function connect() {
  const token = $('tok').value.trim();
  $('autherr').textContent = '';
  if (!tokenLooksValid(token)) {
    $('autherr').textContent = '这看起来不像 Ed 的 token，应该是一长串字母数字。';
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
    renderStatus();
    show('p-pick');
  } catch (e) {
    $('autherr').textContent = e.message;
  } finally {
    $('go').disabled = false;
  }
}

/* 抓取。mode = 'full' 全部重抓；'incremental' 只抓有变化的帖子（课程内容量小，每次都重抓）。 */
async function crawl(picked, mode) {
  const token = sessionStorage.getItem(TOK_KEY);
  if (!token) { show('p-auth'); $('autherr').textContent = 'token 没有保存在这个标签页里，重新填一次。'; return; }
  const prevData = mode === 'incremental' ? STATE.data : [];
  const btns = [$('crawl'), $('refresh')];
  btns.forEach((b) => { b.disabled = true; });
  $('prog').classList.remove('hidden');
  $('progbox').classList.remove('hide');
  STATE.failed = 0;

  const data = [];
  const startedAt = new Date().toISOString();
  STATE.syncingAt = startedAt;
  try {
    for (let i = 0; i < picked.length; i++) {
      const c = STATE.courses.find((x) => x.id === picked[i]) || prevData.find((x) => x.id === picked[i]);
      const prev = prevData.find((x) => x.id === picked[i]);
      const label = (c.code || '').split(' ')[0];
      const threads = await fetchCourse(picked[i], token, prev, (done, total, all) => {
        $('progtext').textContent = total
          ? `[${i + 1}/${picked.length}] ${label} · ${done}/${total} 个帖子有更新，共 ${all} 帖`
          : `[${i + 1}/${picked.length}] ${label} · ${all} 帖都没变`;
        $('prog').value = ((i + (total ? done / total : 1) * 0.8) / picked.length) * 100;
      });
      $('progtext').textContent = `[${i + 1}/${picked.length}] ${label} · 课程内容…`;
      let modules = [], lessons = [];
      try {
        ({ modules, lessons } = await fetchLessons(picked[i], token));
      } catch (e) {
        if (e.auth || e.network) throw e;
        console.warn('课程内容抓取失败（这门课可能没开 Lessons）', picked[i], e);
      }
      $('prog').value = ((i + 1) / picked.length) * 100;
      data.push({ id: c.id, code: c.code, name: c.name, status: c.status, threads, modules, lessons });
    }
  } catch (e) {
    $('crawlerr').textContent = e.auth
      ? 'token 在抓取途中失效了。回上一步换一张新的。'
      : '抓取出错：' + e.message;
    notice(e.auth ? 'token 失效了，换一张再刷新。' : '刷新出错：' + e.message, 'bad');
    btns.forEach((b) => { b.disabled = false; });
    $('prog').classList.add('hidden');
    $('progbox').classList.add('hide');
    return;
  }

  STATE.prevSyncedAt = mode === 'incremental' ? STATE.syncedAt : null;
  STATE.syncedAt = startedAt;
  for (const c of data) { c.threads.forEach(decorate); c.lessons.forEach(decorateLesson); }
  STATE.data = data;
  if (!data.some((c) => c.id === STATE.active)) STATE.active = data[0].id;
  await saveDump(dumpPayload());
  btns.forEach((b) => { b.disabled = false; });
  $('prog').classList.add('hidden');
  $('progbox').classList.add('hide');
  $('progtext').textContent = '';
  $('crawlerr').textContent = '';
  show('p-view');
  renderTabs();
  renderStatus();
  renderContent();
  const fresh = data.reduce((n, c) => n + courseStats(c).fresh, 0);
  const failed = STATE.failed ? `，${STATE.failed} 个帖子没抓下来（下次刷新会重试）` : '';
  notice(mode === 'incremental'
    ? (fresh ? `刷新完成，${fresh} 个帖子有新内容${failed}` : `刷新完成，没有新内容${failed}`)
    : `抓取完成${failed}`, STATE.failed ? 'bad' : 'ok');
}

function exportJSON() {
  const blob = new Blob([JSON.stringify(dumpPayload())], { type: 'application/json' });
  saveBlob(blob, 'ed-' + new Date().toISOString().slice(0, 10) + '.json');
}

function adoptDump(d) {
  if (!d || !Array.isArray(d.data) || !d.data.length) return false;
  STATE.syncedAt = d.synced_at || d.saved_at || null;
  STATE.prevSyncedAt = d.prev_synced_at || null;
  if (d.user) STATE.user = d.user;
  STATE.data = d.data.map((c) => ({
    ...c,
    threads: (c.threads || []).map((t) => decorate({ ...t, replies: t.replies || [], attachments: t.attachments || [] })),
    modules: c.modules || [],
    lessons: (c.lessons || []).map(decorateLesson),
  }));
  if (!STATE.data.some((c) => c.id === STATE.active)) STATE.active = STATE.data[0].id;
  show('p-view');
  renderTabs();
  renderStatus();
  renderContent();
  return true;
}

/* ------------------------------------------------------------------ 主题 */

function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { t ? localStorage.setItem(THEME_KEY, t) : localStorage.removeItem(THEME_KEY); } catch { /* 隐私模式 */ }
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(dark ? 'light' : 'dark');
}

/* ------------------------------------------------------------------ 绑定 */

$('go').onclick = connect;
$('tok').addEventListener('input', tokenHint);
$('tok').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) connect(); });
$('crawl').onclick = () => {
  const picked = [...document.querySelectorAll('#courses input:checked')].map((i) => Number(i.value));
  $('crawlerr').textContent = '';
  if (!picked.length) { $('crawlerr').textContent = '至少选一门课。'; return; }
  // 选的课跟上次一样就增量，不一样就全量；之前抓过的课沿用旧数据
  crawl(picked, STATE.data.length ? 'incremental' : 'full');
};
$('back').onclick = () => show('p-auth');
// 从本地记录/导入文件恢复的页面还没连过 Ed，选课列表是空的，得先回第一步（token 可能还在框里）
$('restart').onclick = () => show(STATE.courses.length ? 'p-pick' : 'p-auth');
$('refresh').onclick = () => {
  if (!STATE.courses.length) {
    // 这个标签页还没连过 Ed（从本地记录恢复的），先验一下 token 再增量刷新
    const token = sessionStorage.getItem(TOK_KEY);
    if (!token) { show('p-auth'); $('autherr').textContent = '先填一次 token，之后就能一键刷新了。'; return; }
    STATE.courses = STATE.data.map((c) => ({ id: c.id, code: c.code, name: c.name, status: c.status }));
  }
  crawl(STATE.data.map((c) => c.id), 'incremental');
};
$('export').onclick = exportJSON;
$('dlzip').onclick = downloadCourseZip;
$('theme').onclick = toggleTheme;
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

for (const b of $('viewseg').children) b.onclick = () => switchView(b.dataset.v);

$('q').addEventListener('input', applyFilters);
document.querySelectorAll('.chipbtn[data-f]').forEach((b) => {
  b.onclick = () => {
    const k = b.dataset.f;
    STATE.filters.has(k) ? STATE.filters.delete(k) : STATE.filters.add(k);
    b.classList.toggle('on');
    applyFilters();
  };
});
document.querySelectorAll('.chipbtn[data-lf]').forEach((b) => {
  b.onclick = () => {
    const k = b.dataset.lf;
    STATE.lessonFilters.has(k) ? STATE.lessonFilters.delete(k) : STATE.lessonFilters.add(k);
    b.classList.toggle('on');
    applyFilters();
  };
});
$('expand').onclick = (e) => {
  const sel = STATE.view === 'threads' ? 'details.t' : 'details.lesson';
  const vis = [...document.querySelectorAll(sel)].filter((c) => !c.classList.contains('hidden'));
  const open = vis.some((c) => !c.open);
  vis.forEach((c) => { c.open = open; });
  e.target.textContent = open ? '收起全部' : '展开全部';
};

/* 回到页面时，如果本地还留着上次的结果就直接显示 */
(async () => {
  try { const t = localStorage.getItem(THEME_KEY); if (t) applyTheme(t); } catch { /* 隐私模式 */ }
  const saved = sessionStorage.getItem(TOK_KEY);
  if (saved) { $('tok').value = saved; tokenHint(); }
  const d = await loadDump();
  if (d && adoptDump(d)) {
    $('progtext').textContent = '';
    console.info('已从本地读回上次抓取的结果', d.saved_at);
  }
})();
