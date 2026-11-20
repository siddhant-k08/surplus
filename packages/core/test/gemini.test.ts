import { describe, expect, it } from "vitest";
import { createGeminiClient, geminiUrl, parseGeminiResponse } from "../src/gemini";

const ok = {
    candidates: [
        {
            content: { role: "model", parts: [{ text: "thinking...", thought: true }, { text: '{"claims":' }, { text: "[]}" }] },
            finishReason: "STOP",
        },
    ],
    usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300, thoughtsTokenCount: 500, totalTokenCount: 2000 },
};

describe("parseGeminiResponse", () => {
    it("joins non-thought text and bills thinking as output", () => {
        expect(parseGeminiResponse(ok)).toEqual({ text: '{"claims":[]}', inputTokens: 1200, outputTokens: 800 });
    });
    it("treats blocks, truncation, other stops and empty text as errors", () => {
        expect(() => parseGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } })).toThrow(/blocked: SAFETY/);
        const withReason = (finishReason: string) => ({ ...ok, candidates: [{ ...ok.candidates[0], finishReason }] });
        expect(() => parseGeminiResponse(withReason("MAX_TOKENS"))).toThrow(/cut off/);
        expect(() => parseGeminiResponse(withReason("RECITATION"))).toThrow(/RECITATION/);
        expect(() => parseGeminiResponse({ candidates: [] })).toThrow(/no candidates/);
        expect(() => parseGeminiResponse({ candidates: [{ content: { parts: [{ text: "x", thought: true }] }, finishReason: "STOP" }] })).toThrow(/no text/);
    });
});

describe("createGeminiClient", () => {
    it("rejects odd model ids", () => {
        expect(() => geminiUrl("../evil")).toThrow();
        expect(geminiUrl("gemini-x.y-flash")).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x.y-flash:generateContent");
    });
    it("sends the key in the header, not the URL, with system instruction and output cap", async () => {
        let seen: { url: string; init: RequestInit } | null = null;
        const llm = createGeminiClient({
            apiKey: "secret",
            model: "gemini-test",
            fetchImpl: (async (url: string, init: RequestInit) => {
                seen = { url: String(url), init };
                return new Response(JSON.stringify(ok), { status: 200 });
            }) as unknown as typeof fetch,
        });
        const r = await llm.complete("sys", "hello");
        expect(r.outputTokens).toBe(800);
        const s = seen as unknown as { url: string; init: RequestInit };
        expect(s.url).not.toContain("secret");
        expect(new Headers(s.init.headers).get("x-goog-api-key")).toBe("secret");
        expect(JSON.parse(String(s.init.body))).toEqual({
            systemInstruction: { parts: [{ text: "sys" }] },
            contents: [{ role: "user", parts: [{ text: "hello" }] }],
            generationConfig: { maxOutputTokens: 16000 },
        });
    });
    it("retries 503 with backoff, then gives up; never retries 400", async () => {
        let n = 0;
        const slept: number[] = [];
        const make = (status: number) =>
            createGeminiClient({
                apiKey: "k",
                model: "m",
                sleep: async (ms) => void slept.push(ms),
                fetchImpl: (async () => { n++; return new Response("busy", { status }); }) as unknown as typeof fetch,
            });
        await expect(make(503).complete("s", "u")).rejects.toThrow(/HTTP 503/);
        expect(n).toBe(4);
        expect(slept).toEqual([2000, 4000, 8000]);
        n = 0;
        await expect(make(400).complete("s", "u")).rejects.toThrow(/HTTP 400/);
        expect(n).toBe(1);
    });
    it("refuses to start without a key", () => {
        expect(() => createGeminiClient({ apiKey: "", model: "m" })).toThrow(/missing/);
    });
});