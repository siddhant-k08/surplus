/**
 * The wordmark's curve at a point in its cycle, as one unbroken line.
 *
 * One period of a sine from x 1 to 20, the same shape as the tab icon in `index.html`. It does not
 * travel sideways: the crest sinks while the trough rises, through flat and back, with the two ends and
 * the middle holding still. The line is redrawn each frame, so there is never a clipped edge.
 *
 * `phase` runs from 0 to 1, and both ends of that range are the resting shape.
 */
export function wavePath(phase: number): string {
    const swing = Math.cos(2 * Math.PI * phase);
    const points: string[] = [];
    for (let i = 0; i <= 38; i++) {
        const y = 8 - 5.25 * swing * Math.sin(2 * Math.PI * (i / 38));
        points.push(`${1 + i / 2} ${y.toFixed(2)}`);
    }
    return `M${points.join("L")}`;
}
