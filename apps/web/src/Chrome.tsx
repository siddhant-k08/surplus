import { useEffect, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { motion } from "./motion";

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
                <nav aria-label="Sections" className="hidden gap-6 md:flex">{nav}</nav>
                <div className="ml-auto flex items-center gap-3">{right}</div>
            </div>
        </header>
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
