# ed-web

[![Live App](https://img.shields.io/badge/live-app-1e5eff?style=for-the-badge)](https://monashed.secureview.tech/app/)
[![Privacy](https://img.shields.io/badge/privacy-client--side%20only-2ea44f?style=for-the-badge)]()
[![Backend](https://img.shields.io/badge/backend-none-black?style=for-the-badge)]()

**English** · [中文](README.zh-CN.md)

Fetch, organise, and summarise Ed Discussion course forums, entirely **in your own browser**.

Live: https://monashed.secureview.tech/app/

## What it never touches

This page is **fully static**, with no backend. Specifically:

- Your Ed token **only ever lives in your own browser** (`sessionStorage`, gone the moment you close the tab). It is never sent to `monashed.secureview.tech` or any other server.
- Fetched posts are stored in your browser's **IndexedDB**, also never uploaded.
- The page calls `edstem.org/api/*` directly from your browser. Ed's API returns `Access-Control-Allow-Origin: *`, so this works with no proxy in between.

This repository is public specifically so you can verify the above yourself — a full-text search for `fetch(` turns up exactly two destinations: `edstem.org` and relative paths.

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
