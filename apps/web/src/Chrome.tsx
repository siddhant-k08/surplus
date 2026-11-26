import { useEffect, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { CountUp, Reveal, motion } from "./motion";
import { applyChoice, nextChoice, storedChoice, type Choice } from "./theme";

/**
 * The parts every surface shares.
 *
 * They were copied into three files before, which is three chances to drift apart. The wordmark's
 * curve is the product: a surplus is what is left above the line.
 */

export function Wordmark({ href = "/", label = "Surplus" }: { href?: string; label?: string }) {
    return (
        <a
            href={href}
            className="group flex items-center gap-2.5 text-[1.0625rem] font-bold tracking-[-0.03em] text-ink no-underline"
        >
            <span className="size-2.5 rounded-[2px] bg-lime transition-transform duration-500 ease-[var(--ease-out-soft)] group-hover:rotate-45" />
            {label}
        </a>
    );
}

/** A link whose underline draws rather than appears. */
export function NavLink({ href, children, current }: { href: string; children: ReactNode; current?: boolean }) {
    return (
        <a
            href={href}
            aria-current={current === true ? "page" : undefined}
            className={`relative py-0.5 text-sm no-underline transition-colors after:absolute after:bottom-0 after:left-0 after:h-px after:bg-lime after:transition-[width] after:duration-300 after:ease-[var(--ease-out-soft)] hover:text-ink ${
                current === true ? "text-ink after:w-full" : "after:w-0 hover:after:w-full"
            }`}
        >
            {children}
        </a>
    );
}

/**
 * The bar condenses once you leave the top, so the page gains room as you read and the chrome never
 * competes with the thing you came for.
 */
export function TopBar({ nav, right }: { nav: ReactNode; right?: ReactNode }) {
    const [stuck, setStuck] = useState(false);
    useEffect(() => {
        const onScroll = () => setStuck(window.scrollY > 24);
        onScroll();
        addEventListener("scroll", onScroll, { passive: true });
        return () => removeEventListener("scroll", onScroll);
    }, []);

    return (
        <header
            className={`sticky top-0 z-50 backdrop-blur-xl transition-colors duration-300 ${
                stuck ? "border-b border-line bg-soot/90" : "border-b border-transparent bg-soot/70"
            }`}
        >
            <div
                className={`shell flex items-center gap-7 transition-[padding] duration-300 ease-[var(--ease-out-soft)] ${
                    stuck ? "py-2.5" : "py-4"
                }`}
            >
                <Wordmark />
                <nav aria-label="Main" className="hidden gap-6 md:flex">{nav}</nav>
                {/* The theme control sits here rather than in each page's `right`, because it belongs
                    to the reader rather than to the page, and every surface should offer it. */}
                <div className="ml-auto flex items-center gap-2.5">{right}<ThemeToggle /></div>
            </div>
            {/* On a phone the same four links sit in one scrolling row rather than behind a menu
                button. Four links do not need a drawer, and a drawer is another state to get wrong. */}
            <nav
                aria-label="Main"
                className="shell flex gap-5 overflow-x-auto border-t border-line pb-2.5 pt-2 [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden"
            >
                {nav}
            </nav>
        </header>
    );
}

/**
 * Light, dark, or whatever the machine says.
 *
 * Three states and the label says which, because a two-state toggle has to guess for the reader who
 * has never chosen, and guessing wrong at midnight is the whole complaint about dark modes. Starts
 * at the stored choice rather than at a default, and reads it after mount so the server-rendered
 * markup and the first client paint agree.
 */
export function ThemeToggle() {
    const [choice, setChoice] = useState<Choice>("system");
    useEffect(() => { setChoice(storedChoice()); }, []);

    const label = choice === "system" ? "Theme: system" : choice === "light" ? "Theme: light" : "Theme: dark";
    return (
        <button
            type="button"
            onClick={() => { const next = nextChoice(choice); setChoice(next); applyChoice(next); }}
            title={label}
            aria-label={label}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-pill px-2.5 py-1 font-mono text-[0.6875rem] text-dim transition-colors hover:text-ink"
        >
            <span aria-hidden="true">{choice === "system" ? "◐" : choice === "light" ? "☀" : "☾"}</span>
            <span className="hidden sm:inline">{choice === "system" ? "Auto" : choice === "light" ? "Light" : "Dark"}</span>
        </button>
    );
}

/** A live indicator. The pulse is the only thing on a quiet page that is allowed to loop. */
export function Led({ className = "bg-lime" }: { className?: string }) {
    const still = useReducedMotion() === true;
    return (
        <span className={`relative inline-flex size-1.5 rounded-full ${className}`}>
            {!still && (
                <motion.span
                    className={`absolute inset-0 rounded-full ${className}`}
                    animate={{ opacity: [0.9, 0.3, 0.9], scale: [1, 1.9, 1] }}
                    transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
                />
            )}
        </span>
    );
}

export function Chip({ children, title }: { children: ReactNode; title?: string }) {
    return (
        <span
            title={title}
            className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1.5 font-mono text-[0.6875rem] font-medium text-dim"
        >
            {children}
        </span>
    );
}

type ButtonProps = {
    children: ReactNode;
    onClick?: () => void;
    href?: string;
    disabled?: boolean;
    tone?: "lime" | "ghost";
    size?: "md" | "sm";
    type?: "button" | "submit";
    title?: string;
};

/**
 * The one control that moves.
 *
 * It leans a little toward the pointer and presses on click, because a button that answers the hand
 * feels like a thing rather than a rectangle. Disabled, it stops answering entirely: a control that
 * still reacts while inert invites a click and then ignores it.
 */
export function Button({ children, onClick, href, disabled, tone = "lime", size = "md", type = "button", title }: ButtonProps) {
    const still = useReducedMotion() === true;
    const base =
        "relative inline-flex select-none items-center justify-center gap-2 overflow-hidden rounded-[4px] font-semibold no-underline transition-[box-shadow,opacity] " +
        (size === "sm" ? "px-3.5 py-2.5 text-[0.8125rem]" : "px-[1.15rem] py-3.5 text-sm");
    const look =
        tone === "lime"
            ? "bg-lime text-lime-ink hover:brightness-[1.06]"
            : "bg-transparent text-ink shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-lime)]";
    const off = disabled === true ? "cursor-not-allowed opacity-45" : "cursor-pointer";

    const lean = (e: React.PointerEvent<HTMLElement>) => {
        if (still || disabled === true || !matchMedia("(pointer:fine)").matches) return;
        const el = e.currentTarget;
        const r = el.getBoundingClientRect();
        el.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * 0.08}px, ${
            (e.clientY - r.top - r.height / 2) * 0.12
        }px)`;
    };
    const settle = (e: React.PointerEvent<HTMLElement>) => { e.currentTarget.style.transform = ""; };

    const inner = <span className="relative z-10 inline-flex items-center gap-2">{children}</span>;
    const shared = {
        className: `${base} ${look} ${off}`,
        title,
        onPointerMove: lean,
        onPointerLeave: settle,
        style: { transition: "transform .25s var(--ease-out-soft)" },
    };

    if (href !== undefined && disabled !== true) {
        return <a href={href} {...shared}>{inner}</a>;
    }
    return (
        <button type={type} onClick={onClick} disabled={disabled} {...shared}>
            {inner}
        </button>
    );
}

export function Footer({ children }: { children?: ReactNode }) {
    return (
        <footer className="border-t border-line py-9">
            <div className="shell flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs leading-relaxed text-dim">
                {children ?? (
                    <>
                        <span>USDC <Addr>0x036CbD53842c5426634e7929541eC2318f3dCF7e</Addr></span>
                        <span>Research is informational and is not investment advice.</span>
                    </>
                )}
            </div>
        </footer>
    );
}

/** An address, shortened for the eye and complete for the clipboard. */
export function Addr({ children }: { children: string }) {
    const short = children.length > 14 ? `${children.slice(0, 6)}…${children.slice(-4)}` : children;
    return (
        <span className="rounded-[3px] bg-pill px-1.5 py-0.5 text-ink" title={children}>
            {short}
        </span>
    );
}

/** Which of the four places in the site a page is. Drives the nav's current mark. */
export type Place = "home" | "themes" | "filings" | "library" | "app" | "desk";

/**
 * The site's navigation: four places, each a page of its own.
 *
 * It used to be four anchors into one scrolling page, which is a table of contents pretending to be
 * a nav: clicking "Treasury" moved you down the document you were already reading. These go
 * somewhere. The transactional surface is not among them, because it is reached by the one button
 * that means business.
 */
export function SiteNav({ here }: { here: Place }) {
    return (
        <>
            <NavLink href="/" current={here === "home"}>Home</NavLink>
            <NavLink href="/themes" current={here === "themes"}>Themes</NavLink>
            <NavLink href="/filings" current={here === "filings"}>Filings</NavLink>
            <NavLink href="/app/library" current={here === "library"}>Library</NavLink>
        </>
    );
}

/**
 * The bar every public page wears.
 *
 * `right` is where a page says what is true of it: the chain it trades on, the wallet that is
 * connected, the one way in. Everything left of that is identical everywhere, which is the point of
 * a nav.
 */
export function SiteHeader({ here, right }: { here: Place; right?: ReactNode }) {
    return <TopBar nav={<SiteNav here={here} />} right={right} />;
}

/** The lime button that crosses from reading about the agent to using it. */
export function OpenApp({ size = "sm" }: { size?: "md" | "sm" }) {
    return (
        <Button href="/app" size={size}>
            Open app <span aria-hidden="true">↗</span>
        </Button>
    );
}

/**
 * A row of figures across the full width, the same on every page that has numbers.
 *
 * Borders rather than cards. Four rounded panels floating on a dark ground is the look of a template;
 * a ruled row reads like the ledger the numbers come from.
 */
export function Figures({ cells }: { cells: { k: string; v: string; unit?: string }[] }) {
    return (
        <div className="grid border-y border-line sm:grid-cols-2 lg:grid-cols-4">
            {cells.map((c) => (
                <div
                    key={c.k}
                    className="border-b border-line px-[var(--gut)] py-5 last:border-b-0 sm:border-r sm:last:border-r-0 lg:border-b-0"
                >
                    <span className="font-mono text-[0.6875rem] font-medium uppercase tracking-[0.11em] text-dim">{c.k}</span>
                    <span className="mt-2.5 block font-mono text-[1.75rem] leading-none tracking-[-0.025em] text-ink">
                        {/^[\d.]+$/.test(c.v) ? <CountUp value={c.v} /> : c.v}
                        {c.unit !== undefined && c.unit !== "" && (
                            <small className="ml-1.5 text-[0.6875rem] font-normal tracking-normal text-dim">{c.unit}</small>
                        )}
                    </span>
                </div>
            ))}
        </div>
    );
}

/**
 * A short line of prose, in the one voice the app uses for outcomes.
 *
 * Plain for what is about to happen, lime for what worked, red for what did not. Alerts get
 * `role=alert` so a screen reader is told rather than left to notice.
 */
export function Note({
    children,
    tone = "plain",
    alert,
    status,
}: {
    children: ReactNode;
    tone?: "plain" | "good" | "bad";
    alert?: boolean;
    status?: boolean;
}) {
    const colour = tone === "bad" ? "text-flag" : tone === "good" ? "text-lime" : "text-dim";
    return (
        <p role={alert === true ? "alert" : status === true ? "status" : undefined} className={`measure m-0 text-sm ${colour}`}>
            {children}
        </p>
    );
}

/** The spine label and optional aside that names a band of a page. */
export function Spine({ label, aside }: { label: string; aside?: ReactNode }) {
    return (
        <div className="lg:sticky lg:top-24 lg:self-start">
            <Reveal>
                <p className="m-0 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.16em] text-dim">{label}</p>
                {aside !== undefined && <div className="mt-3 text-sm text-dim">{aside}</div>}
            </Reveal>
        </div>
    );
}
