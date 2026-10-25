# Ed Web: Private, Client-Side Ed Discussion Reader

[![Live App](https://img.shields.io/badge/live-app-1e5eff?style=for-the-badge)](https://monashed.secureview.tech/app/)
[![Privacy](https://img.shields.io/badge/privacy-client--side%20only-2ea44f?style=for-the-badge)](#privacy-model)
[![Backend](https://img.shields.io/badge/backend-none-black?style=for-the-badge)](#public-showcase-vs-private-companion)
[![Check](https://img.shields.io/github/actions/workflow/status/Waldo0926/ed-web/check.yml?branch=main&style=for-the-badge&label=check)](https://github.com/Waldo0926/ed-web/actions/workflows/check.yml)

**English** · [中文](README.zh-CN.md)

A privacy-first, client-side web app for fetching, organising, searching, and summarising Ed Discussion course forums directly in your browser. The interface is in Chinese; the labels below are quoted as they appear on the page.

Live: https://monashed.secureview.tech/app/

## Privacy model

This page is **fully static**, with no application backend. Specifically:

- Your Ed token is stored only in your browser (`sessionStorage`, cleared when the tab is closed) and is sent only **directly to Ed's official `edstem.org` API** for authentication. It is never sent to `monashed.secureview.tech` or any third-party backend.
- Fetched posts are stored in your browser's **IndexedDB** and are not uploaded to this site. The only other thing kept locally is your light/dark preference (`localStorage`).
- The page calls `edstem.org/api/*` directly from your browser. Ed's API returns `Access-Control-Allow-Origin: *`, so no proxy is required.

This repository is public specifically so you can verify the data flow yourself: a full-text search for `fetch(` shows only Ed's API, Ed's course files (`static.edusercontent.com`, fetched without the token when you download materials) and relative application paths as destinations.

## How to use it

1. Open https://monashed.secureview.tech/app/
2. Paste your Ed token. Two ways to get one, both described on the page:
   - **Browser token**: run `copy(localStorage.authToken)` in the console of any Ed page. Expires in about 14 days; the page shows how many days are left.
   - **API token**: create one at edstem.org/au/settings/api-tokens. It never expires and you can revoke it there. Whether a browser is allowed to use it depends on Ed's cross-origin settings; if not, the page says so and you fall back to the browser token.
3. Select the units you want to fetch, then click 开始抓取 (Start fetching)
4. Browse by category, search (every word has to appear, replies included), and read a one-line takeaway for each post. Post bodies keep their formatting: links, bold, code blocks, images and attachments. Filters: 新内容 (new), 待解答 (unanswered), 有提醒 (deadline / room change / marks), 老师已答 (staff answered), 公告 (announcements), 有未读回复 (Ed's unread count), 我发的 (mine), 收藏 (starred)
5. Click ↻ 刷新 (refresh) whenever you like. It re-reads the thread list and only fetches posts whose fingerprint (updated time, reply count, answered state) changed, so a typical refresh is a few dozen requests. Posts and replies that appeared since the last refresh are marked 新 (new) or +N 新回复
6. Open the 课程内容 (Lessons) tab to see each unit's lessons by module with their status, the PDF and web attachments on each one, the text of Ed's own reading pages, and quiz questions (Ed does not release answers to students). The filter buttons narrow the list to lessons not started, in progress, due soon, overdue, or with materials (有资料)
7. Click 一键下载资料 (download all materials) to get one zip of the unit's PDFs and links, organised into week folders and named after the titles on the page. It is built entirely in your browser
8. 导出 JSON saves everything to a file; 载入之前导出的 JSON on the first screen brings it back on another machine

The number badges in the header and the tiles in the sidebar are per unit: new content since the last refresh, unanswered questions, posts with unread replies, lessons not completed. Click a tile to apply that filter.

## How the summaries are made

No LLM, pure rule-based logic:

- Posts with a staff reply → take the first sentence or two of the **last** staff reply (what the teacher finally said), prefixed 老师答 ("staff answered")
- Otherwise → the first substantial student answer (同学答), or the first sentence of the post body
- Keyword tagging: deadline/extension changes, time/location changes, grade releases, exam scheduling
- Unanswered questions and posts from the last 48 hours are highlighted separately. Once you have refreshed at least once, "new" means "appeared since your last refresh" instead

Quality is obviously lower than an AI-written summary, but for the vast majority of posts where "the staff reply was just 'Sure' or 'Up to you'", it's enough to judge whether to open the thread.

## Public showcase vs. private companion

`ed-web` is also the **public, privacy-safe showcase** of a larger private companion project used for my own study workflow.

The private companion adds engineering components that should not be published with real course data: SQLite persistence, scheduled jobs on a server, a read-only MCP server for AI agents, static dashboard generation, and manually triggered AI curation. The incremental synchronisation, the post renderer and the Lessons sync in `ed-web` follow the same rules as the companion's. The public repository deliberately excludes production credentials, server addresses, deployment paths, raw forum content, private posts, student information, meeting passwords, attendance codes, tokens, and generated databases.

For a sanitised overview of that architecture and the design decisions behind it, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Related

The fetching logic shares its origin with the private local companion. `ed-web` keeps the useful user-facing workflow while replacing server-side persistence and automation with browser-local storage and rule-based summaries, making the public version independently usable and auditable without exposing private course data or infrastructure.
