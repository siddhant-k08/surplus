/**
 * One line of JSON per event, so a log drain can alert on a thing rather than on a phrase.
 *
 * The events that matter here are rare and specific: a sale booked, a sale that settled and could not
 * be written down, a swap recovered after a restart. Alerting on those by searching text works until
 * someone rewords a message. A stable `event` key does not have that problem.
 *
 * Every line still carries a human `message`, because logs are read by people more often than by
 * machines, and a format only a parser can follow is a format nobody checks.
 */

export type Level = "info" | "warn" | "error";

/** Values an event may carry. Deliberately narrow: a log line is not a place to dump an object graph. */
export type Fields = Record<string, string | number | boolean | null | undefined>;

/**
 * Removes credentials from anything on its way into a log.
 *
 * Error messages are the usual culprit: a driver that cannot connect will happily include the whole
 * connection string, password and all, and a log drain is a copy of that in someone else's system.
 *
 * Redaction is by context, never by shape. A private key and a transaction hash are both 32 bytes of
 * hex, and masking that shape would destroy the one field these logs exist to carry: the transaction
 * of a sale that settled and could not be written down is what makes it recoverable by hand. So what
 * is masked is what is labelled as a secret, and the rule for key material is that it is never logged
 * in the first place.
 */
export function redact(text: string): string {
    return text
        // user:password@host in any URL
        .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s]+@/gi, "$1REDACTED@")
        // Anything that names itself a secret and then gives one. The label may be prefixed, as in
        // EXECUTION_PRIVATE_KEY, and must end there, so a field like tokenBalance is left alone.
        .replace(
            /([A-Za-z_]*(?:private[_-]?key|secret|api[_-]?key|password|token)\b\s*[:=]\s*)\S+/gi,
            "$1REDACTED",
        )
        // bearer tokens
        .replace(/\b(bearer\s+)\S+/gi, "$1REDACTED");
}

const write = (level: Level, event: string, fields: Fields, message: string): void => {
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        message: redact(message),
        ...Object.fromEntries(
            Object.entries(fields)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => [k, typeof v === "string" ? redact(v) : v]),
        ),
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
};

export const log = {
    info: (event: string, message: string, fields: Fields = {}): void => write("info", event, fields, message),
    warn: (event: string, message: string, fields: Fields = {}): void => write("warn", event, fields, message),
    error: (event: string, message: string, fields: Fields = {}): void => write("error", event, fields, message),
};

/** An error as fields, without the object graph and without whatever it was carrying. */
export function errorFields(e: unknown): Fields {
    return {
        error: redact(e instanceof Error ? e.message : String(e)),
        errorType: e instanceof Error ? e.name : typeof e,
    };
}
