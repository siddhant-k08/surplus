/*
 * The reader's theme, stamped before the first paint.
 *
 * A separate file rather than an inline script because the app sends `script-src 'self'`, which
 * blocks inline execution. Weakening the policy to save one request would be trading a real security
 * control for a cosmetic one; this costs a same-origin file that is a few hundred bytes.
 *
 * Blocking on purpose, and placed above the stylesheet: it has to run before anything paints, or a
 * reader who chose light sees the dark page first and then watches it turn over.
 *
 * No attribute at all means "system", which lets prefers-color-scheme decide.
 */
try {
    var choice = localStorage.getItem("surplus-theme");
    if (choice === "light" || choice === "dark") {
        document.documentElement.setAttribute("data-theme", choice);
    }
} catch (e) {
    /* A private window or blocked site data: the media query still applies. */
}
