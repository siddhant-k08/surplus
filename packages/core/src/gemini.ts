import type { LlmClient, LlmResult } from "./pipeline";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiOptions {
    apiKey: string;
    model: string; // e.g. the Flash id listed at ai.google.dev/gemini-api/docs/models
    maxOutputTokens?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    maxRetries?: number;
    timeoutMs?: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function geminiUrl(model: string): string {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(model)) throw new Error(`unexpected Gemini model id: ${model}`);
    return `${GEMINI_BASE_URL}/${model}:generateContent`;
}

/**
 * Extracts answer text (thought parts excluded) and token usage. Blocked, truncated or otherwise
 * unfinished answers are errors. Output tokens include thinking tokens, which Google bills at the output rate.
 */
export function parseGeminiResponse(json: unknown): LlmResult {
    if (typeof json !== "object" || json === null) throw new Error("response is not an object");
    const r = json as Record<string, unknown>;
    const feedback = r.promptFeedback as { blockReason?: unknown } | undefined;
    if (feedback?.blockReason) throw new Error(`prompt blocked: ${String(feedback.blockReason)}`);

    const cands = Array.isArray(r.candidates) ? r.candidates : [];
    const c = cands[0] as { content?: { parts?: unknown }; finishReason?: unknown } | undefined;
    if (!c) throw new Error("response had no candidates");
    if (c.finishReason === "MAX_TOKENS") throw new Error("model output was cut off (MAX_TOKENS); raise maxOutputTokens");
    if (c.finishReason !== undefined && c.finishReason !== "STOP") {
        throw new Error(`model stopped with ${String(c.finishReason)}`);
    }
    const parts = Array.isArray(c.content?.parts) ? (c.content?.parts as unknown[]) : [];
    const text = parts
        .filter((p): p is { text: string } => {
            if (typeof p !== "object" || p === null) return false;
            const q = p as { text?: unknown; thought?: unknown };
            return typeof q.text === "string" && q.thought !== true;
        })
        .map((p) => p.text)
        .join("");
    if (text === "") throw new Error("response had no text content");

    const u = (r.usageMetadata ?? {}) as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
        text,
        inputTokens: n(u.promptTokenCount),
        outputTokens: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount),
    };
}

export function createGeminiClient(opts: GeminiOptions): LlmClient {
    if (!opts.apiKey) throw new Error("GEMINI_API_KEY is missing");
    const url = geminiUrl(opts.model);
    const fetchImpl = opts.fetchImpl ?? fetch;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const maxRetries = opts.maxRetries ?? 3;

    return {
        async complete(system: string, user: string): Promise<LlmResult> {
            const body = JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents: [{ role: "user", parts: [{ text: user }] }],
                generationConfig: { maxOutputTokens: opts.maxOutputTokens ?? 16_000 },
            });
            for (let attempt = 0; ; attempt++) {
                const res = await fetchImpl(url, {
                    method: "POST",
                    headers: { "x-goog-api-key": opts.apiKey, "content-type": "application/json" },
                    body,
                    signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
                });
                if (res.ok) return parseGeminiResponse(await res.json());
                const detail = (await res.text().catch(() => "")).slice(0, 300);
                if (RETRYABLE.has(res.status) && attempt < maxRetries) {
                    const after = Number(res.headers.get("retry-after"));
                    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** attempt);
                    continue;
                }
                throw new Error(`Gemini API HTTP ${res.status}: ${detail}`);
            }
        },
    };
}