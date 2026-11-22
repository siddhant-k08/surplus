import { useEffect, useRef, useState, type ReactNode } from "react";
import { LazyMotion, domAnimation, m, useInView, useReducedMotion, type Variants } from "motion/react";

/**
 * The motion vocabulary, in one place.
 *
 * Three rules this file exists to keep. Every moving thing uses the same easing, so the app has one
 * sense of weight. Nothing moves that is not saying something. And every animation ends in the state
 * it would have had anyway, so turning motion off removes the movement and never the content.
 *
 * `useReducedMotion` is checked here rather than in each component, because a component that forgets
 * is a component that ignores someone's accessibility setting.
 */

const EASE = [0.22, 1, 0.36, 1] as const;

/** Rises into place the first time it is scrolled to, once. Always a div: wrap it for other tags. */
export function Reveal({
    children,
    delay = 0,
    y = 14,
    className,
}: {
    children: ReactNode;
    delay?: number;
    y?: number;
    className?: string;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const inView = useInView(ref, { once: true, amount: 0.25 });
    const still = useReducedMotion() === true;
    return (
        <m.div
            ref={ref}
            className={className}
            initial={still ? false : { opacity: 0, y }}
            animate={inView || still ? { opacity: 1, y: 0 } : undefined}
            transition={{ duration: 0.65, delay, ease: EASE }}
        >
            {children}
        </m.div>
    );
}

/** A group whose children arrive one after another rather than all at once. */
export const stagger = (gap = 0.09, delay = 0.1): Variants => ({
    hidden: {},
    shown: { transition: { staggerChildren: gap, delayChildren: delay } },
});

export const riseItem: Variants = {
    hidden: { opacity: 0, y: 12 },
    shown: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
};

/** A headline line that rises out from behind its own mask. */
export function MaskedLine({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
    const still = useReducedMotion() === true;
    return (
        <span className="block overflow-hidden">
            <m.span
                className="block"
                initial={still ? false : { y: "110%", opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.9, delay, ease: EASE }}
            >
                {children}
            </m.span>
        </span>
    );
}

/**
 * A figure settling on its value.
 *
 * Money is formatted by the caller and passed in as the finished string, so this never does
 * arithmetic on an amount: it counts to the same number of decimal places and hands back the exact
 * string at the end. A counter that computed its own total would be a second, worse implementation
 * of the thing the ledger already decided.
 */
export function CountUp({ value, duration = 1.1 }: { value: string; duration?: number }) {
    const ref = useRef<HTMLSpanElement>(null);
    const inView = useInView(ref, { once: true, amount: 1 });
    const still = useReducedMotion() === true;
    const [shown, setShown] = useState(still ? value : zeroLike(value));

    useEffect(() => {
        if (!inView || still) {
            setShown(value);
            return;
        }
        const target = Number(value);
        if (!Number.isFinite(target)) {
            setShown(value);
            return;
        }
        const dp = value.includes(".") ? value.split(".")[1]!.length : 0;
        const started = performance.now();
        let frame = 0;
        const tick = (now: number) => {
            const p = Math.min(1, (now - started) / (duration * 1000));
            const eased = 1 - Math.pow(1 - p, 3);
            // the last frame is the string itself, never a rounded reconstruction of it
            setShown(p >= 1 ? value : (target * eased).toFixed(dp));
            if (p < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [inView, still, value, duration]);

    return <span ref={ref} className="num">{shown}</span>;
}

const zeroLike = (value: string): string =>
    value.includes(".") ? `0.${"0".repeat(value.split(".")[1]!.length)}` : "0";

/** The hero lights faintly where a pointer is. Never on touch, never when motion is off. */
export function useSpotlight<T extends HTMLElement>() {
    const ref = useRef<T>(null);
    const still = useReducedMotion() === true;

    useEffect(() => {
        const el = ref.current;
        if (el === null || still || !matchMedia("(pointer:fine)").matches) return;
        const move = (e: PointerEvent) => {
            const r = el.getBoundingClientRect();
            el.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
            el.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
            el.style.setProperty("--spot", "1");
        };
        const leave = () => el.style.setProperty("--spot", "0");
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerleave", leave);
        return () => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerleave", leave);
        };
    }, [still]);

    return ref;
}

/**
 * Motion's features, fetched only once something needs to move.
 *
 * The full `motion` component bundles every feature whether a page uses it or not, which cost 58 kB
 * gzipped on a storefront whose job is to load fast for someone who has not paid yet. `m` plus
 * `domAnimation` is a fraction of that. `strict` makes the mistake impossible: it throws if a plain
 * `motion.*` component sneaks back in, rather than silently shipping the heavy bundle again.
 */
export function Motion({ children }: { children: ReactNode }) {
    return <LazyMotion features={domAnimation} strict>{children}</LazyMotion>;
}

export { m as motion, EASE };
