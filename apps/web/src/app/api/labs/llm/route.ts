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
    });

    return Response.json({
      ok: true,
      content: result.content,
      model: result.model,
      attempts: result.attempts,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status ?? 502;
    return Response.json({ ok: false, error: message, status }, { status: 502 });
  }
}
