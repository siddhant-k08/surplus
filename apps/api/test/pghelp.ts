import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import postgres from "postgres";
import { loadRootEnv } from "../src/paths";
import { migrate, type Sql } from "../src/pg";

/**
 * A disposable Postgres schema for one test file, or null when no database is configured.
 *
 * Every test runs inside its own schema and drops it afterwards, so a run can never touch rows a real
 * deployment put in `public`, and two runs cannot collide.
 */

loadRootEnv();

export const DATABASE_URL = (process.env.DATABASE_URL ?? "").trim();
export const hasDatabase = DATABASE_URL !== "";

/**
 * Connects, working around a resolver that cannot answer for the database host.
 *
 * Some local resolvers return REFUSED for a hosted provider's endpoint name. That is an environment
 * problem, not an application one, so it is handled here rather than in `pg.ts`: production connects
 * with the connection string exactly as given.
 */
async function connect(url: string, schema: string): Promise<Sql> {
    const u = new URL(url);
    // The provider's pooler reuses one server connection across clients and does not reliably reset
    // `search_path` between them, so a schema set by one client leaks into the next. A test needs its own
    // schema, which means it needs a real session: connect to the direct endpoint instead of the pooled
    // one. Production uses the pooled string as given and never sets `search_path`.
    const host = u.hostname.replace("-pooler", "");
    // The schema travels as a startup parameter, so it survives a reconnect. The two alternatives both
    // fail quietly: `connection: { search_path }` is dropped on the floor, and a `set search_path`
    // statement is lost the moment the driver reopens the socket, after which every table resolves to
    // `public` and the tests are no longer isolated from each other or from real data.
    const options = {
        max: 1,
        idle_timeout: 5,
        connection: { options: `-c search_path="${schema}"` },
        onnotice: () => {},
    } as const;
    const credentials = {
        port: Number(u.port || 5432),
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: u.pathname.slice(1),
    };
    try {
        const sql = postgres({ ...options, ...credentials, host, ssl: { servername: host } });
        await sql`select 1`;
        return sql;
    } catch (e) {
        if (!(e instanceof Error) || !/EAI_AGAIN|ENOTFOUND|getaddrinfo/.test(String(e))) throw e;
        const resolver = new Resolver();
        resolver.setServers(["1.1.1.1", "8.8.8.8"]);
        const [ip] = await resolver.resolve4(host);
        return postgres({
            ...options,
            ...credentials,
            host: ip,
            ssl: { servername: host, rejectUnauthorized: true },
        });
    }
}

export interface Scratch {
    sql: Sql;
    schema: string;
    drop: () => Promise<void>;
}

/** A migrated, empty schema. Call `drop` in afterAll. */
export async function scratchSchema(): Promise<Scratch> {
    const schema = `surplus_test_${randomBytes(6).toString("hex")}`;
    const bootstrap = await connect(DATABASE_URL, "public");
    await bootstrap.unsafe(`create schema if not exists "${schema}"`);
    await bootstrap.end();

    const sql = await connect(DATABASE_URL, schema);
    await migrate(sql);
    return {
        sql,
        schema,
        drop: async () => {
            await sql.unsafe(`drop schema if exists "${schema}" cascade`);
            await sql.end();
        },
    };
}
