// Clears every operation from Turso and starts the ledger fresh.
//
//   bun run scripts/reset-ledger.ts            # dry run — shows what would go
//   bun run scripts/reset-ledger.ts --apply    # writes a backup, then clears
//
// Materials are configuration rather than operations, so they are kept — their stock returns to
// zero on its own once the purchases behind it are gone. A JSON backup is written next to the
// script before anything is deleted.
import { createClient } from "@libsql/client";

const apply = process.argv.includes("--apply");
const url = process.env.TURSO_DATABASE_URL;
if (!url) { console.error("Не задан TURSO_DATABASE_URL."); process.exit(1); }
const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

// Children before parents.
const TABLES = ["production_inputs", "production_runs", "stock_intake", "transactions", "expenses", "products", "clients"];
const ALL = [...TABLES, "materials"];

const counts: Record<string, number> = {};
for (const t of ALL) counts[t] = Number((await db.execute(`SELECT COUNT(*) c FROM ${t}`)).rows[0].c);

console.log("Сейчас в Turso:");
for (const t of ALL) console.log(`  ${t.padEnd(18)} ${counts[t]}${t === "materials" ? "  (останутся)" : ""}`);

const doomed = TABLES.reduce((s, t) => s + counts[t], 0);
if (!doomed) { console.log("\nЖурнал уже пуст — нечего очищать."); process.exit(0); }

if (!apply) {
  console.log(`\nБудет удалено строк: ${doomed}.`);
  console.log("Пробный запуск. Повторите с --apply, чтобы очистить.");
  process.exit(0);
}

const backup: Record<string, unknown[]> = {};
for (const t of ALL) backup[t] = (await db.execute(`SELECT * FROM ${t}`)).rows;
const path = `ledger-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await Bun.write(path, JSON.stringify(backup, null, 1));
console.log(`\nРезервная копия: ${path}`);

await db.batch(TABLES.map(t => `DELETE FROM ${t}`), "write");
// Start ids from 1 again. Materials keep their counter.
try {
  await db.batch(TABLES.map(t => ({ sql: "DELETE FROM sqlite_sequence WHERE name=?", args: [t] })), "write");
} catch { /* sqlite_sequence is absent until an AUTOINCREMENT row exists — nothing to reset */ }

console.log("Очищено. Итог:");
for (const t of ALL) console.log(`  ${t.padEnd(18)} ${(await db.execute(`SELECT COUNT(*) c FROM ${t}`)).rows[0].c}`);
console.log("  материалы:", (await db.execute("SELECT name FROM materials ORDER BY sort_order")).rows.map(r => r.name).join(", "));
