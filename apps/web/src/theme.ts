/**
 * Which way round the page is, and remembering it.
 *
 * Three states rather than two. "System" is the default and is not a third palette: it is the
 * absence of a choice, which lets the operating system decide and lets it keep deciding when the
 * person changes their mind at sunset. Choosing light or dark stamps `data-theme` on the root, and
 * that beats the media query in either direction.
 *
 * The stamp is applied by a small script in `index.html` before the first paint, so a light-mode
 * reader never sees a dark page flash first. This module is the same logic for the running app.
 */

export type Choice = "system" | "light" | "dark";

const KEY = "surplus-theme";

const isChoice = (v: unknown): v is Choice => v === "system" || v === "light" || v === "dark";

/** What the reader last chose, or "system" when they have not chosen or storage is unavailable. */
export function storedChoice(): Choice {
    try {
        const v = localStorage.getItem(KEY);
        return isChoice(v) ? v : "system";
    } catch {
        // A private window or blocked site data. Not knowing is the same as not having chosen.
        return "system";
    }
}

/** Puts the choice on the document, and remembers it. Removing the attribute is what "system" means. */
export function applyChoice(choice: Choice): void {
    const root = document.documentElement;
    if (choice === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", choice);
    try {
        localStorage.setItem(KEY, choice);
    } catch {
        // The page still honours the choice for this visit; only the memory of it is lost.
    }
}

/** The theme actually on screen, which for "system" is whatever the operating system says. */
export function resolved(choice: Choice): "light" | "dark" {
    if (choice !== "system") return choice;
    try {
        return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch {
        return "dark";
    }
}

/** The order the control cycles in: whatever is on screen now, then its opposite, then back to system. */
export function nextChoice(choice: Choice): Choice {
    if (choice === "system") return resolved(choice) === "dark" ? "light" : "dark";
    return "system";
}
