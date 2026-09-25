# AI Browser Learning Assistant

A Manifest V3 Chromium extension that reads practice questions out of the page
you are already on, answers them through a configurable AI provider, and — when
you ask it to — fills the answer into the page's own controls.

There is no chat window, no floating panel and no "AI answer" badge. The page
looks exactly as it did before the extension was installed; all of the work
happens in a content script, a background service worker and a small Express
backend.

Built as a learning and portfolio project. It deliberately implements **no**
CAPTCHA solving, anti-bot evasion, proctoring bypass or browser-security bypass,
and it does not disguise itself as anything other than a browser extension.

---

## Contents

- [Architecture](#architecture)
- [Technology stack](#technology-stack)
- [Extension architecture](#extension-architecture)
- [Controlling it](#controlling-it)
- [Monitoring and logs](#monitoring-and-logs)
- [Backend architecture](#backend-architecture)
- [AI provider architecture](#ai-provider-architecture)
- [Environment configuration](#environment-configuration)
- [Local development](#local-development)
- [Installing the extension](#installing-the-extension)
- [Demo website](#demo-website)
- [API documentation](#api-documentation)
- [Security](#security)
- [Privacy](#privacy)
- [Testing](#testing)
- [Manual testing](TESTING.md)
- [Docker](#docker)
- [Adding a new AI provider](#adding-a-new-ai-provider)
- [Project structure](#project-structure)
- [Future improvements](#future-improvements)

---

## Architecture

```mermaid
flowchart TD
    subgraph Browser["Chromium — your normal browser session"]
        Page["Web page<br/>(React, Vue, Angular, static HTML)"]
        subgraph CS["Content script — isolated world"]
            Detector["detector.ts<br/>find candidate questions"]
            Extractor["extractor.ts<br/>question, options, context"]
            Observer["observer.ts<br/>MutationObserver + debounce"]
            Interaction["interaction.ts<br/>fill the page's own controls"]
        end
        SW["Background service worker<br/>settings · cache · request coalescing"]
        Options["Options page (React)"]
    end

    subgraph Server["Express backend"]
        Route["POST /api/questions/answer"]
        Zod["Zod validation<br/>in and out"]
        Service["QuestionService<br/>cache · dispatch"]
        Factory["ProviderFactory"]
    end

    subgraph Providers["AIProvider implementations"]
        OpenAI["OpenAIProvider"]
        Gemini["GeminiProvider"]
        Anthropic["AnthropicProvider"]
        Compatible["OpenAICompatibleProvider"]
    end

    Page -->|DOM| Detector
    Detector --> Extractor
    Observer -.->|re-scan on change| Detector
    Extractor -->|QuestionRequest| SW
    SW -->|HTTPS + optional x-api-key| Route
    Route --> Zod --> Service --> Factory
    Factory --> OpenAI & Gemini & Anthropic & Compatible
    OpenAI & Gemini & Anthropic & Compatible -->|QuestionAnswer| Service
    Service -->|structured JSON| SW
    SW -->|answer| Interaction
    Interaction -->|standard DOM events| Page
    Options <-->|settings| SW
```

Two rules shape the whole design:

1. **Provider credentials never enter the browser.** The extension only ever
   talks to your backend; the backend holds the keys.
2. **Nothing above the `AIProvider` interface knows which vendor answered.**
   Detection, transport, caching and the UI are all vendor-agnostic.

---

## Technology stack

| Area | Choice |
|---|---|
| Extension | TypeScript, Vite, React (options page only), Manifest V3 |
| Browser APIs | Content scripts, service worker, `chrome.storage`, `chrome.scripting`, `chrome.permissions`, MutationObserver, message passing |
| Backend | Node.js, TypeScript, Express 5, Zod, Helmet, CORS, `express-rate-limit`, pino |
| AI SDKs | `openai`, `@google/genai`, `@anthropic-ai/sdk` |
| Testing | Vitest (jsdom for the extension, node for the backend), Supertest |
| Tooling | npm workspaces, Docker, Docker Compose |

Persistence is optional and not used in this version. The architecture is
prepared for MongoDB / MongoDB Atlas — see
[Future improvements](#future-improvements).

---

## Extension architecture

**No browser automation framework is involved.** There is no Selenium,
Puppeteer or Playwright, and no second browser instance. The extension runs in
the browser you are already using.

### Detection

`detector.ts` works bottom-up: it finds the answer controls first (radio
groups, checkboxes, `<select>`, text inputs, textareas) and then walks outwards
to the smallest ancestor that also contains prompt text. The cost is therefore
proportional to the number of answerable things on the page, not to the size of
the page. A second pass handles questions rendered as static text with lettered
options and no controls at all.

Supported shapes, all covered by tests against the demo page:

| Shape | Detected as |
|---|---|
| `<fieldset>` + radios with `<label for>` | `multiple_choice` |
| Label-wrapped radios, no fieldset | `multiple_choice` |
| `<select>` dropdown | `multiple_choice` |
| Static text with `A.` / `B.` / `(c)` options | `multiple_choice` |
| Prompt + `<textarea>` | `short_answer` |
| Prompt + `<pre><code>` listing | `programming` |
| Prompt + MathML / KaTeX / `data-latex` | `mathematical` |

Navigation, headers, footers, asides, adverts, hidden elements and
`aria-hidden` subtrees are excluded before any text is read.

### Extraction

Only the question survives the extraction pipeline:

```
DOM
 ↓  candidate detection
 ↓  prompt text (option labels, controls and their labels removed)
 ↓  options (from labels, <select>, or lettered text lines)
 ↓  context (code listings, maths, and a preceding shared passage)
 ↓  normalisation and length limits
 ↓  fingerprint (content hash)
 ↓  QuestionRequest
```

Maths is read structurally rather than flattened: LaTeX is preferred where the
page exposes it (`data-latex`, `<annotation encoding="application/x-tex">`),
and bare MathML is converted with superscripts, fractions and roots intact, so
`3x²+5x−7` does not arrive as the ambiguous `3 x 2 + 5 x − 7`.

### Dynamic pages

`observer.ts` watches the document with a MutationObserver. Mutations are
filtered to ones that could plausibly introduce a question and then coalesced
into a single scan after a 400 ms quiet period, so a re-rendering SPA does not
turn into a stream of API calls.

### Deduplication

Every question is fingerprinted from its normalised text and options with a
64-bit digest. React and Vue destroy and recreate DOM nodes constantly; the
fingerprint is unchanged by that, so a re-render never produces a second
request. The demo page's "Re-render all questions" button exercises exactly
this, and a test asserts the fingerprints are identical afterwards.

### Background service worker

The worker owns everything the page must not see: settings, the backend URL and
the optional backend key. It also:

- re-validates every message from a content script (content scripts share an
  origin with untrusted page code, so their output is not trusted),
- coalesces concurrent identical questions into one backend call,
- keeps a bounded, expiring answer cache,
- registers content scripts dynamically for origins the user has opted in to.

### Answer application

`interaction.ts` uses ordinary DOM APIs only: `click()` on the real control, and
the native value setter plus bubbling `input`/`change` events for text fields so
React's own listeners see the change. There is no OS-level input simulation.
If no option matches confidently, it reports `no-match` rather than guessing.

---

## Controlling it

### Toolbar popup

Clicking the extension icon opens a small panel that is the day-to-day
control surface:

- **Pause / Resume.** A global stop. While paused nothing is answered on any
  tab, and the toolbar badge shows `||`.
- **Enable on this site.** Requests host access for the site you are looking
  at and starts working on it immediately — no reload, no visit to the options
  page. The same button disables and revokes it again.
- Counters for today and all time, and whether answer filling is on.

### Timing

Both delays live under **Settings → Timing**, as presets with a custom box:

| Setting | What it does |
|---|---|
| **Start answering** | How long to wait after resuming before the first answer. Counted from when you press Resume, so you can open a page and read it yourself first. The popup shows a live countdown and the badge shows `…`. |
| **Delay between answers** | Minimum gap between two answers, enforced **globally** rather than per tab — three pages open at once still produce one answer per interval. |

Questions found while the start delay is still running are not lost: the
content script is told to retry, and picks them up the moment it elapses.

### One question per page

Sites that show a single question and make you click **Next** are handled
without any special configuration:

- A full page load starts a fresh content script, which finds the new question.
- A single-page app that swaps the question in place is caught by the
  MutationObserver.
- Navigating **back** to a question that was already answered re-fills it from
  the in-page answer map, with no second request.

**It fills answers in and stops there.** It never clicks Next, Submit, Finish
or any other control — advancing through a quiz is yours to do.

---

## Monitoring and logs

The options page opens on a **Monitor** tab showing live run state, a countdown
when the start delay is running, counters (today, total, cached, errors), the
backend it is pointed at with a one-click health check, a feed of recent
questions, and which sites have been busiest.

The **Activity log** tab is the full record — one row per question with time,
site, question, answer, outcome and latency. Rows expand for the detail
(type, option count, provider, model, page). It can be filtered by outcome,
searched across questions, answers and sites, exported as JSON for a bug
report, and cleared.

Outcomes are recorded end to end, including what happened on the page itself:
`answered`, `cached`, `filled`, `no match` (the answer did not match any option
confidently, so nothing was touched), `nothing to fill` and `error`.

The log lives in `chrome.storage.local`, is capped (500 entries by default,
oldest dropped first), and is never transmitted anywhere. Recording can be
switched off entirely under **Settings → Activity log**.

---

## Interface

The options page is laid out as an admin console: a fixed sidebar for
navigation, a sticky header carrying the page title and its actions, and
panelled content with dense data tables.

It is deliberately **monochrome** - every colour in the stylesheet is a true
neutral grey, verified by an audit of the compiled CSS. State, emphasis and
severity are carried by fill weight, border style and a leading glyph rather
than by hue, which is also what keeps them legible in high contrast and to
anyone who could not rely on colour in the first place:

| Outcome | Rendered as |
|---|---|
| answered | outlined chip, tick |
| filled | solid grey chip, tick |
| cached | soft filled chip, repeat glyph |
| no match | dashed outline, question mark |
| nothing to fill / skipped | faint outline, dash |
| error | solid black chip, exclamation |

Run state uses the same idea: a filled dot for running, a dashed ring while
the start delay counts down, and a hollow ring when paused or switched off.

Light and dark both follow the system preference.
---

## Backend architecture

```
Express
 ├── helmet, CORS (wildcard-aware), JSON body limit
 ├── GET  /api/health              (unauthenticated, for the options page)
 └── /api  → x-api-key auth → rate limit
      ├── POST /questions/answer   → QuestionService → ProviderFactory → AIProvider
      └── POST /cache/clear
```

- **Zod validates both directions.** A provider that returns something
  off-contract is reported as a provider failure (502), never passed through.
- **One error vocabulary.** Every SDK's exceptions are translated into a
  `ProviderError` with a code (`authentication`, `rate_limited`, `timeout`,
  `unavailable`, `invalid_response`, `missing_credentials`, `bad_request`) that
  maps to a fixed HTTP status and a `retryable` flag.
- **Timeouts are enforced locally**, so a provider that stops responding cannot
  hold an Express request open. A client that disconnects aborts the provider
  call with it.
- **The cache is an interface** (`AnswerStore`) with an in-memory LRU
  implementation, so Redis or MongoDB can be dropped in without touching the
  service.

---

## AI provider architecture

Every vendor sits behind one interface:

```ts
interface AIProvider {
  getName(): string;
  getModel(): string;
  answerQuestion(request: QuestionRequest, signal?: AbortSignal): Promise<QuestionAnswer>;
}
```

```mermaid
classDiagram
    class AIProvider {
        <<interface>>
        +getName() string
        +getModel() string
        +answerQuestion(request, signal) QuestionAnswer
    }
    AIProvider <|.. OpenAIProvider
    AIProvider <|.. GeminiProvider
    AIProvider <|.. AnthropicProvider
    AIProvider <|.. OpenAICompatibleProvider
    ProviderFactory --> AIProvider : create(id, model)
    QuestionService --> ProviderFactory
```

All four adapters build their prompt from the same `question.prompt.ts`, so
switching provider changes who answers, not what was asked.

| Provider | Id | How output is constrained | Default model |
|---|---|---|---|
| OpenAI | `openai` | Chat Completions with a strict `json_schema` | `gpt-4o-mini` |
| Google Gemini | `gemini` | `responseMimeType` + JSON schema | `gemini-2.0-flash` |
| Anthropic Claude | `anthropic` | Structured outputs (`messages.parse`) validated against the shared Zod schema | `claude-opus-5` |
| OpenAI-compatible | `openai-compatible` | JSON object mode, schema restated in the prompt, lenient parse as a fallback | from `AI_MODEL` |

Defaults are a starting point, not a recommendation — set `AI_MODEL`, or send
`model` with a request, to use anything else.

The Claude adapter checks `stop_reason` before reading content, so a safety
refusal (which arrives as HTTP 200) becomes a clear error rather than a parse
failure. Server-side refusal fallbacks are a natural extension point there if
you want automatic re-routing.

---

## Environment configuration

Copy `server/.env.example` to `server/.env` and fill in the provider you want.
A blank value means "not set", so unused keys can be left empty.

```bash
AI_PROVIDER=openai          # openai | gemini | anthropic | openai-compatible
AI_MODEL=                   # optional override; required for openai-compatible

OPENAI_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=

AI_BASE_URL=                # any OpenAI-compatible endpoint
AI_API_KEY=

PORT=3000
```

The full list — CORS origins, rate limits, timeouts, body size, cache settings,
the optional `API_ACCESS_KEY` shared secret and the reserved `MONGODB_URI` — is
documented inline in `server/.env.example`.

**API keys stay on the backend.** They are never bundled into the extension,
never sent to the page, never returned by `/api/health` and never logged.

---

## Local development

```bash
npm install          # installs both workspaces

npm run dev          # backend on http://localhost:3000 (watch mode)
npm run demo         # demo quiz site on http://localhost:5173
npm run build:extension   # writes extension/dist
```

Per workspace:

```bash
cd server     && npm run dev     # tsx watch
cd extension  && npm run dev     # both Vite builds in watch mode
cd extension  && npm run build   # production build into dist/
```

Other root scripts: `npm test`, `npm run typecheck`, `npm run build`.

### Running the whole stack without an API key

`npm run fake-ai` starts a tiny local OpenAI-compatible endpoint that answers
every question deterministically. Point the backend at it and the full path —
detection, message passing, backend, provider adapter, validation, caching,
answer filling — runs with no credentials at all:

```bash
# server/.env
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://127.0.0.1:4999/v1
AI_API_KEY=local-dev
AI_MODEL=fake-model
```

```bash
npm run fake-ai   # terminal 1
npm run dev       # terminal 2
npm run demo      # terminal 3
```

It always picks the second option, so you can see at a glance whether the
answer reached the page.

---

## Installing the extension

1. `npm run build:extension` (or `npm run dev:extension` while developing).
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select `extension/dist`.
5. Open the extension's **Details → Extension options** to configure it.

The extension ships with access to `localhost` only, so the demo works
immediately. To use it on another site, add that site in the options page —
Chrome will prompt for host access, and the worker then registers a content
script for it. Remove the site to revoke access.

---

## Demo website

`npm run demo` serves `demo/` on <http://localhost:5173> with no dependencies.
It exists so the whole project can be demonstrated without depending on anyone
else's site.

It contains seven questions in deliberately different DOM shapes, plus:

- **Load two more questions** — inserts questions ~900 ms after load, so the
  MutationObserver path is exercised rather than the initial scan.
- **Re-render all questions** — destroys and rebuilds every question node the
  way a React re-render does; the extension should recognise them and stay
  quiet.
- Navigation, an advert block and a footer, all containing question-shaped text
  that must be ignored.

---

## API documentation

### `POST /api/questions/answer`

Headers: `Content-Type: application/json`, plus `x-api-key` when
`API_ACCESS_KEY` is configured.

```json
{
  "question": "What is the time complexity of binary search?",
  "type": "multiple_choice",
  "options": ["O(n)", "O(log n)", "O(n²)", "O(1)"],
  "context": "optional supporting code, maths or passage",
  "source": { "url": "https://example.com/quiz", "title": "Practice quiz" },
  "provider": "anthropic",
  "model": "claude-opus-5"
}
```

Only `question` is required. `type` defaults to `unknown`; `provider` and
`model` override the server defaults for that one request.

```json
{
  "data": {
    "answer": "O(log n)",
    "explanation": "Binary search repeatedly halves the search space.",
    "confidence": 0.97,
    "reasoningSummary": "Standard complexity result for a halving search.",
    "provider": "openai",
    "model": "gpt-4o-mini"
  },
  "meta": { "cached": false }
}
```

`reasoningSummary` is a short learner-facing note. No provider is asked for, and
none returns, raw chain-of-thought.

### `GET /api/health`

```json
{
  "status": "ok",
  "uptimeSeconds": 42,
  "activeProvider": "openai",
  "providers": ["openai"],
  "allProviders": [{ "id": "openai", "label": "OpenAI", "configured": true, "defaultModel": "gpt-4o-mini" }]
}
```

### `POST /api/cache/clear`

Empties the backend answer cache. Returns `{ "data": { "cleared": true } }`.

### Errors

Every failure uses the same envelope:

```json
{ "error": { "code": "rate_limited", "message": "…", "provider": "openai", "retryable": true } }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` / `invalid_json` / `bad_request` | The request was malformed |
| 401 | `unauthorized` | `x-api-key` missing or wrong |
| 403 | `origin_not_allowed` | CORS origin rejected |
| 413 | `payload_too_large` | Body over `MAX_REQUEST_BODY` |
| 429 | `rate_limited` | Local rate limit, or the provider's |
| 502 | `authentication` / `invalid_response` | Provider rejected us, or broke the contract |
| 503 | `missing_credentials` / `unavailable` | Provider not configured, or down |
| 504 | `timeout` | Provider exceeded `PROVIDER_TIMEOUT_MS` |

---

## Security

Implemented:

- Helmet, explicit CORS allow-list (with a trailing-wildcard form so the
  development extension id does not have to be pinned), rate limiting, Zod
  validation on input and output, and a request body size limit.
- Optional shared-secret authentication, compared in constant time.
- API keys server-side only; never in the extension bundle, never logged —
  pino redacts `authorization`, `x-api-key` and `cookie`.
- No `eval`, no `new Function`, no remote code, no page-supplied JavaScript
  executed, no CSP relaxation. The extension declares its own restrictive CSP.
- Messages from content scripts are re-validated in the service worker, and
  `settings:save` is refused if it arrives from a tab.
- Page text is fenced into labelled blocks in the prompt and the system prompt
  states that page content is data, not instructions, so a page containing
  "ignore previous instructions" is quoted material rather than a command.

Deliberately **not** implemented: CAPTCHA solving, anti-bot evasion, proctoring
bypass, browser-security bypass, or anything that manipulates automation
detection. The project works because it is a browser extension, not because it
is pretending not to be one.

---

## Privacy

The extension sends the smallest thing that can answer the question:

```
relevant DOM content → question extraction → minimal context → backend → AI provider
```

What is transmitted, and nothing else:

| Field | Contents |
|---|---|
| `question` | The prompt text, with option labels and numbering removed |
| `options` | The answer options, when the question has any |
| `context` | Code, maths or a shared passage from the same container, capped by **Maximum context length** (default 2000 characters, `0` disables it entirely) |
| `source` | Page URL and title |

The full page is never sent. Navigation, adverts and footers are excluded
before extraction. Nothing is stored on disk by the backend; the answer cache is
in memory and expires. Settings live in `chrome.storage.sync`.

**The AI provider you select will process the question and context you send.**
That is inherent to the design — choose the provider accordingly, and set
maximum context length to `0` if you would rather send nothing but the question.

---

## Testing

```bash
npm test                      # both workspaces
npm run test:coverage         # with a coverage report
npm test --workspace @ai-browser-assistant/server
npm test --workspace @ai-browser-assistant/extension
```

**185 tests**, no network access and no credentials required.

| Area | Tests | What they cover |
|---|---|---|
| `detector.test.ts` | 15 | Every question shape on the real `demo/index.html`; option extraction from each markup style; type classification; ignoring navigation, adverts and footers; stable fingerprints across a re-render; pages with no questions (prose, a login form, an empty document) |
| `content.test.ts` | 22 | Normalisation, fingerprinting, MathML conversion, option matching, answer application into radios, selects and text fields |
| `observer.test.ts` | 11 | Debounce coalescing, mutation filtering, the attribute allow-list, start/stop, scan-on-demand |
| `content-script.test.ts` | 14 | The content script driven end to end in a fake page: what it sends, deduplication across a re-render, auto-fill on and off, that it adds no UI, retry on network failure, and ignoring a message the page forged |
| `messaging.test.ts` | 17 | The round trip through the real service worker: content script → worker → backend → worker → content script, worker-side re-validation, refusing `settings:save` from a tab, request coalescing, cache hits, settings broadcast, dynamic script registration |
| `options.test.tsx` | 13 | The options page rendered for real: loading and saving settings through the worker, connection test, cache clearing, and host-permission requests from a genuine click |
| `demo.test.ts` | 3 | The demo page's own script plus the detector: late-arriving questions found, re-renders producing identical fingerprints |
| `api.test.ts` (server) | 30 | The endpoint with a stub provider: valid requests, missing/short question, oversized context and body, malformed JSON, unknown provider, per-request overrides, every provider error code and its status, caching, cache clearing, the shared secret, rate limiting, CORS |
| `providers.test.ts` (server) | 41 | All four adapters against a **stubbed `fetch` with the real SDKs** — success, 401, 429, 5xx, connection failure, timeout, truncated output, malformed JSON, Claude's refusal stop reason, and the factory's credential checks |

Coverage: **87% of statements** in the extension, **84%** in the backend.

Testing the adapters through the real SDKs rather than mocking them is
deliberate: the part most likely to break when a dependency moves is the
translation of each SDK's own error types, and a mock would assert nothing
about that.

### Testing it by hand

Everything the suite cannot reach - loading into Chrome, the demo page, failure
handling, a real provider - is a stage-by-stage checklist in
[TESTING.md](TESTING.md).

### Not covered by the suite

- `server/src/index.ts` — process bootstrap and signal handling; exercised by
  running it, not by a unit test.
- `extension/src/options/main.tsx` — the four-line React root mount.
- **Loading the extension into Chrome.** `chrome://extensions` cannot be
  driven by automation, so *Load unpacked* is a manual step.
- **Live provider calls.** No test spends money or needs a key. Point the
  backend at `npm run fake-ai` to exercise the real HTTP path.

---

## Docker

```bash
docker compose up                        # backend only
docker compose --profile persistence up  # backend + MongoDB (reserved for later)
```

The image is a multi-stage build that runs as the non-root `node` user and has
a health check against `/api/health`. It reads `server/.env`.

Docker is never required for development — `npm run dev` is enough.

---

## Adding a new AI provider

Four steps, none of which touch the detector, the extension or the transport:

1. Write `server/src/providers/<vendor>.provider.ts` implementing `AIProvider`.
   Build the prompt with `buildUserPrompt`, and translate the SDK's errors into
   `ProviderError`.
2. Add the id to `providerIdSchema` in `question.schema.ts`.
3. Register it in `REGISTRY` in `provider.factory.ts` (label, default model,
   credential check, builder).
4. Add its credentials to `envSchema` in `config/env.ts` and to `.env.example`.

The options page picks the new provider up from `PROVIDER_LABELS` in
`extension/src/shared/constants.ts`.

---

## Project structure

```
ai-browser-assistant/
├── extension/
│   ├── src/
│   │   ├── content/      detector, extractor, observer, interaction, normalize
│   │   ├── background/   service-worker, settings, cache, backend-client
│   │   ├── options/      React options page
│   │   └── shared/       types, messages, constants
│   ├── public/           manifest.json, icons
│   └── tests/
├── server/
│   ├── src/
│   │   ├── controllers/  question, health
│   │   ├── question/     schema, prompt, service
│   │   ├── providers/    interface, factory, four adapters, errors
│   │   ├── cache/        AnswerStore + in-memory LRU
│   │   ├── middleware/   security, error handling
│   │   ├── config/       env, logger
│   │   └── app.ts
│   ├── tests/
│   ├── Dockerfile
│   └── .env.example
├── demo/                 local practice quiz site
├── scripts/              dependency-free static server for the demo
├── docker-compose.yml
└── package.json          npm workspaces root
```

---

## Future improvements

- **Persistence.** `MONGODB_URI` and the `mongo` compose profile are already
  reserved; the `AnswerStore` interface is the seam for it. Question history,
  practice sessions, saved explanations and usage statistics all fit behind it.
- **Redis cache** shared across backend instances, same interface.
- **Streaming answers** to the service worker for long explanations.
- **A popup** showing the answers found on the current page, for when you want
  to read the explanation rather than fill the form.
- **Per-site extraction profiles** for practice sites with unusual markup.
- **Provider comparison mode** — ask two providers and show where they differ,
  which the shared prompt builder already makes meaningful.
