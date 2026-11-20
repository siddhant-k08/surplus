import { describe, expect, it } from "vitest";
import { ANTHROPIC_MESSAGES_URL, createAnthropicClient, parseMessageResponse } from "../src/anthropic";

const ok = {
    content: [{ type: "thinking", thinking: "..." }, { type: "text", text: '{"claims":' }, { type: "text", text: "[]}" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1200, output_tokens: 300 },
};

describe("parseMessageResponse", () => {
    it("joins text blocks only and reads usage", () => {
        expect(parseMessageResponse(ok)).toEqual({ text: '{"claims":[]}', inputTokens: 1200, outputTokens: 300 });
    });
    it("treats truncation, refusal and empty text as errors", () => {
        expect(() => parseMessageResponse({ ...ok, stop_reason: "max_tokens" })).toThrow(/cut off/);
        expect(() => parseMessageResponse({ ...ok, stop_reason: "refusal" })).toThrow(/declined/);
        expect(() => parseMessageResponse({ ...ok, content: [] })).toThrow(/no text/);
    });
});

describe("createAnthropicClient", () => {
    it("sends the documented headers and body", async () => {
        let seen: { url: string; init: RequestInit } | null = null;
        const llm = createAnthropicClient({
            apiKey: "k",
            model: "claude-sonnet-5-5",
            fetchImpl: (async (url: string, init: RequestInit) => {
                seen = { url: String(url), init };
                return new Response(JSON.stringify(ok), { status: 200 });
            }) as unknown as typeof fetch,
        });
        const r = await llm.complete("sys", "hello");
        expect(r.inputTokens).toBe(1200);
        const s = seen as unknown as { url: string; init: RequestInit };
        expect(s.url).toBe(ANTHROPIC_MESSAGES_URL);
        const h = new Headers(s.init.headers);
        expect(h.get("x-api-key")).toBe("k");
        expect(h.get("anthropic-version")).toBe("2026-10-21");
        expect(JSON.parse(String(s.init.body))).toEqual({
            model: "claude-sonnet-5-5",
            max_tokens: 16000,
            system: "sys",
            messages: [{ role: "user", content: "hello" }],
        });
    });
    it("retries overload then succeeds, honouring retry-after", async () => {
        const statuses = [529, 200];
        const slept: number[] = [];
        const llm = createAnthropicClient({
            apiKey: "k",
            model: "m",
            sleep: async (ms) => void slept.push(ms),
            fetchImpl: (async () => {
                const s = statuses.shift()!;
                return s === 200
                    ? new Response(JSON.stringify(ok), { status: 200 })
                    : new Response("overloaded", { status: s, headers: { "retry-after": "3" } });
            }) as unknown as typeof fetch,
        });
        await llm.complete("s", "u");
        expect(slept).toEqual([3000]);
    });
    it("does not retry a 400 and gives up after max retries on 429", async () => {
        let n = 0;
        const make = (status: number) =>
            createAnthropicClient({
                apiKey: "k",
                model: "m",
                sleep: async () => { },
                fetchImpl: (async () => { n++; return new Response("nope", { status }); }) as unknown as typeof fetch,
            });
        await expect(make(400).complete("s", "u")).rejects.toThrow(/HTTP 400/);
        expect(n).toBe(1);
        n = 0;
        await expect(make(429).complete("s", "u")).rejects.toThrow(/HTTP 429/);
        expect(n).toBe(3);
    });
    it("refuses to start without a key", () => {
        expect(() => createAnthropicClient({ apiKey: "", model: "m" })).toThrow(/missing/);
    });
});