# Sanitised Architecture Overview

This document describes the architecture behind the private companion that inspired `ed-web`, without publishing private course data, credentials, or production infrastructure details.

## Why there are two implementations

The public `ed-web` application is intentionally browser-only. It is designed to be independently usable and auditable: authentication stays in the browser, fetched content stays in IndexedDB, and there is no application backend.

The private companion solves a different problem: maintaining a personal, continuously updated study archive without depending on an open browser tab. That requires persistence and scheduling, which in turn makes privacy and operational boundaries much more important.

## Public application

```text
Browser
  |
  | direct authenticated requests
  v
Ed Discussion API
  |
  v
normalise / organise posts
  |
  +--> IndexedDB
  |
  +--> search + filters
  |
  +--> rule-based summaries / tags
  |
  v
static UI
```

Key properties:

- no application backend;
- token lives only in browser session storage;
- forum content remains in browser-local IndexedDB;
- direct API calls make the data flow easy to audit;
- rule-based summaries avoid sending course content to another service.

## Private companion

The private implementation extends the same core idea with a persistent local data pipeline:

```text
Scheduled worker
      |
      v
Ed API client
      |
      v
incremental synchronisation
      |
      v
SQLite persistence
      |
      +--------------------+
      |                    |
      v                    v
searchable archive     manual AI curation
      |                    |
      +----------+---------+
                 |
                 v
        static dashboard build
                 |
                 v
       access-controlled hosting
```

### Incremental synchronisation

The worker first fetches lightweight post metadata and only re-fetches thread bodies and replies when relevant update fields have changed. This keeps normal refreshes small instead of repeatedly downloading the entire forum history.

### SQLite persistence

A local relational store keeps posts, replies, metadata, generated summaries, and processing state. Persistence makes full-text study workflows and historical review possible without requiring the source forum to be re-fetched for every query.

### Scheduled jobs

Regular synchronisation and static-site generation are automated. AI-assisted curation is deliberately separated from the scheduled path and is only started manually, so ordinary refreshes do not consume AI quota or unexpectedly send content into an AI workflow.

### Static dashboard generation

The private pipeline renders its current state into static HTML. This keeps the serving layer simple: the sensitive logic and source credentials are not required by the web server after generation.

## Security and privacy boundaries

The public repository intentionally does **not** include any of the following from the private deployment:

- API tokens or authentication sessions;
- SSH keys, host addresses, ports, usernames, or server aliases;
- production filesystem paths or service credentials;
- password files or password hashes;
- raw course/forum exports or generated databases;
- private posts;
- student names or other personal information;
- meeting passwords, attendance codes, or other restricted course information;
- production logs;
- private study notes generated from real course content.

The architecture shown here is therefore useful as a software-engineering reference without making the production system reproducible against private data.

## Engineering themes demonstrated

The combined public/private design demonstrates several different concerns:

- browser-side privacy and threat modelling;
- API client design and data normalisation;
- incremental synchronisation;
- SQLite-backed persistence;
- scheduled background processing;
- separation of deterministic jobs from manually triggered AI work;
- static-site generation;
- access-controlled publication of sensitive personal data;
- designing a public version that remains useful without exposing the private production environment.

## Relationship to `ed-web`

`ed-web` is not a mock-up of the private system. It is a separate, working implementation of the user-facing workflow with a stricter privacy model. The two projects share the same underlying problem domain, but make different architectural trade-offs:

| Concern | `ed-web` | Private companion |
| --- | --- | --- |
| Execution | browser | scheduled worker + static site |
| Persistence | IndexedDB | SQLite |
| Token location | browser session only | protected local runtime configuration |
| Summaries | deterministic rules | rules + manual AI curation |
| Hosting | static public app | access-controlled private dashboard |
| Course data in repository | none | none |

This separation lets the public project remain useful, inspectable, and safe to share while still documenting the broader engineering work behind the private workflow.
