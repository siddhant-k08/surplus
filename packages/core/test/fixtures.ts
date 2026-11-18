import { parseUsdc as u } from "../src/money";
import type { MandateTerms } from "../src/mandate";

export const addr = (c: string): string => `0x${c.repeat(40)}`;
export const NVDA = addr("a");
export const MSFT = addr("b");
export const META = addr("c");
export const AMZN = addr("d");
export const TSLA = addr("e");

export function baseTerms(over: Partial<MandateTerms> = {}): MandateTerms {
    return {
        eligible: [NVDA, MSFT, META, AMZN],
        themes: [
            { id: "ai-compute", targetBps: 5000 },
            { id: "platform-giants", targetBps: 3000 },
            { id: "longetivity-biotech", targetBps: 2000 },
        ],
        maxCompanyBps: 4000,
        investShareBps: 5000,
        maxTradeUsdc: u("1.00"),
        minTradeUsdc: u("0.10"),
        reserveTargetUsdc: u("2.00"),
        maxSlippageBps: 100,
        driftToleranceBps: 100,
        approvalExpirySeconds: 600,
        ...over,
    };
}