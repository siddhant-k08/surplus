import { describe, it, expect } from "vitest";
import { wavePath } from "../src/wave";

const points = (d: string) => d.slice(1).split("L").map((p) => p.split(" ").map(Number) as [number, number]);

describe("the wordmark's wave", () => {
    it("is one line from end to end at every phase", () => {
        for (const phase of [0, 0.25, 0.5, 0.9]) {
            const d = wavePath(phase);
            expect(d.match(/M/g)).toHaveLength(1);
            expect(points(d)[0]![0]).toBe(1);
            expect(points(d).at(-1)![0]).toBe(20);
        }
    });

    it("stays inside the frame, stroke included", () => {
        for (let phase = 0; phase < 1; phase += 0.05) {
            for (const [, y] of points(wavePath(phase))) {
                expect(y - 1).toBeGreaterThanOrEqual(1.5);
                expect(y + 1).toBeLessThanOrEqual(14.5);
            }
        }
    });

    it("flows up and down, without travelling sideways", () => {
        const [rest, flat, flipped] = [0, 0.25, 0.5].map((p) => points(wavePath(p)));
        const crest = 9; // a quarter of the way along
        expect(rest![crest]![1]).toBeLessThan(8);
        expect(flipped![crest]![1]).toBeGreaterThan(8);
        expect(flat!.every(([, y]) => y === 8)).toBe(true);
        for (const line of [rest!, flipped!]) {
            expect([line[0]![1], line[19]![1], line[38]![1]]).toEqual([8, 8, 8]);
        }
    });

    it("finishes a cycle in the shape it started from", () => {
        expect(wavePath(1)).toBe(wavePath(0));
    });
});
