// One-off: copy a pre-Turso local SQLite ledger into Turso, preserving ids and timestamps.
//
//   bun run scripts/import-local-sqlite.ts            # dry run — reports what would move
//   bun run scripts/import-local-sqlite.ts --apply    # actually write to Turso
//
// Refuses to touch a Turso database that already holds ledger rows, so it cannot clobber live data.
import { Database } from "bun:sqlite";
import { createClient, type InArgs } from "@libsql/client";

const localPath = process.env.LOCAL_DB || "data/ledger.sqlite";
const apply = process.argv.includes("--apply");

const url = process.env.TURSO_DATABASE_URL;
if (!url) { console.error("Не задан TURSO_DATABASE_URL."); process.exit(1); }
const remote = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
const local = new Database(localPath, { readonly: true });

const has = (table: string) =>
  !!local.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const read = <T = Record<string, unknown>>(sql: string) => (has(sql.split(" FROM ")[1].split(/[ ;]/)[0]) ? local.query(sql).all() as T[] : []);

const clients = local.query("SELECT id,name,phone,note,person_type,created_at FROM clients").all() as Array<Record<string, unknown>>;
const products = local.query("SELECT id,name,sku,default_price_cents,created_at FROM products").all() as Array<Record<string, unknown>>;
const transactions = local.query("SELECT * FROM transactions").all() as Array<Record<string, unknown>>;
const expenses = local.query("SELECT id,amount_cents,comment,created_at FROM expenses").all() as Array<Record<string, unknown>>;
const runs = read<Record<string, unknown>>("SELECT id,product_id,output_quantity,note,created_at FROM production_runs");
const inputs = read<Record<string, unknown>>("SELECT id,run_id,material_id,quantity FROM production_inputs");
const localMaterials = has("materials") ? local.query("SELECT id,code,name FROM materials").all() as Array<{ id: number; code: string; name: string }> : [];

console.log(`Локальная база: ${localPath}`);
console.log(`  клиенты/поставщики ${clients.length}, товары ${products.length}, операции ${transactions.length},`);
console.log(`  расходы ${expenses.length}, партии ${runs.length}, расход сырья ${inputs.length}`);

const occupied: string[] = [];
for (const table of ["clients", "products", "transactions", "expenses", "production_runs"]) {
  const n = Number((await remote.execute(`SELECT COUNT(*) c FROM ${table}`)).rows[0].c);
  if (n) occupied.push(`${table}=${n}`);
}
if (occupied.length) {
  console.error(`\nОтмена: в Turso уже есть данные (${occupied.join(", ")}). Импорт затёр бы их.`);
  process.exit(1);
}

// Materials are seeded on both sides; match by code so ids line up rather than duplicating rows.
const remoteMaterials = (await remote.execute("SELECT id,code FROM materials")).rows as unknown as Array<{ id: number; code: string }>;
const byCode = new Map(remoteMaterials.map(m => [m.code, m.id]));
const materialId = (localId: unknown) => {
  if (localId == null) return null;
  const code = localMaterials.find(m => m.id === Number(localId))?.code;
  return code ? byCode.get(code) ?? null : null;
};

// Goods sold before production tracking existed need a carry-over batch, or stock starts negative
// and every future sale is blocked.
const producedByProduct = new Map<number, number>();
for (const r of runs) producedByProduct.set(Number(r.product_id), (producedByProduct.get(Number(r.product_id)) ?? 0) + Number(r.output_quantity));
const carryOver: Array<{ product_id: number; qty: number }> = [];
for (const p of products) {
  const sold = transactions.filter(t => t.kind === "sale" && Number(t.product_id) === Number(p.id))
    .reduce((s, t) => s + Number(t.quantity ?? 0), 0);
  const made = producedByProduct.get(Number(p.id)) ?? 0;
  if (sold > made) carryOver.push({ product_id: Number(p.id), qty: sold - made });
}
if (carryOver.length) console.log(`  + ${carryOver.length} начальных остатков (продано больше, чем произведено)`);

if (!apply) { console.log("\nПробный запуск. Повторите с --apply, чтобы записать в Turso."); process.exit(0); }

const statements: Array<{ sql: string; args: InArgs }> = [];
const push = (sql: string, args: InArgs) => statements.push({ sql, args });
for (const c of clients) push("INSERT INTO clients(id,name,phone,note,person_type,created_at) VALUES(?,?,?,?,?,?)",
  [c.id, c.name, c.phone, c.note, c.person_type, c.created_at] as InArgs);
for (const p of products) push("INSERT INTO products(id,name,sku,default_price_cents,created_at) VALUES(?,?,?,?,?)",
  [p.id, p.name, p.sku, p.default_price_cents ?? 0, p.created_at] as InArgs);
for (const t of transactions) push(
  "INSERT INTO transactions(id,client_id,product_id,material_id,kind,quantity,amount_cents,unit_price_cents,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  [t.id, t.client_id, t.product_id ?? null, materialId(t.material_id), t.kind, t.quantity ?? null, t.amount_cents, t.unit_price_cents ?? null, t.note ?? "", t.created_at] as InArgs);
for (const e of expenses) push("INSERT INTO expenses(id,amount_cents,comment,created_at) VALUES(?,?,?,?)",
  [e.id, e.amount_cents, e.comment ?? "", e.created_at] as InArgs);
for (const r of runs) push("INSERT INTO production_runs(id,product_id,output_quantity,note,created_at) VALUES(?,?,?,?,?)",
  [r.id, r.product_id, r.output_quantity, r.note ?? "", r.created_at] as InArgs);
for (const i of inputs) {
  const mapped = materialId(i.material_id);
  if (mapped) push("INSERT INTO production_inputs(run_id,material_id,quantity) VALUES(?,?,?)", [i.run_id, mapped, i.quantity] as InArgs);
}
for (const c of carryOver) push("INSERT INTO production_runs(product_id,output_quantity,note) VALUES(?,?,?)",
  [c.product_id, c.qty, "Начальный остаток (перенос до учёта производства)"] as InArgs);

await remote.batch(statements, "write");
console.log(`\nПеренесено в Turso: ${statements.length} строк.`);
for (const table of ["clients", "products", "transactions", "expenses", "production_runs", "production_inputs"]) {
  console.log(`  ${table.padEnd(18)} ${(await remote.execute(`SELECT COUNT(*) c FROM ${table}`)).rows[0].c}`);
}
console.log(`\nЛокальный файл ${localPath} не изменён — оставьте его как резервную копию.`);
