import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
    loadAllTokens,
    crossCheck,
    BASE_REGISTRY,
    EdgarClient,
    EdgarDocProvider,
    createAnthropicClient,
    createGeminiClient,
    researchBrief,
    estimateCostUsd,
    usdToUsdcMinor,
    type CandidateCompany,
    type LlmClient,
    type ThemeSpec,
} from "../packages/core/src/index";

const DRY_RUN = process.argv.includes("--dry-run");
const MAX_TOKENS = 16_000;

const THEMES: ThemeSpec[] = [
    {
        id: "ai-compute",
        name: "AI compute and cloud infrastructure",
        description: "Revenue tied to data center, AI accelerator, GPU, cloud computing or AI infrastructure demand",
        keywords: ["AI", "artificial intelligence", "data center", "data centers", "datacenter", "datacenters", "accelerator", "accelerators", "GPU", "GPUs", "TPU", "TPUs", "cloud", "compute"],
    },
    {
        id: "platform-giants",
        name: "Consumer and advertising platforms",
        description: "Revenue from advertising, app stores, e-commerce marketplaces, subscriptions or devices used by large consumer audiences",
        keywords: ["advertising", "ads", "app store", "apps", "subscription", "subscriptions", "e-commerce", "marketplace", "online stores", "devices", "consumer"],
    },
    {
        id: "longevity-biotech",
        name: "Longevity biotech",
        description: "Therapeutics or research aimed at aging, healthspan or age-related disease",
        keywords: ["aging", "ageing", "longevity", "healthspan", "lifespan", "age-related", "therapeutic", "therapeutics", "drug", "drugs", "disease", "diseases", "biotech", "biotechnology"],
    },
];

function env(name: string): string {
    const v = process.env[name];
    if (v === undefined || v.trim() === "") throw new Error(`${name} is not set in .env`);
    return v.trim();
}
function envNumber(name: string): number {
    const n = Number(env(name));
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
    return n;
}

/**
 * Stops calls that could push spend past the cap. Anthropic documents about 2.5 characters per token for the
 * current tokenizer; the guard assumes 2 so it errs on the side of stopping.
 */
function budgeted(inner: LlmClient, capUsd: number, inPerM: number, outPerM: number): LlmClient & { spentUsd: () => number } {
    let spent = 0;
    return {
        spentUsd: () => spent,
        async complete(system, user) {
            const worst = (((system.length + user.length) / 2) * inPerM + MAX_TOKENS * outPerM) / 1_000_000;
            if (spent + worst > capUsd) {
                throw new Error(`budget: next call could cost up to $${worst.toFixed(3)}, spent $${spent.toFixed(3)} of $${capUsd}`);
            }
            const r = await inner.complete(system, user);
            spent += (r.inputTokens * inPerM + r.outputTokens * outPerM) / 1_000_000;
            return r;
        },
    };
}

async function main(): Promise<void> {
    if (existsSync(".env")) process.loadEnvFile(".env");

    console.log("Loading the token list and checking it against the Base registry...");
    const { tokens } = await loadAllTokens();
    const check = crossCheck(tokens);
    const names = new Map(BASE_REGISTRY.map((r) => [r.address.toLowerCase(), r.name]));
    const companies: CandidateCompany[] = check.trusted.map((t) => ({
        asset: t.address,
        symbol: t.symbol,
        name: names.get(t.address.toLowerCase()) ?? t.name,
    }));
    console.log(`Trusted tokens: ${companies.map((c) => c.symbol).join(", ")}`);
    if (companies.length === 0) throw new Error("No trusted tokens, stopping");

    const edgar = new EdgarClient({ userAgent: env("SEC_USER_AGENT") });
    const docs = new EdgarDocProvider(edgar);

    const prompts: number[] = [];
    let llm: LlmClient & { spentUsd: () => number };
    let pricing = { inputPerMTokUsd: 0, outputPerMTokUsd: 0 };
    if (DRY_RUN) {
        llm = {
            spentUsd: () => 0,
            async complete(system, user) {
                prompts.push(system.length + user.length);
                return { text: '{"claims":[],"fits":[]}', inputTokens: 0, outputTokens: 0 };
            },
        };
    } else {
        pricing = { inputPerMTokUsd: envNumber("PRICE_INPUT_PER_MTOK_USD"), outputPerMTokUsd: envNumber("PRICE_OUTPUT_PER_MTOK_USD") };
        const provider = (process.env.LLM_PROVIDER ?? "anthropic").trim();
        const model = env("RESEARCH_MODEL");
        let inner: LlmClient;
        if (provider === "gemini") inner = createGeminiClient({ apiKey: env("GEMINI_API_KEY"), model, maxOutputTokens: MAX_TOKENS });
        else if (provider === "anthropic") inner = createAnthropicClient({ apiKey: env("ANTHROPIC_API_KEY"), model, maxTokens: MAX_TOKENS });
        else throw new Error(`LLM_PROVIDER must be anthropic or gemini, got ${provider}`);
        console.log(`Model: ${provider} ${model}`);
        llm = budgeted(inner, envNumber("RESEARCH_MAX_USD"), pricing.inputPerMTokUsd, pricing.outputPerMTokUsd);
    }

    const briefId = `brief-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    console.log(`\nFetching SEC filings and ${DRY_RUN ? "building prompts (DRY RUN, no model calls)" : "calling the model"}...`);
    const r = await researchBrief(
        { briefId, themes: THEMES, companies, now: new Date(), disclaimer: "Informational research only. Not investment advice. Simulated where labeled." },
        { docs, llm },
    );

    console.log(`\nSEC requests made: ${edgar.requests}`);
    if (docs.warnings.length > 0) {
        console.log("SEC warnings:");
        for (const w of docs.warnings) console.log(`  - ${w}`);
    }

    if (DRY_RUN) {
        console.log("\nPrompt sizes per theme (characters, and a rough token estimate at 2.5 characters per token):");
        prompts.forEach((chars, i) => console.log(`  ${THEMES[i]?.id ?? i}: ${chars} chars, about ${Math.round(chars / 2.5)} tokens`));
        console.log("\nDry run complete. Nothing was sent to the model.");
        return;
    }

    for (const th of r.brief.themes) {
        console.log(`\n== ${th.themeId} ${th.gap ? `(GAP: ${th.gapReason})` : ""}`);
        for (const f of th.fits) {
            console.log(`  ${f.symbol.padEnd(7)} fit ${f.fit}/5, evidence ${f.evidence}/5`);
            for (const id of f.claimIds) {
                const c = th.claims.find((x) => x.id === id);
                if (!c) continue;
                console.log(`    [${c.type}] ${c.text}`);
                for (const q of c.quotes ?? []) console.log(`      "${q.text}" (${q.sourceId})`);
            }
        }
    }

    console.log(`\nValidation issues: ${r.issues.length}`);
    for (const i of r.issues) console.log(`  - ${i.path} ${i.rule}: ${i.message}`);
    console.log(`Dropped by verification: ${r.rejected.length}`);
    for (const x of r.rejected) console.log(`  - ${x}`);

    const usd = estimateCostUsd(r.usage, pricing);
    const minor = usdToUsdcMinor(usd);
    console.log(`\nModel calls ${r.usage.calls}, input tokens ${r.usage.inputTokens}, output tokens ${r.usage.outputTokens}`);
    console.log(`Model cost $${usd.toFixed(4)} -> ${minor} USDC minor units (rounded up), to be booked as an llm cost`);

    mkdirSync("docs/briefs", { recursive: true });
    const path = `docs/briefs/${briefId}.json`;
    writeFileSync(
        path,
        JSON.stringify(
            { provider: process.env.LLM_PROVIDER ?? "anthropic", model: env("RESEARCH_MODEL"), brief: r.brief, issues: r.issues, rejected: r.rejected, usage: r.usage, costUsd: usd, costUsdcMinor: minor.toString(), secWarnings: docs.warnings },
            null,
            2,
        ),
    );
    console.log(`Saved ${path}`);
}

main().catch((e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
});