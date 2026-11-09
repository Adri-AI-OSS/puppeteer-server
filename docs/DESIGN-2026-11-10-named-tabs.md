# Design (2026-11-10): one tab model — named tabs

Status: **implemented** (`lib/tabs.js`). All existing 59 tests pass unchanged;
`test/tabs.test.js` adds 15 tests. Also live-tested against real sites in
headless and headful mode (see [Evidence](#evidence)).

## Problem

There are three ways to say "which page", each with its own rules:

| Mechanism | Addressed by | Concurrency | Listed? | Survives reconnect/restart? |
|---|---|---|---|---|
| `main` | default | one global queue | no | yes (adopted on attach) |
| named pages (`pageName`) | name | same global queue as `main` | no | **no**: the tab is orphaned and a new one is opened |
| pool tabs (`--pool`) | `tab-N` id | parallel | `/pool/tabs` | no |

This causes the following:

- A slow run on one named page blocks every other named page, because they share one global queue. Only pool tabs run in parallel, and pool tabs have no names.
- There's no way to list or close named pages.
- After a reconnect or restart, named pages other than `main` are forgotten, and their tabs leak.
- The fixed-purpose routes (`/goto`, `/page`, `/content`, `/screenshot`, `/cookies`) only act on `main`.
- **Clicks hang on tabs that aren't in front.** In headless Chrome, only the window's front tab renders, so `page.click()` on any other tab never completes. This hits pool tabs running in parallel, and any tab after a popup takes focus. The current per-run `bringToFront()` only helps sequential runs.

## Goals

1. One concept, a **tab** addressed by **name**, with one set of rules.
2. Calls to the same tab run in order; calls to different tabs run in parallel.
3. Tabs can be listed and closed, and their names survive reconnects and server restarts.
4. Clicks work on every tab, including tabs running in parallel in headless mode.
5. **No breaking changes.** Today's requests keep working through aliases.

Non-goals: multiple browsers per server (run more server instances for that), and cross-tab transactions.

## Model

- A **tab** is a Chrome page with a name, registered with the server. All tabs share the logged-in browser context, so they have the same cookies and the same session.
- `main` is the tab the user logged in on. It always exists, is never closed automatically, and is protected from `DELETE` unless `?force=true`.
- **Agent tabs** are created by name, either explicitly or on first use. They expire after being idle for `--tab-idle-ttl` (default 30 min).
- **Throwaway tabs** (`tab: "new"`) are created for one run and closed when it ends.
- **Each tab has its own queue.** Runs on one tab are serialized; runs on different tabs are concurrent. The single global sequential queue goes away.
- **One window per tab** (see [Evidence](#evidence)). Each window has exactly one tab, which is therefore always in front and always rendered.

Name rules: `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. `new` is reserved.

## API

```
POST   /execute   { code, tab?: "main" | "<name>" | "new", ...existing options }
POST   /run       (same, raw result)

GET    /tabs                → [{ name, url, title, kind: "main"|"agent"|"ephemeral",
                                 busy, queued, createdAt, lastUsedAt, expiresAt, isolated }]
POST   /tabs      { name?, url?, isolated? }  → 201 { name, ... }   (name generated if omitted;
                                                                      409 if it exists)
GET    /tabs/:name          → one tab (404 if unknown)
DELETE /tabs/:name          → closes it (409 for main unless ?force=true; 409 if busy unless ?force=true)
```

Rules:

- **Default tab.** `tab` defaults to `main`, so `{ code }` behaves exactly as today.
- **Auto-create.** An unknown `tab` name on `/execute` creates the tab, which is today's `pageName` behaviour, so agents can skip `POST /tabs`. The response then has `tabCreated: true`, so a typo shows up instead of silently running in a blank tab.
- **`tab` everywhere.** Every execute response includes `tab`. Runs, jobs and watches record it.
- **Fixed-purpose routes** take `?tab=`: `GET /screenshot?tab=crm`, `POST /goto { url, tab }`, and so on.
- **Watches:** `POST /watch { tab: "crm" }`. `page`/`tabId` remain as aliases.
- **Exclusivity:** there's no acquire/release. An agent that needs a tab to itself across several calls creates a uniquely named one, e.g. `agent-7-report`.
- **Isolation:** `isolated: true` creates the tab in its own incognito context, for a logged-out view or a second account. It's in-memory only, so it doesn't survive a Chrome restart.

## Behaviour details

### Queues and limits
- Per tab: a FIFO queue capped at `--max-queue` per tab (429 when full).
- Global: at most `--max-tabs` open tabs **besides `main`** (agent + pool + ephemeral). This
  keeps `--max-tabs` meaning what it meant for the pool. When creating one more would exceed it:
  - `tab: "new"` waits for a slot up to `--acquire-timeout`, then returns 503, as the pool does today.
  - `POST /tabs` returns 409 with the list of idle tabs, so the agent can close one.
- `/clear-queue` gets `?tab=`. Without it, it clears every tab's queue (today's behaviour, widened to all tabs).

### Persistence across reconnects and restarts
- The registry `{ name → { targetId, kind, isolated, createdAt } }` is written to `<profile dir>/puppeteer-server-tabs.json` on every change.
  - Chrome target ids are stable for as long as Chrome runs.
  - The registry sits next to the profile because it describes that profile's Chrome.
- **On attach** (reconnect or server restart), each registered tab is matched to a live target by `targetId`:
  - Matched tabs are re-adopted, with the dialog handler and crash events re-installed.
  - Tabs that are gone are dropped and listed once in the log, and in `GET /tabs` as `lost` for 10 minutes.
  - Ephemeral and isolated tabs are not persisted.
- **On a Chrome relaunch** (`browserRestarted`), the registry is reset to `main`, since none of the old target ids exist any more.
- The old "adopt a non-blank tab as `main`" fallback stays, for a registry that is missing or stale.

### Windows
- Agent and ephemeral tabs are opened with `Target.createTarget({ url, newWindow: true })` and then adopted as Puppeteer pages.
- `main` keeps whatever window the user logged in with.
- The per-run `bringToFront()` remains as a cheap safety net.
- Popups a snippet opens are unaffected: they still close at run end unless `keepTabs`/`persist`.
- `--tabs-as windows|tabs` (default `windows`) is an escape hatch if windows turn out to be unwelcome in headful mode.

### Crashes
- These work as now, but per tab:
  - a run on a crashed tab fails at once
  - the next run on that name gets a fresh window, and the response has `tabCrashed`
  - the registry entry is updated with the new `targetId`

### Interaction with run cleanup
- Tabs created through `POST /tabs` or auto-create belong to the server, not the run, so run cleanup never closes them.
- Tabs and popups a snippet opens itself (`browser.newPage()`, `window.open`) belong to the run, as today.

## Compatibility (aliases, no breaking changes)

| Today | Becomes |
|---|---|
| `{ code, pageName: "x" }` | `{ code, tab: "x" }` |
| `POST /pool/execute` | `POST /execute { tab: "new" }` (response keeps a `tabId` field) |
| `POST /pool/acquire` → `{ tabId }` | `POST /tabs` with a generated name → `{ tabId: name, name }` |
| `POST /pool/tab/:id/execute` | `POST /execute { tab: id }` |
| `POST /pool/release/:id` | marks the tab idle, so it becomes eligible for reuse by `tab: "new"` and for expiry |
| `DELETE /pool/tab/:id`, `/pool/close-all`, `/pool/prune` | `DELETE /tabs/:id`, close all agent tabs, close idle agent tabs |
| `GET /pool/status`, `/pool/tabs` | derived from the registry (same shapes) |
| `--pool`, `--max-tabs` | `--pool` becomes a no-op (tabs are always available); `--max-tabs` keeps its meaning |

The docs describe only the tab model, with one "Deprecated aliases" table. Existing tests keep passing unchanged; new tests cover the tab API.

Behaviour that does change:
- Runs on different named pages now run in parallel. Today they queue behind each other. A caller that relied on that global serialization would see overlap.
- Named pages and pool tabs open in their own windows.

## Implementation plan

- [x] **T1 Tab registry** (`lib/tabs.js`):
      - name rules, kinds, per-tab FIFO queue, create/get/list/close, idle expiry
      - replaces `BrowserManager.pages` and `TabPoolManager`
      - the executor's sequential path becomes "enqueue on tab"
      - *Tests:* two tabs run concurrently while one tab serializes; per-tab 429; `--max-tabs` with `tab: "new"` → 503 after the acquire timeout; idle expiry closes agent tabs but never `main`.
- [x] **T2 API:**
      - `tab` option; `GET/POST/DELETE /tabs`
      - `?tab=` on the fixed-purpose routes and `/clear-queue`, plus `tab` on `/watch`
      - `tabCreated` and `tab` in responses
      - *Tests:* auto-create with `tabCreated`; 409 on duplicate `POST /tabs` and on deleting `main` or a busy tab; `/screenshot?tab=` returns that tab's image; a watch on a named tab.
- [x] **T3 Aliases:**
      - `pageName` and every `/pool/*` route mapped onto tabs
      - *Tests:* the existing 59 tests, unchanged.
- [x] **T4 Persistence:**
      - registry file and re-adoption on attach; reset on relaunch; `lost` reporting
      - *Tests:* create `crm`, navigate, drop the CDP connection → same `crm` tab (same URL and cookies); SIGKILL the server and restart → `crm` re-adopted with no extra tab in Chrome; kill Chrome → registry reset and `browserRestarted`.
- [x] **T5 One window per tab:**
      - `Target.createTarget({ newWindow: true })`; `--tabs-as`
      - *Tests:* three tabs clicking concurrently in headless mode all complete (today two hang).
- [x] **T6 Isolated tabs:**
      - `isolated: true` → own incognito context, closed with the tab
      - *Tests:* a cookie set in `main` is not visible in an isolated tab, and vice versa.
- [x] **T7 Docs:** README and REFERENCE rewritten around tabs, plus the deprecated-alias table.

Order: T1 → T2 → T3 (old tests stay green) → T5 → T4 → T6 → T7.

## Evidence

Concurrent `page.click()` on three pages, Chrome 157, Puppeteer 21.11, measured 2026-11-10 (script: three targets, each navigated to a fixture page, then three clicks in parallel with a 4 s limit):

| Headless mode | Tabs in one window | One window per tab |
|---|---|---|
| `true` (old) | 2 of 3 hang | 3 of 3 ok |
| `'new'` | 2 of 3 hang | 3 of 3 ok |

Headful was not measured at first. It was verified after implementation (live run, 2026-11-10) against real sites on the implemented server, in both headless and headful mode:

| Check | headless | headful |
|---|---|---|
| 3 concurrent real clicks (example.com → iana.org), one tab each | 3/3 ok, 1.06 s | 3/3 ok, 1.11 s |
| `main` + 3 agent tabs → distinct window ids | 4 distinct | 4 distinct |
| cookie set in `main` (httpbin) visible in an `isolated` tab | no | no |
| named tab after a dropped CDP connection | same URL, `reconnected` | same URL, `reconnected` |
| server SIGKILL + restart: tab re-adopted, Chrome page count | same URL, 8 → 8 | same URL, 8 → 8 |
| parallel navigations on two tabs (local 2 s endpoint) | 2.04 s wall for 2 × 2 s | — |

## Decisions on the open questions

These are the defaults as implemented; each is easy to change.

1. **Headful clutter.** The default stays `windows` everywhere: correctness (clicks work) over tidiness. `--tabs-as tabs` (or `$PUPPETEER_SERVER_TABS_AS=tabs`) opts out.
2. **Registry location.** Profile dir: `<profile>/puppeteer-server-tabs.json`.
3. **Auto-create on `/execute`.** Kept, reported with `tabCreated: true`. Auto-create still respects `--max-tabs`.
