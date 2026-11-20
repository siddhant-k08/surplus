import type { LlmClient, LlmResult } from "./pipeline";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export interface AnthropicOptions {
    apiKey: string;
    model: string;
    maxTokens?: number;
    apiVersion?: string;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    maxRetries?: number;
    timeoutMs?: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 529]);

/** Extracts text blocks and token usage. Truncated or refused answers are errors, never partial results. */
export function parseMessageResponse(json: unknown): LlmResult {
    if (typeof json !== "object" || json === null) throw new Error("response is not an object");
    const r = json as Record<string, unknown>;
    if (r.stop_reason === "max_tokens") throw new Error("model output was cut off (max_tokens); raise maxTokens");
    if (r.stop_reason === "refusal") throw new Error("model declined this request");
    const blocks = Array.isArray(r.content) ? r.content : [];
    const text = blocks
        .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
        .map((b) => b.text)
        .join("");
    const usage = (r.usage ?? {}) as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    if (text === "") throw new Error("response had no text content");
    return { text, inputTokens: n(usage.input_tokens), outputTokens: n(usage.output_tokens) };
}

export function createAnthropicClient(opts: AnthropicOptions): LlmClient {
    if (!opts.apiKey) throw new Error("ANTHROPIC_API_KEY is missing");
    const fetchImpl = opts.fetchImpl ?? fetch;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const maxRetries = opts.maxRetries ?? 2;

    return {
        async complete(system: string, user: string): Promise<LlmResult> {
            const body = JSON.stringify({
                model: opts.model,
                max_tokens: opts.maxTokens ?? 16_000,
                system,
                messages: [{ role: "user", content: user }],
            });
            for (let attempt = 0; ; attempt++) {
                const res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
                    method: "POST",
                    headers: {
                        "x-api-key": opts.apiKey,
                        "anthropic-version": opts.apiVersion ?? "2026-10-21",
                        "content-type": "application/json",
                    },
                    body,
                    signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
                });
                if (res.ok) return parseMessageResponse(await res.json());
                const detail = (await res.text().catch(() => "")).slice(0, 300);
                if (RETRYABLE.has(res.status) && attempt < maxRetries) {
                    const after = Number(res.headers.get("retry-after"));
                    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** attempt);
                    continue;
                }
                throw new Error(`Anthropic API HTTP ${res.status}: ${detail}`);
            }
        },
    };
}