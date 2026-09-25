/**
 * Development harness: the real pipeline, without the extension installed.
 *
 * Imports the same `detector` and `interaction` modules the content script
 * uses, but talks to the backend directly with `fetch` instead of going
 * through the service worker. Paste the built bundle into any page's console
 * to see what the extension would detect there, and why.
 *
 * Build with `npm run build:harness`, then paste `dist-dev/live-demo.js`.
 * It is never part of the extension bundle.
 */
import { detectQuestions } from '../content/detector';
import { applyAnswer } from '../content/interaction';
import type { QuestionAnswer } from '../shared/types';

interface HarnessOptions {
  backendUrl?: string;
  /** Fill answers into the page. */
  fill?: boolean;
  maxContextLength?: number;
  /** Shared secret, when the backend sets API_ACCESS_KEY. */
  apiKey?: string;
}

interface HarnessResult {
  question: string;
  type: string;
  options?: string[] | undefined;
  answer?: string;
  filled?: string;
  error?: string;
}

async function run(options: HarnessOptions = {}): Promise<HarnessResult[]> {
  const backendUrl = options.backendUrl ?? 'http://localhost:3000';
  const fill = options.fill ?? true;

  const detected = detectQuestions(document, {
    maxContextLength: options.maxContextLength ?? 2000,
    url: location.href,
    title: document.title,
  });

  console.log(`[harness] detected ${detected.length} question(s)`);
  const results: HarnessResult[] = [];

  for (const question of detected) {
    const result: HarnessResult = {
      question: question.request.question,
      type: question.request.type,
      options: question.request.options,
    };

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (options.apiKey) headers['x-api-key'] = options.apiKey;

      const response = await fetch(`${backendUrl}/api/questions/answer`, {
        method: 'POST',
        headers,
        body: JSON.stringify(question.request),
      });

      const payload = (await response.json()) as {
        data?: QuestionAnswer;
        error?: { message?: string };
      };

      if (!response.ok || !payload.data) {
        result.error = payload.error?.message ?? `HTTP ${response.status}`;
      } else {
        result.answer = payload.data.answer;
        if (fill) result.filled = applyAnswer(question.container, payload.data);
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    results.push(result);
    console.log(`[harness] ${result.answer ?? result.error} <- ${result.question.slice(0, 60)}`);
  }

  console.table(results);
  return results;
}

// Exposed so it can be re-run from the console after changing the page.
(window as unknown as { aiHarness: typeof run }).aiHarness = run;

export { run };
