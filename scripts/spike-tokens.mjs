import { mkdir, writeFile } from "node:fs/promises";

const URL = "https://api.coinbase.com/v1/tokenized-stocks";

const res = await fetch(URL);
if (!res.ok) {
    console.error(`Request failed: HTTP ${res.status}`);
    process.exit(1);
}

const body = await res.json();
await mkdir("docs", { recursive: true });
await writeFile("docs/tokens.snapshot.json", JSON.stringify(body, null, 2));

const isArray = Array.isArray(body);
const first = isArray ? body[0] : body;
console.log("Top-level type:", isArray ? "array": "object");
console.log("Record count:", isArray ? body.length : "n/a (object)");
console.log("Keys of first record:", Object.keys(first ?? {}));