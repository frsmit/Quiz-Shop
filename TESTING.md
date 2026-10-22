# Manual testing guide

The automated suite (`npm test`, 188 tests) covers everything that can run
without a browser. This is the rest: the parts that need a real Chrome, a real
page and — if you want it — a real provider.

Work top to bottom. Each stage builds on the one before, so if something breaks
you know which layer it is in.

---

## Stage 0 — Automated suite (2 minutes)

```bash
npm install
npm test
npm run typecheck
npm run build
```

Expect 71 backend tests, 117 extension tests, no type errors, and two Vite
builds writing to `extension/dist`.

If this stage fails, stop here — nothing below will work.

---

## Stage 1 — Backend alone, no credentials (5 minutes)

You do not need an API key to prove the backend works. `npm run fake-ai`
answers every question deterministically, so you can exercise the real HTTP
path first and add a provider later.

**Terminal 1**

```bash
npm run fake-ai
```

**`server/.env`** — create it from the example and set these four values:

```bash
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://127.0.0.1:4999/v1
AI_API_KEY=local-dev
AI_MODEL=fake-model
```

**Terminal 2**

```bash
npm run dev
```

### Check the health endpoint

```bash
curl http://127.0.0.1:3000/api/health
```

- [ ] `"activeProvider": "openai-compatible"`
- [ ] `"providers": ["openai-compatible"]` — this is the important one. If the
      array is empty, the backend cannot see your credentials.
- [ ] No key or secret appears anywhere in the response.

### Ask it a question

```bash
curl -X POST http://127.0.0.1:3000/api/questions/answer \
  -H "Content-Type: application/json" \
  -d '{"question":"What is the time complexity of binary search?","type":"multiple_choice","options":["O(n)","O(log n)","O(n^2)","O(1)"]}'
```

- [ ] `data.answer` is `"O(log n)"` (the fake endpoint always picks the second
      option, which is what makes it checkable)
- [ ] `data.provider` and `data.model` are filled in
- [ ] `meta.cached` is `false`

Run the identical command again:

- [ ] `meta.cached` is now `true`, and Terminal 1 logs nothing new — the cache
      served it without touching the provider

### Check it fails properly

```bash
# Too short - should be 400 invalid_request
curl -X POST http://127.0.0.1:3000/api/questions/answer \
  -H "Content-Type: application/json" -d '{"question":"why?"}'

# Unknown route - should be 404 not_found
curl http://127.0.0.1:3000/api/nope
```

- [ ] Both return a `{ "error": { "code", "message" } }` envelope, not a stack
      trace or an HTML error page

---

## Stage 2 — Load the extension into Chrome (2 minutes)

This is the one step no test can do for you: Chrome blocks automation of its
own settings pages.

1. `npm run build:extension` (if you have not already)
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the **`extension/dist`** folder — not `extension/`

- [ ] The card appears as "AI Browser Learning Assistant" with the blue `?` icon
- [ ] **No "Errors" button on the card.** If there is one, click it — a manifest
      or service-worker startup error will be listed there
- [ ] Click **service worker** on the card. DevTools opens on the worker; the
      Console should be empty

Keep that service-worker DevTools window open — it is where you will see what
the extension is doing.

---

## Stage 3 — The demo page (10 minutes)

**Terminal 3**

```bash
npm run demo
```

Open <http://localhost:5173>. The extension is allowed on `localhost` out of the
box, so there is nothing to configure yet.

### 3a. Confirm it is running and silent

- [ ] The page looks completely normal — no badge, no panel, no "AI answer"
      label, nothing injected. **This is a requirement, not an absence of
      features:** the whole point is that the page is untouched
- [ ] In the page's own DevTools (F12) → **Network**, filter on `answer`. Within
      a few seconds you should see `POST` requests to
      `http://localhost:3000/api/questions/answer`

> **Requests arrive about one per second.** The content script deliberately
> spaces them out so a page with twenty questions cannot fire twenty
> simultaneous provider calls. Seven questions take roughly seven seconds.

- [ ] Terminal 2 (backend) logs one `Answering question` line per question, with
      the **type and sizes only — never the question text**
- [ ] Terminal 1 (fake AI) logs one line per question

### 3b. Turn on answer filling

Right-click the extension icon → **Options** (or `chrome://extensions` →
Details → Extension options).

- [ ] Tick **Fill answers into the page**
- [ ] Click **Save settings**, see "Settings saved."
- [ ] Click **Test connection** — expect "Backend reachable. Active provider:
      openai-compatible."

Reload <http://localhost:5173>.

- [ ] Over the next few seconds, radio buttons select themselves and text fields
      fill in
- [ ] With the fake endpoint, **the second option** of each multiple-choice
      question is chosen — Q1 picks `O(log n)`, Q2 picks `301 Moved
      Permanently`. Wrong answers are expected here; the fake endpoint is not
      thinking, it is proving the wiring
- [ ] The `<select>` in Q5 changes to `HAVING`
- [ ] The textarea in Q4 gets text typed into it
- [ ] Q8 (select all that apply) gets **two** boxes ticked — the fake endpoint
      picks the second and third options, `FETCH` and `POST`
- [ ] Q9 (a component whose hidden input ignores clicks) shows `padding`
      highlighted — the row was clicked the way a user would click it
- [ ] Q10 (ARIA radios, no inputs) shows `Symbol` in bold
- [ ] In **Activity log**, none of these shows `not applied`

### 3c. Dynamic questions

- [ ] Click **Load two more questions**. After the ~900 ms delay, two new
      questions appear, and two new `POST`s follow in the Network tab
- [ ] They get filled in too

### 3d. Deduplication — the important one

- [ ] Clear the Network tab
- [ ] Click **Re-render all questions**. Every question node is destroyed and
      rebuilt, exactly as a React re-render would
- [ ] **No new requests appear.** The fingerprints are unchanged, so the
      extension recognises them and stays quiet

If you see a burst of requests here, deduplication is broken.

### 3e. Page furniture is ignored

- [ ] The nav link "Why is recursion hard to learn?", the advert's "Have you
      tried our premium plan?" and the footer's "What is the meaning of this
      footer?" all look like questions. **None of them should ever appear in a
      request.** Check the request bodies in the Network tab

---

## Stage 4 — Failure handling (5 minutes)

Things break in the real world; check that it degrades quietly rather than
spraying errors into the page.

### Backend down

- [ ] Stop Terminal 2 (Ctrl-C) and reload the demo page
- [ ] The page still renders and behaves normally — no error overlay, no broken
      layout, nothing injected
- [ ] The service-worker console shows the failure being handled, not an
      unhandled rejection
- [ ] Restart the backend and reload — answers resume

### Provider down

- [ ] Stop Terminal 1 (the fake AI), keep the backend running, reload the page
- [ ] The backend returns `503 unavailable`; the page is still untouched

### Wrong backend URL

- [ ] In Options, set Backend URL to `http://localhost:9999`, save
- [ ] Click **Test connection** → expect "Could not reach the backend at
      http://localhost:9999."
- [ ] Set it back to `http://localhost:3000`

### Rate limiting

```bash
for i in $(seq 1 35); do
  curl -s -o /dev/null -w "%{http_code} " -X POST http://127.0.0.1:3000/api/questions/answer \
    -H "Content-Type: application/json" \
    -d "{\"question\":\"Rate limit probe number $i please answer\",\"type\":\"short_answer\"}"
done; echo
```

- [ ] The first 30 return `200`, then they switch to `429`

### Shared secret

- [ ] Set `API_ACCESS_KEY=test-secret` in `server/.env` and restart the backend
- [ ] Reload the demo page — requests now fail with `401`
- [ ] Put `test-secret` into **Backend access key** in Options, save, reload
- [ ] Answers work again
- [ ] Remove `API_ACCESS_KEY` and restart when you are done

---

## Stage 5 — A site of your own (5 minutes)

The extension only runs on `localhost` until you say otherwise.

1. Find a practice-quiz page you are allowed to use
2. Options → **Sites** → type the address → **Add site**
3. Chrome prompts for host access — accept

- [ ] The site appears in the list marked "access granted"
- [ ] Reload that page; questions are detected in the Network tab
- [ ] Click **Remove** — Chrome's permission is revoked and the content script
      is unregistered. Reload: nothing is detected any more

This is also the honest test of the detector against markup it has never seen.
If it misses questions on a real site, that is the extraction heuristics
needing a per-site profile, not a bug in the plumbing.

---

## Stage 6 — A real AI provider (5 minutes)

Only now is a key worth spending.

1. Stop the fake AI
2. In `server/.env`, clear `AI_BASE_URL` and `AI_API_KEY`, then set one of:

```bash
AI_PROVIDER=openai       # and OPENAI_API_KEY=sk-...
AI_PROVIDER=anthropic    # and ANTHROPIC_API_KEY=sk-ant-...
AI_PROVIDER=gemini       # and GEMINI_API_KEY=...
```

3. Restart the backend and reload the demo page

- [ ] `/api/health` lists your provider under `providers`
- [ ] The answers are now **correct**: Q1 selects `O(log n)`, Q2 selects
      `404 Not Found`, Q5 selects `HAVING`, Q3's field gets `2-4-6`
- [ ] `data.explanation` reads like an explanation for a learner
- [ ] `data.provider` and `data.model` match what you configured

### Switch providers without restarting

In Options, change the provider dropdown and save. If that provider has
credentials on the backend, the next question goes to it — no restart, no code
change. That is the provider abstraction doing its job.

### Bring your own key from the extension

With the backend's own key removed (or for a provider it has no key for):

- [ ] **Settings → AI provider**: pick the provider; the key field says
      "Required: the backend has no key for this provider" and the model
      field's placeholder shows the backend's default
- [ ] Paste your key and click **Test provider** before saving — expect
      "<provider> · <model> answered "4" in …s"
- [ ] A wrong key shows the provider's own error message instead
- [ ] Save, reload the demo page: answers arrive from your account
- [ ] The backend log shows `ownKey: true` and `x-ai-api-key: "[redacted]"`;
      the key itself appears nowhere in it
- [ ] For an OpenAI-compatible endpoint the base URL and model are required;
      with the fake AI: base URL `http://127.0.0.1:4999/v1`, model
      `fake-model`, any key
- [ ] Set `ALLOW_CLIENT_AI_KEYS=false` and restart: the settings page warns the
      key will be refused, and questions fail with that message

---

## Stage 7 — Docker (3 minutes)

```bash
docker compose up --build
curl http://127.0.0.1:3000/api/health
```

- [ ] The container starts and reports healthy
- [ ] `docker ps` shows the health check passing
- [ ] The demo page still works against it

---

## What "working" looks like, in one line

The demo page fills itself in, correctly, a second or so per question, with
nothing added to the page and nothing in the console — and clicking
**Re-render all questions** produces no new network traffic at all.

---

## If something is wrong

| Symptom | Look here |
|---|---|
| Nothing happens at all | `chrome://extensions` → is the card enabled, any Errors button? |
| No requests in the Network tab | Is the page on `localhost`? Is **Detect questions automatically** on? |
| Requests fail with `401` | `API_ACCESS_KEY` is set on the backend but not in Options |
| Requests fail with `403` | CORS — check `CORS_ALLOWED_ORIGINS` includes `chrome-extension://*` |
| `503 missing_credentials` | The backend has no key for the selected provider; `/api/health` will confirm |
| Answers arrive but nothing fills in | **Fill answers into the page** is off, or the answer text did not match any option — that is deliberate, it refuses to guess |
| Questions detected twice | Report it. Origins already covered by the manifest are meant to be skipped |
| Service worker seems asleep | Normal. MV3 evicts idle workers; the next message wakes it |
