/**
 * Worker LLM proxy: forwards Nvidia chat requests from the GH Actions
 * worker through Vercel, where Nvidia's API is reachable.
 *
 * POST /api/labs/llm
 *   headers: { x-labs-worker-token: <LABS_AUTOPILOT_TOKEN> }
 *   body: { messages, model?, temperature?, max_tokens?, jsonMode?, timeoutMs? }
 *   returns: { ok: true, content, model, attempts } | { ok: false, error, status? }
 *
 * The worker paces its own calls (1.5s gap = 40 RPM) before hitting this.
 */

import { NextRequest } from 'next/server';

import { nvidiaChat, hasNvidiaKey, NVIDIA_MODEL_PRIMARY } from '@/lib/labs/nvidia';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface LLMRequestBody {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return Response.json(auth.body, { status: auth.status });

  if (!hasNvidiaKey()) {
    return Response.json({ ok: false, error: 'No NVIDIA_API_KEY configured' }, { status: 500 });
  }

  let body: LLMRequestBody;
  try {
    body = (await req.json()) as LLMRequestBody;
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json({ ok: false, error: 'messages array required' }, { status: 400 });
  }

  const model = body.model || NVIDIA_MODEL_PRIMARY;
  const timeoutMs = Math.min(body.timeoutMs ?? 55_000, 55_000);

  try {
    const result = await nvidiaChat({
      models: [model],
      messages: body.messages,
      temperature: body.temperature ?? 0.4,
      max_tokens: body.max_tokens ?? 800,
      jsonMode: body.jsonMode ?? false,
      timeoutMs,
      // Retries are owned by the rate-limited worker layer; doing a single
      // attempt here avoids multiplicative retry amplification (worker
      // retries × server retries) against the 40 RPM Nvidia budget.
      maxRetriesPerKey: 1,
    });

    return Response.json({
      ok: true,
      content: result.content,
      model: result.model,
      attempts: result.attempts,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const underlying = (err as { status?: number }).status ?? 0;
    // Surface the real Nvidia status in the body AND mirror it as the HTTP
    // status (clamped to a valid 4xx/5xx) so the worker can distinguish
    // non-retryable 400/401 from retryable 429/5xx instead of always seeing 502.
    const httpStatus = underlying >= 400 && underlying <= 599 ? underlying : 502;
    return Response.json({ ok: false, error: message, status: underlying || httpStatus }, { status: httpStatus });
  }
}
