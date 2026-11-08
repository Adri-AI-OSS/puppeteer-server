# Plan (2026-11-09): next features to build and test

Builds on `docs/PLAN-harness-gaps.md`, which is done. Keeps the existing
endpoints: we aren't consolidating the API. Every item ships with tests in
`test/integration.test.js`, which runs the real server against headless Chrome
and a local fixture site.

Order of work: **P0 → #9, #10, #11 → P1 → #12 → the rest.**

**Status: all 21 items done.** `npm test` runs 59 integration tests:
`test/integration.test.js` (earlier plan), `test/features.test.js` (#2, #3,
#5–#17, #19) and `test/lifecycle.test.js` (#1, #18, #20, #21). CI is in
`.github/workflows/test.yml` (#4).

Found while testing: headless Chrome doesn't render background tabs, so
`page.click()` on the main tab hung once pool tabs or popups took the
foreground. Sequential runs now bring their page to the front first.

## P0 — Test what's already shipped
PR #1 (reconnect + logging) and several routes have no tests yet.

- [x] **#1 Auto-reconnect.** Close the server's connection to Chrome; the next
      request reconnects and keeps the same tab and login. Kill the server; a
      restarted server re-attaches to the same Chrome.
- [x] **#2 Logging.** The JSONL file has `start`/`exec`/`end` records with the
      full code; `run=`/`req=` link log lines to records; a run that fails
      before its code runs still gets an `end` record.
- [x] **#3 Untested routes.** `/goto`, `/page`, `/content`, `/screenshot`,
      `/cookies`, `/status`, `/reconnect`; pool `acquire`/`release`/`close-all`/
      `prune` and a full pool.
- [x] **#4 CI.** A GitHub Actions workflow that installs Chrome and runs `npm test`.

## P1 — Protect the shared logged-in tab
- [x] **#5 Undo settings a run changed:** viewport, user agent, extra headers,
      offline mode, JS on/off, cache, media emulation, timezone, geolocation,
      CPU/network throttling, `authenticate`. Restore the previous values unless
      `persist`.
      *Test:* set each one; the next run sees the original value.
- [x] **#6 Remove `evaluateOnNewDocument` scripts** when the run ends.
      *Test:* register a script; after navigating in the next run, it no longer
      runs.
- [x] **#7 Close tabs and contexts a run opened:** `newPage`, popups
      (`window.open`, `target=_blank`), incognito contexts. `keepTabs: true`
      keeps them.
      *Test:* tab count before and after; the `keepTabs` case; a popup that
      closes itself.
- [x] **#8 Detect a logged-out session.** Optional `--login-url-pattern`: if a
      run ends on a matching URL, return `sessionExpired: true` so the agent asks
      the user to log in instead of retrying.
      *Test:* a fixture route that redirects to `/login`.

## P2 — Feedback for agents
- [x] **#9 `GET /runs/:id`** returns a run's code, status, logs and dialogs from
      the execution log. Without it, `/run`'s `X-Run-Id` points at data the agent
      can't fetch.
      *Test:* call `/run`, then fetch with the header's id.
- [x] **#10 Page events during a run.** An option that returns the browser's own
      console messages, uncaught page errors and failed requests as `pageEvents`.
      *Test:* a fixture page that logs, throws and requests a 404.
- [x] **#11 `screenshotOnError: true`** attaches a base64 screenshot to failure
      responses, including timeouts.
      *Test:* a `click` on a missing selector returns an image.

## P3 — Long-running work
- [x] **#12 Async jobs.** `async: true` returns a `jobId`. `GET /jobs/:id` gives
      status, logs so far and the result. `POST /jobs/:id/cancel` reuses the
      existing abort. Old jobs expire.
      *Test:* poll a long job until it's done; cancelling stops it; an expired
      job returns 404.
- [x] **#13 Watching across calls.** `POST /watch` with `{events, tab}` returns a
      watch id; `GET /watch/:id?since=` returns a capped buffer of events. This
      replaces the `persist` + `globalThis` workaround.
      *Test:* start a watch, navigate in another call, read the events, check
      the cap.

## P4 — Files
- [x] **#14 `helpers.download(triggerFn)`.** Sets a per-run download folder,
      waits for the file to finish, and returns `{filename, bytes, data}`
      (base64), or a path when the file is large.
      *Test:* a fixture route that serves an attachment.
- [x] **#15 Uploads from the agent.** A request field `files: {name: base64}` is
      written to a temp folder and exposed as `helpers.files.<name>` for
      `uploadFile`. The agent may not be on the server's machine.
      *Test:* upload to a fixture form; the server receives the same bytes.
- [x] **#16 Large results.** Over a size threshold, write the result to a file and
      return its path, and serve it at `GET /artifacts/:id`, so the agent's
      context doesn't fill up.
      *Test:* return a ~20 MB payload.

## P5 — Robustness
- [x] **#17 Tab crash recovery.** Replace the crashed named page and report
      `tabCrashed`; cookies survive in the profile.
      *Test:* `page.goto('chrome://crash')`, then a normal request.
- [x] **#18 Chrome death.** Relaunch with the same profile and report
      `browserRestarted: true`, so the agent knows session-only cookies are gone.
      *Test:* kill the Chrome process.
- [x] **#19 Backpressure.** Limit the queue length (return 429); give
      `/pool/acquire` a timeout (today it can wait forever); cap the maximum
      `timeout`.
      *Test:* flood the queue; fill the pool and wait.
- [x] **#20 `POST /ready`.** Lets an agent tell the server the user has logged
      in, as an alternative to pressing ENTER in the terminal.
      *Test:* start without `--no-prompt`, call `/ready`, and requests are
      accepted.

## P6 — Security (optional)
- [x] **#21 Optional bearer token** (`--token`). Requests without it get 401.
      *Test:* call with and without the token.
