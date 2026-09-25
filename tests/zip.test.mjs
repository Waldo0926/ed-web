// 一键下载的命名和 zip 格式。app.js 是直接给浏览器加载的普通脚本，没有 export，
// 这里把需要的几段源码切出来单独执行。不连网。
//   node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const src = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const grab = (start, end) => {
  const i = src.indexOf(start), j = src.indexOf(end, i);
  assert.ok(i >= 0 && j > i, `app.js 里找不到 ${start} … ${end}`);
  return src.slice(i, j);
};
const { cleanName, courseZipEntries, makeZip, crc32 } = new Function(
  grab('const esc =', 'let STATE') + grab('const cleanName', 'function saveBlob') +
  '; return { cleanName, courseZipEntries, makeZip, crc32 };')();

const L = (id, module_id, title, files) => ({ id, module_id, title, files });
const course = {
  id: 1, code: 'FIT2109 S2',
  modules: [{ id: 10, name: 'Week 1: Introduction to the Shell' }, { id: 11, name: 'Week 3: Editor/Modern IDE' }],
  lessons: [
    L(1, 10, 'A', [{ type: 'webpage', title: '1.2 - What Is a Shell?', url: 'https://example.com/?a=1&b=2' },
                   { type: 'pdf', title: 'workshop 1 slides', file_url: 'https://files.example/1' }]),
    L(2, 11, 'B', [{ type: 'webpage', title: 'no url' },
                   { type: 'pdf', title: 'Workshop 3 Slides', file_url: 'https://files.example/2' }]),
    L(3, null, 'Loose lesson', [{ type: 'pdf', title: '', file_url: 'https://files.example/3' }]),
    L(4, 999, 'Hidden module', [{ type: 'pdf', title: 'x', file_url: 'https://files.example/4' }]),
  ],
};

test('cleanName 去掉文件系统不认的字符', () => {
  assert.equal(cleanName('Week 1: Introduction to the Shell'), 'Week 1 - Introduction to the Shell');
  assert.equal(cleanName('Week 3: Editor/Modern IDE'), 'Week 3 - Editor-Modern IDE');
  assert.equal(cleanName('1.2 - What Is a Shell?'), '1.2 - What Is a Shell');
  assert.equal(cleanName(' ?. '), '资料');
});

test('按周分文件夹、按页面顺序编号，没模块的放未分类', () => {
  assert.deepEqual(courseZipEntries(course).map((e) => e.path), [
    'FIT2109/Week 1 - Introduction to the Shell/01 1.2 - What Is a Shell.html',
    'FIT2109/Week 1 - Introduction to the Shell/02 workshop 1 slides.pdf',
    'FIT2109/Week 3 - Editor-Modern IDE/01 Workshop 3 Slides.pdf',
    'FIT2109/未分类/01 Loose lesson.pdf',
    'FIT2109/未分类/02 x.pdf',
  ]);
});

test('链接快捷方式里的 URL 做了转义', () => {
  const link = courseZipEntries(course)[0];
  assert.match(link.text, /url=https:\/\/example\.com\/\?a=1&amp;b=2/);
});

test('crc32 是标准的 CRC-32', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('生成的 zip 能被系统 unzip 解开，中文名和内容都对', async () => {
  const enc = new TextEncoder();
  const files = [
    { path: 'FIT2109/Week 1 - Shell/01 slides.pdf', data: enc.encode('%PDF-1.4 fake') },
    { path: 'FIT2109/未分类/01 讲义.pdf', data: enc.encode('中文内容') },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-web-zip-'));
  try {
    const zip = path.join(dir, 't.zip');
    fs.writeFileSync(zip, Buffer.from(await makeZip(files).arrayBuffer()));
    execFileSync('unzip', ['-q', zip, '-d', path.join(dir, 'out')], { env: { ...process.env, LC_ALL: 'C.UTF-8' } });
    for (const f of files) {
      assert.deepEqual(fs.readFileSync(path.join(dir, 'out', f.path)), Buffer.from(f.data));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
