/**
 * A tiny OpenAI-compatible endpoint for running the whole stack without
 * credentials. It answers every question deterministically, which makes it
 * useful for demonstrating the extension, exercising the plumbing, and
 * checking that the OpenAI-compatible adapter really is endpoint-agnostic.
 *
 *   node scripts/fake-ai-endpoint.mjs
 *
 * Then in server/.env:
 *   AI_PROVIDER=openai-compatible
 *   AI_BASE_URL=http://127.0.0.1:4999/v1
 *   AI_API_KEY=local-dev
 *   AI_MODEL=fake-model
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_AI_PORT ?? 4999);
const MODEL = 'fake-model';

/** Pick an answer from the prompt the backend built. */
function answerFor(userPrompt) {
  const options = /<options>\n([\s\S]*?)\n<\/options>/.exec(userPrompt);

  if (options) {
    // Always the second option, so tests and demos have something to assert.
    const lines = options[1].split('\n');
    const chosen = (lines[1] ?? lines[0] ?? '').replace(/^[A-Z]\.\s*/, '');
    return {
      answer: chosen,
      explanation: `The local fake endpoint always picks the second option ("${chosen}").`,
      confidence: 0.42,
      reasoningSummary: 'Deterministic choice, not a real judgement.',
    };
  }

  // Open questions have nothing to choose from, so echo back what arrived.
  // Seeing your own question come back is the point: it proves the extraction
  // and the round trip worked, and makes it obvious no model was involved.
  const type = /Question type:\s*(\S+)/.exec(userPrompt)?.[1] ?? 'unknown';
  const question = /<question>\n([\s\S]*?)\n<\/question>/.exec(userPrompt)?.[1] ?? '';
  const echo = question.replace(/\s+/g, ' ').trim().slice(0, 120);

  return {
    answer: `[no model] The backend received your ${type} question: "${echo}"`,
    explanation:
      'This is the local fake endpoint, not an AI. It echoes the question back so you can see the round trip worked. Configure a real provider in server/.env for an actual answer.',
    confidence: 0,
    reasoningSummary: 'Echo only - no reasoning took place.',
  };
}

const server = createServer((req, res) => {
  if (!req.url?.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `No route for ${req.url}` } }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });

  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
      return;
    }

    const userPrompt = payload.messages?.find((message) => message.role === 'user')?.content ?? '';
    console.log(`answering: ${userPrompt.slice(0, 80).replace(/\s+/g, ' ')}…`);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: payload.model ?? MODEL,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify(answerFor(userPrompt)) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    );
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Fake OpenAI-compatible endpoint on http://127.0.0.1:${PORT}/v1`);
});
