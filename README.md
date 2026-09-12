# Ed Web — Private, Client-Side Ed Discussion Reader

[![Live App](https://img.shields.io/badge/live-app-1e5eff?style=for-the-badge)](https://monashed.secureview.tech/app/)
[![Privacy](https://img.shields.io/badge/privacy-client--side%20only-2ea44f?style=for-the-badge)]()
[![Backend](https://img.shields.io/badge/backend-none-black?style=for-the-badge)]()

**English** · [中文](README.zh-CN.md)

A privacy-first, client-side web app for fetching, organising, searching, and summarising Ed Discussion course forums directly in your browser.

Live: https://monashed.secureview.tech/app/

## Privacy model

This page is **fully static**, with no application backend. Specifically:

- Your Ed token is stored only in your browser (`sessionStorage`, cleared when the tab is closed) and is sent only **directly to Ed's official `edstem.org` API** for authentication. It is never sent to `monashed.secureview.tech` or any third-party backend.
- Fetched posts are stored in your browser's **IndexedDB** and are not uploaded to this site.
- The page calls `edstem.org/api/*` directly from your browser. Ed's API returns `Access-Control-Allow-Origin: *`, so no proxy is required.

This repository is public specifically so you can verify the data flow yourself — a full-text search for `fetch(` shows only Ed's API and relative application paths as destinations.

## How to use it

1. Open https://monashed.secureview.tech/app/
2. Enter your Ed token as the page prompts (two methods, both documented on the page)
3. Select the units you want to fetch, then click "Start fetching"
4. Once fetched, search, browse by category, and read a one-line takeaway for each post

## How the summaries are made

No LLM, pure rule-based logic:

- Posts with a staff reply → take the first sentence or two of the first staff reply, prefixed "Staff answered"
- Otherwise → take the first sentence of the post body
- Keyword tagging: deadline/extension changes, time/location changes, grade releases, exam scheduling
- Unanswered questions and posts from the last 48 hours are highlighted separately

Quality is obviously lower than an AI-written summary, but for the vast majority of posts where "the staff reply was just 'Sure' or 'Up to you'", it's enough to judge whether to open the thread.

## Related

The fetching logic shares its origin with the local version (`ed-digest`, private). The local version adds AI summaries generated via `claude -p` and a daily scheduled job.
