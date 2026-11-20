import { it, expect } from "vitest";
import * as core from "../src/index";

it("exports the public API", () => {
    for (const name of [
        "parseUsdc", "Ledger", "MandateStore", "computeSurplus", "checkProposal", "allocate",
        "loadAllTokens", "validateBrief", "toCandidates", "ProposalMachine", "precheck",
        "crossCheck", "liquidityScore", "reconcileInternal", "Treasury", "parseKyberRoute", "preTradeChecks",
    ]) {
        expect(name in core).toBe(true);
    }
});