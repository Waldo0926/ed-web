// token 识别、变更指纹、搜索规则、Ed 正文转纯文本。app.js 是直接给浏览器加载的普通脚本，
// 这里把需要的几段源码切出来单独执行。不连网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const grab = (start, end) => {
  const i = src.indexOf(start), j = src.indexOf(end, i);
  assert.ok(i >= 0 && j > i, `app.js 里找不到 ${start} … ${end}`);
  return src.slice(i, j);
};
const fns = new Function('atob',
  grab('const esc =', 'let STATE') + grab('const ENTITY', 'const safeHref') +
  grab('const safeHref', '/* 富文本版') + grab('function docAttachments', 'function usersIndex') +
  '; return { tokenKind, authHeaders, tokenExpiry, tokenLooksValid, contentStamp, matchWords, docToText, docAttachments, safeHref };')(
  (s) => Buffer.from(s, 'base64').toString('binary'));

const JWT = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: 1800000000 })).toString('base64url') + '.sig';

test('两种 token 走不同的请求头', () => {
  assert.equal(fns.tokenKind(JWT), 'jwt');
  assert.deepEqual(fns.authHeaders(JWT), { 'x-token': JWT });
  assert.equal(fns.tokenKind('abcd1234.efgh5678'), 'api');
  assert.deepEqual(fns.authHeaders('abcd1234.efgh5678'), { authorization: 'Bearer abcd1234.efgh5678' });
});

test('JWT 能读出到期时间，API 令牌没有', () => {
  assert.equal(fns.tokenExpiry(JWT).toISOString(), '2027-01-15T08:00:00.000Z');
  assert.equal(fns.tokenExpiry('abcd1234.efgh5678'), null);
  assert.equal(fns.tokenExpiry('eyJ.not-json.sig'), null);
});

test('token 长相检查', () => {
  assert.ok(fns.tokenLooksValid(JWT));
  assert.ok(fns.tokenLooksValid('abcd1234efgh5678.ijkl9012mnop3456'));
  assert.ok(!fns.tokenLooksValid('hello world this is not a token'));
  assert.ok(!fns.tokenLooksValid('short'));
});

test('变更指纹：回复数或状态变了才变，点开看过不算', () => {
  const t = { updated_at: '2026-10-01T00:00:00Z', reply_count: 2, vote_count: 0, is_staff_answered: false, title: 'a' };
  const same = fns.contentStamp({ ...t, is_seen: true, new_reply_count: 0 });
  assert.equal(fns.contentStamp(t), same);
  assert.notEqual(fns.contentStamp({ ...t, reply_count: 3 }), same);
  assert.notEqual(fns.contentStamp({ ...t, is_staff_answered: true }), same);
});

test('搜索：每个词都要出现，不分大小写', () => {
  assert.ok(fns.matchWords('Parser combinator returns Nothing', 'parser nothing'));
  assert.ok(!fns.matchWords('Parser combinator returns Nothing', 'parser maybe'));
  assert.ok(fns.matchWords('anything', '   '));
});

test('Ed 正文转纯文本：链接、附件、图片的网址都留着，实体解码', () => {
  const xml = '<document version="2.0"><paragraph>See <link href="https://a.example/x">the spec</link> &amp; <bold>read</bold> it.</paragraph>' +
    '<file url="https://files.example/1" filename="A2-FAQ.pdf"/><image src="https://img.example/p.png"/>' +
    '<pre language="haskell">x &lt;- p</pre></document>';
  const text = fns.docToText(xml);
  assert.match(text, /the spec \(https:\/\/a\.example\/x\) & read it\./);
  assert.match(text, /\[附件: A2-FAQ\.pdf https:\/\/files\.example\/1\]/);
  assert.match(text, /\[图片: https:\/\/img\.example\/p\.png\]/);
  assert.match(text, /```\nx <- p\n```/);
  assert.equal(fns.docToText('  plain  '), 'plain');
  assert.deepEqual(fns.docAttachments(xml).map((a) => a.name), ['A2-FAQ.pdf', 'p.png']);
});

test('正文里的链接只认 http(s)', () => {
  assert.equal(fns.safeHref('javascript:alert(1)'), null);
  assert.equal(fns.safeHref(' https://edstem.org/x '), 'https://edstem.org/x');
});
