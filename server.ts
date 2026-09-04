import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const databasePath = process.env.LEDGER_DB || "data/ledger.sqlite";
mkdirSync(join(databasePath, ".."), { recursive: true });
const db = new Database(databasePath, { create: true });
db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
const hadProduction = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_runs'").get();
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    person_type TEXT NOT NULL DEFAULT 'client' CHECK(person_type IN ('client','supplier')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sku TEXT NOT NULL DEFAULT '',
    default_price_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'кг',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK(kind IN ('sale','client_payment','purchase','supplier_payment')),
    quantity REAL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    unit_price_cents INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS production_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    output_quantity REAL NOT NULL CHECK(output_quantity > 0),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS production_inputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
    quantity REAL NOT NULL CHECK(quantity > 0)
  );
  CREATE INDEX IF NOT EXISTS idx_transactions_person_created ON transactions(client_id,created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_product ON production_runs(product_id);
  CREATE INDEX IF NOT EXISTS idx_runs_created ON production_runs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_inputs_run ON production_inputs(run_id);
  CREATE INDEX IF NOT EXISTS idx_inputs_material ON production_inputs(material_id);
`);

const personColumns = db.query("PRAGMA table_info(clients)").all() as Array<{name:string}>;
if (!personColumns.some(c => c.name === "person_type")) db.exec("ALTER TABLE clients ADD COLUMN person_type TEXT NOT NULL DEFAULT 'client'");
const expenseColumns = db.query("PRAGMA table_info(expenses)").all() as Array<{name:string}>;
if (!expenseColumns.some(c => c.name === "comment")) db.exec("ALTER TABLE expenses ADD COLUMN comment TEXT NOT NULL DEFAULT ''");
db.exec("CREATE INDEX IF NOT EXISTS idx_clients_type_name ON clients(person_type,name)");
const txSchema = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get() as {sql:string}|null;
if (txSchema && !txSchema.sql.includes("'client_payment'")) {
  db.exec(`
    BEGIN;
    CREATE TABLE transactions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK(kind IN ('sale','client_payment','purchase','supplier_payment')),
      quantity REAL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      unit_price_cents INTEGER,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO transactions_new(id,client_id,product_id,kind,quantity,amount_cents,unit_price_cents,note,created_at)
      SELECT id,client_id,product_id,CASE WHEN kind='payment' THEN 'client_payment' ELSE kind END,quantity,amount_cents,unit_price_cents,note,created_at FROM transactions;
    DROP TABLE transactions;
    ALTER TABLE transactions_new RENAME TO transactions;
    CREATE INDEX idx_transactions_person_created ON transactions(client_id,created_at DESC);
    CREATE INDEX idx_transactions_created ON transactions(created_at DESC);
    COMMIT;
  `);
}
const txColumns = db.query("PRAGMA table_info(transactions)").all() as Array<{name:string}>;
if (!txColumns.some(c => c.name === "material_id")) db.exec("ALTER TABLE transactions ADD COLUMN material_id INTEGER REFERENCES materials(id) ON DELETE RESTRICT");
db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_material ON transactions(material_id)");
db.exec(`UPDATE clients SET person_type='supplier'
  WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.client_id=clients.id AND t.kind IN ('purchase','supplier_payment'))
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.client_id=clients.id AND t.kind IN ('sale','client_payment'))`);
const seedMaterial = db.query("INSERT OR IGNORE INTO materials(code,name,unit,sort_order) VALUES(?,?,'кг',?)");
seedMaterial.run("clay", "Глина", 1);
seedMaterial.run("color", "Краситель", 2);
seedMaterial.run("makulatura", "Макулатура", 3);
// One-time carry-over: goods sold before production tracking existed would otherwise start at negative stock.
if (!hadProduction) {
  const opening = db.query(`SELECT p.id, COALESCE((SELECT SUM(t.quantity) FROM transactions t WHERE t.product_id=p.id AND t.kind='sale'),0) sold FROM products p`).all() as Array<{id:number;sold:number}>;
  const insertOpening = db.query("INSERT INTO production_runs(product_id,output_quantity,note) VALUES(?,?,?)");
  for (const row of opening) if (row.sold > 0) insertOpening.run(row.id, row.sold, "Начальный остаток (перенос до учёта производства)");
}
db.exec("PRAGMA optimize");

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"Access-Control-Allow-Origin":"*"}});
const body=async(req:Request)=>req.json() as Promise<Record<string,unknown>>;
const clean=(v:unknown)=>String(v??"").trim();
const cents=(v:unknown)=>Math.round(Number(String(v??"").replace(/\s/g,"").replace(",","."))*100);
const qty=(n:number)=>String(Number(n.toFixed(3))).replace(".",",");
const count=(sql:string,...args:unknown[])=>(db.query(sql).get(...args as never[]) as {c:number}).c;
const EPSILON=1e-9;

type MaterialRow={id:number;code:string;name:string;unit:string;purchased_qty:number;consumed_qty:number;purchased_cents:number;stock_qty:number};
type ProductRow={id:number;name:string;sku:string;units_sold:number;units_produced:number;sale_count:number;stock_qty:number};
type Fail={error:string;status:number};
const failed=(v:unknown):v is Fail=>!!v&&typeof v==="object"&&"error"in (v as object);

const materialStock=()=>(db.query(`SELECT m.id,m.code,m.name,m.unit,m.sort_order,
  COALESCE((SELECT SUM(t.quantity) FROM transactions t WHERE t.material_id=m.id AND t.kind='purchase'),0) purchased_qty,
  COALESCE((SELECT SUM(t.amount_cents) FROM transactions t WHERE t.material_id=m.id AND t.kind='purchase'),0) purchased_cents,
  COALESCE((SELECT SUM(i.quantity) FROM production_inputs i WHERE i.material_id=m.id),0) consumed_qty
  FROM materials m ORDER BY m.sort_order,m.id`).all() as MaterialRow[]).map(m=>({...m,stock_qty:m.purchased_qty-m.consumed_qty}));

const productStock=()=>(db.query(`SELECT p.id,p.name,p.sku,
  COALESCE((SELECT COUNT(*) FROM transactions t WHERE t.product_id=p.id AND t.kind='sale'),0) sale_count,
  COALESCE((SELECT SUM(t.quantity) FROM transactions t WHERE t.product_id=p.id AND t.kind='sale'),0) units_sold,
  COALESCE((SELECT SUM(r.output_quantity) FROM production_runs r WHERE r.product_id=p.id),0) units_produced
  FROM products p ORDER BY p.name`).all() as ProductRow[]).map(p=>({...p,stock_qty:p.units_produced-p.units_sold}));

// Every write runs through this: the change is applied, then stock is re-checked. A negative
// remainder anywhere rolls the whole thing back, so edits and deletes cannot break the invariant.
const mutate=db.transaction((fn:()=>unknown)=>{
  const result=fn();
  const bad=[...materialStock().filter(m=>m.stock_qty<-EPSILON).map(m=>`${m.name} ${qty(m.stock_qty)} ${m.unit}`),
    ...productStock().filter(p=>p.stock_qty<-EPSILON).map(p=>`${p.name} ${qty(p.stock_qty)} кг`)];
  if(bad.length)throw new Error(`Остаток уйдёт в минус: ${bad.join(", ")}. Сначала измените или удалите операции, которые это используют.`);
  return result;
});
const commit=(fn:()=>unknown)=>{try{return {value:mutate(fn)}}catch(error){return {error:error instanceof Error?error.message:"Не удалось сохранить",status:400}}};
const idFrom=(url:URL,prefix:string)=>{const m=url.pathname.match(new RegExp(`^/api/${prefix}/(\\d+)$`));return m?Number(m[1]):0};

function productionRuns(){
  const runs=db.query(`SELECT r.*,p.name product_name FROM production_runs r LEFT JOIN products p ON p.id=r.product_id
    ORDER BY datetime(r.created_at) DESC,r.id DESC LIMIT 500`).all() as Array<Record<string,unknown>&{id:number}>;
  if(!runs.length)return [];
  const inputs=db.query(`SELECT i.run_id,i.material_id,i.quantity,m.name material_name,m.unit FROM production_inputs i
    JOIN materials m ON m.id=i.material_id WHERE i.run_id IN (${runs.map(()=>"?").join(",")}) ORDER BY m.sort_order,m.id`)
    .all(...runs.map(r=>r.id)) as Array<{run_id:number}&Record<string,unknown>>;
  const byRun=new Map<number,unknown[]>();
  for(const i of inputs)(byRun.get(i.run_id)??byRun.set(i.run_id,[]).get(i.run_id)!).push(i);
  return runs.map(r=>({...r,inputs:byRun.get(r.id)??[]}));
}

function snapshot(){
  const people=db.query(`SELECT p.*,
    COALESCE(SUM(CASE WHEN t.kind IN ('sale','purchase') THEN -t.amount_cents ELSE t.amount_cents END),0) balance_cents,
    COUNT(t.id) transaction_count
    FROM clients p LEFT JOIN transactions t ON t.client_id=p.id GROUP BY p.id ORDER BY p.name`).all() as Array<Record<string,unknown>>;
  const materials=materialStock(),products=productStock(),production=productionRuns();
  const transactions=db.query(`SELECT t.*,p.name person_name,p.person_type,pr.name product_name,m.name material_name
    FROM transactions t JOIN clients p ON p.id=t.client_id LEFT JOIN products pr ON pr.id=t.product_id LEFT JOIN materials m ON m.id=t.material_id
    ORDER BY datetime(t.created_at) DESC,t.id DESC LIMIT 500`).all();
  const expenses=db.query("SELECT * FROM expenses ORDER BY datetime(created_at) DESC,id DESC LIMIT 500").all();
  const raw=db.query(`SELECT
    COALESCE(SUM(CASE WHEN kind='sale' THEN amount_cents ELSE 0 END),0) sales_cents,
    COALESCE(SUM(CASE WHEN kind='client_payment' THEN amount_cents ELSE 0 END),0) client_payments_cents,
    COALESCE(SUM(CASE WHEN kind='purchase' THEN amount_cents ELSE 0 END),0) purchases_cents,
    COALESCE(SUM(CASE WHEN kind='supplier_payment' THEN amount_cents ELSE 0 END),0) supplier_payments_cents
    FROM transactions`).get() as Record<string,number>;
  const expensesTotal=(db.query("SELECT COALESCE(SUM(amount_cents),0) expenses_cents FROM expenses").get() as {expenses_cents:number}).expenses_cents;
  const clientDebt=people.filter(p=>p.person_type==='client').reduce((sum,p)=>sum+Math.max(0,-Number(p.balance_cents)),0);
  const supplierDebt=people.filter(p=>p.person_type==='supplier').reduce((sum,p)=>sum+Math.max(0,-Number(p.balance_cents)),0);
  const materialStockQty=materials.reduce((s,m)=>s+m.stock_qty,0),finishedStockQty=products.reduce((s,p)=>s+p.stock_qty,0);
  const producedQty=products.reduce((s,p)=>s+p.units_produced,0),soldQty=products.reduce((s,p)=>s+p.units_sold,0);
  return {people,products,materials,production,transactions,expenses,totals:{...raw,expenses_cents:expensesTotal,
    my_balance_cents:raw.client_payments_cents-raw.purchases_cents-expensesTotal,client_debt_cents:clientDebt,supplier_debt_cents:supplierDebt,
    material_stock_qty:materialStockQty,finished_stock_qty:finishedStockQty,produced_qty:producedQty,sold_qty:soldQty}};
}

type TxFields={personId:number;productId:number|null;materialId:number|null;quantity:number|null;amount:number;unitPrice:number|null;note:string};
// `skipId` is the row being edited: its own quantity is added back to available stock so an
// unchanged edit never reports a shortage against itself.
function buildTx(kind:string,b:Record<string,unknown>,skipId=0):TxFields|Fail{
  const personId=Number(b.personId),inputAmount=cents(b.amount);
  if(!['sale','client_payment','purchase','supplier_payment'].includes(kind))return {error:"Неизвестный тип операции",status:400};
  if(!personId)return {error:"Выберите человека",status:400};
  const person=db.query("SELECT id,person_type FROM clients WHERE id=?").get(personId) as {id:number;person_type:string}|null;
  if(!person)return {error:"Человек не найден",status:404};
  const clientKind=kind==='sale'||kind==='client_payment';
  if((clientKind&&person.person_type!=='client')||(!clientKind&&person.person_type!=='supplier'))
    return {error:clientKind?"Эта операция доступна только клиентам":"Эта операция доступна только поставщикам",status:400};
  let productId:number|null=null,materialId:number|null=null,quantity:number|null=null,unitPrice:number|null=null,amount=inputAmount;
  if(kind==='sale'){
    productId=Number(b.productId);quantity=Number(b.quantity);unitPrice=inputAmount;
    if(!productId||!Number.isFinite(quantity)||quantity<=0)return {error:"Выберите товар и укажите вес",status:400};
    if(!Number.isFinite(unitPrice)||unitPrice<=0)return {error:"Укажите цену",status:400};
    const product=productStock().find(p=>p.id===productId);
    if(!product)return {error:"Товар не найден",status:404};
    const own=skipId?((db.query("SELECT quantity FROM transactions WHERE id=? AND kind='sale' AND product_id=?").get(skipId,productId) as {quantity:number}|null)?.quantity??0):0;
    const available=product.stock_qty+own;
    if(quantity>available+EPSILON)return {error:`Недостаточно на складе. ${product.name}: нужно ${qty(quantity)} кг, в наличии ${qty(available)} кг`,status:400};
    amount=Math.round(unitPrice*quantity);
  }else if(kind==='purchase'){
    materialId=Number(b.materialId);quantity=Number(b.quantity);unitPrice=cents(b.unitPrice);
    if(!materialId)return {error:"Выберите материал",status:400};
    if(!db.query("SELECT id FROM materials WHERE id=?").get(materialId))return {error:"Материал не найден",status:404};
    if(!Number.isFinite(quantity)||quantity<=0)return {error:"Укажите вес",status:400};
    if(!Number.isFinite(unitPrice)||unitPrice<=0)return {error:"Укажите цену за килограмм",status:400};
    amount=Math.round(unitPrice*quantity);
  }else if(!Number.isFinite(amount)||amount<=0)return {error:"Укажите сумму платежа",status:400};
  return {personId,productId,materialId,quantity,amount,unitPrice,note:clean(b.note)};
}

type RunFields={productId:number;output:number;note:string;inputs:Array<{materialId:number;quantity:number}>};
function buildRun(b:Record<string,unknown>,skipId=0):RunFields|Fail{
  const productId=Number(b.productId),output=Number(b.output);
  if(!productId)return {error:"Выберите готовый товар",status:400};
  const product=productStock().find(p=>p.id===productId);
  if(!product)return {error:"Товар не найден",status:404};
  if(!Number.isFinite(output)||output<=0)return {error:"Укажите выпуск в кг",status:400};
  const raw=Array.isArray(b.inputs)?b.inputs as Array<Record<string,unknown>>:[];
  const inputs=raw.map(i=>({materialId:Number(i.materialId),quantity:Number(i.quantity)})).filter(i=>i.quantity>0);
  if(!inputs.length)return {error:"Укажите расход хотя бы одного материала",status:400};
  if(new Set(inputs.map(i=>i.materialId)).size!==inputs.length)return {error:"Материал указан дважды",status:400};
  const own=skipId?db.query("SELECT material_id,quantity FROM production_inputs WHERE run_id=?").all(skipId) as Array<{material_id:number;quantity:number}>:[];
  const stock=materialStock();
  for(const i of inputs){
    const material=stock.find(m=>m.id===i.materialId);
    if(!material)return {error:"Материал не найден",status:404};
    if(!Number.isFinite(i.quantity))return {error:`Укажите расход: ${material.name}`,status:400};
    const available=material.stock_qty+(own.find(o=>o.material_id===i.materialId)?.quantity??0);
    if(i.quantity>available+EPSILON)
      return {error:`Недостаточно материала. ${material.name}: нужно ${qty(i.quantity)} ${material.unit}, в наличии ${qty(available)} ${material.unit}`,status:400};
  }
  return {productId,output,note:clean(b.note),inputs};
}

function writeRunInputs(runId:number,inputs:RunFields["inputs"]){
  db.query("DELETE FROM production_inputs WHERE run_id=?").run(runId);
  const stmt=db.query("INSERT INTO production_inputs(run_id,material_id,quantity) VALUES(?,?,?)");
  for(const i of inputs)stmt.run(runId,i.materialId,i.quantity);
}

async function api(req:Request,url:URL){
  try{
    const method=req.method;
    if(url.pathname==="/api/snapshot"&&method==="GET")return json(snapshot());

    if(url.pathname==="/api/people"&&method==="POST"){
      const b=await body(req),name=clean(b.name),type=clean(b.personType);
      if(!name)return json({error:"Укажите имя"},400);
      if(!['client','supplier'].includes(type))return json({error:"Выберите тип"},400);
      const result=db.query("INSERT INTO clients(name,phone,note,person_type) VALUES(?,?,?,?)").run(name,clean(b.phone),clean(b.note),type);
      return json({id:result.lastInsertRowid},201);
    }
    const personId=idFrom(url,"people");
    if(personId&&(method==="PATCH"||method==="DELETE")){
      const person=db.query("SELECT * FROM clients WHERE id=?").get(personId) as {person_type:string}|null;
      if(!person)return json({error:"Человек не найден"},404);
      const operations=count("SELECT COUNT(*) c FROM transactions WHERE client_id=?",personId);
      if(method==="DELETE"){
        if(operations)return json({error:`Сначала удалите операции этого человека — их ${operations}`},400);
        db.query("DELETE FROM clients WHERE id=?").run(personId);return json({ok:true});
      }
      const b=await body(req),name=clean(b.name),type=clean(b.personType)||person.person_type;
      if(!name)return json({error:"Укажите имя"},400);
      if(!['client','supplier'].includes(type))return json({error:"Выберите тип"},400);
      if(type!==person.person_type&&operations)return json({error:"Нельзя сменить тип: у человека уже есть операции"},400);
      db.query("UPDATE clients SET name=?,phone=?,note=?,person_type=? WHERE id=?").run(name,clean(b.phone),clean(b.note),type,personId);
      return json({ok:true});
    }

    if(url.pathname==="/api/products"&&method==="POST"){
      const b=await body(req),name=clean(b.name);if(!name)return json({error:"Укажите название товара"},400);
      const result=db.query("INSERT INTO products(name,sku) VALUES(?,?)").run(name,clean(b.sku));return json({id:result.lastInsertRowid},201);
    }
    const productId=idFrom(url,"products");
    if(productId&&(method==="PATCH"||method==="DELETE")){
      if(!db.query("SELECT id FROM products WHERE id=?").get(productId))return json({error:"Товар не найден"},404);
      if(method==="DELETE"){
        const runs=count("SELECT COUNT(*) c FROM production_runs WHERE product_id=?",productId);
        const sales=count("SELECT COUNT(*) c FROM transactions WHERE product_id=? AND kind='sale'",productId);
        if(runs||sales)return json({error:`Сначала удалите партии (${runs}) и продажи (${sales}) этого товара`},400);
        db.query("DELETE FROM products WHERE id=?").run(productId);return json({ok:true});
      }
      const b=await body(req),name=clean(b.name);if(!name)return json({error:"Укажите название товара"},400);
      db.query("UPDATE products SET name=?,sku=? WHERE id=?").run(name,clean(b.sku),productId);return json({ok:true});
    }

    if(url.pathname==="/api/materials"&&method==="POST"){
      const b=await body(req),name=clean(b.name);if(!name)return json({error:"Укажите название материала"},400);
      const order=count("SELECT COALESCE(MAX(sort_order),0) c FROM materials")+1;
      const result=db.query("INSERT INTO materials(code,name,unit,sort_order) VALUES(?,?,'кг',?)").run(`m${Date.now()}`,name,order);
      return json({id:result.lastInsertRowid},201);
    }
    const materialId=idFrom(url,"materials");
    if(materialId&&(method==="PATCH"||method==="DELETE")){
      if(!db.query("SELECT id FROM materials WHERE id=?").get(materialId))return json({error:"Материал не найден"},404);
      if(method==="DELETE"){
        const purchases=count("SELECT COUNT(*) c FROM transactions WHERE material_id=?",materialId);
        const used=count("SELECT COUNT(*) c FROM production_inputs WHERE material_id=?",materialId);
        if(purchases||used)return json({error:`Сначала удалите закупки (${purchases}) и партии (${used}) с этим материалом`},400);
        db.query("DELETE FROM materials WHERE id=?").run(materialId);return json({ok:true});
      }
      const b=await body(req),name=clean(b.name);if(!name)return json({error:"Укажите название материала"},400);
      db.query("UPDATE materials SET name=? WHERE id=?").run(name,materialId);return json({ok:true});
    }

    if(url.pathname==="/api/expenses"&&method==="POST"){
      const b=await body(req),amount=cents(b.amount),comment=clean(b.comment);
      if(!Number.isFinite(amount)||amount<=0)return json({error:"Укажите сумму расхода"},400);
      if(!comment)return json({error:"Укажите комментарий к расходу"},400);
      const result=db.query("INSERT INTO expenses(amount_cents,comment) VALUES(?,?)").run(amount,comment);return json({id:result.lastInsertRowid},201);
    }
    const expenseId=idFrom(url,"expenses");
    if(expenseId&&(method==="PATCH"||method==="DELETE")){
      if(!db.query("SELECT id FROM expenses WHERE id=?").get(expenseId))return json({error:"Расход не найден"},404);
      if(method==="DELETE"){db.query("DELETE FROM expenses WHERE id=?").run(expenseId);return json({ok:true})}
      const b=await body(req),amount=cents(b.amount),comment=clean(b.comment);
      if(!Number.isFinite(amount)||amount<=0)return json({error:"Укажите сумму расхода"},400);
      if(!comment)return json({error:"Укажите комментарий к расходу"},400);
      db.query("UPDATE expenses SET amount_cents=?,comment=? WHERE id=?").run(amount,comment,expenseId);return json({ok:true});
    }

    if(url.pathname==="/api/production"&&method==="POST"){
      const fields=buildRun(await body(req));
      if(failed(fields))return json({error:fields.error},fields.status);
      const saved=commit(()=>{
        const run=db.query("INSERT INTO production_runs(product_id,output_quantity,note) VALUES(?,?,?)").run(fields.productId,fields.output,fields.note);
        writeRunInputs(Number(run.lastInsertRowid),fields.inputs);
        return run.lastInsertRowid;
      });
      return failed(saved)?json({error:saved.error},saved.status):json({id:saved.value},201);
    }
    const runId=idFrom(url,"production");
    if(runId&&(method==="PATCH"||method==="DELETE")){
      if(!db.query("SELECT id FROM production_runs WHERE id=?").get(runId))return json({error:"Партия не найдена"},404);
      if(method==="DELETE"){
        const removed=commit(()=>db.query("DELETE FROM production_runs WHERE id=?").run(runId));
        return failed(removed)?json({error:removed.error},removed.status):json({ok:true});
      }
      const fields=buildRun(await body(req),runId);
      if(failed(fields))return json({error:fields.error},fields.status);
      const saved=commit(()=>{
        db.query("UPDATE production_runs SET product_id=?,output_quantity=?,note=? WHERE id=?").run(fields.productId,fields.output,fields.note,runId);
        writeRunInputs(runId,fields.inputs);
      });
      return failed(saved)?json({error:saved.error},saved.status):json({ok:true});
    }

    if(url.pathname==="/api/transactions"&&method==="POST"){
      const b=await body(req),fields=buildTx(clean(b.kind),b);
      if(failed(fields))return json({error:fields.error},fields.status);
      const saved=commit(()=>db.query("INSERT INTO transactions(client_id,product_id,material_id,kind,quantity,amount_cents,unit_price_cents,note) VALUES(?,?,?,?,?,?,?,?)")
        .run(fields.personId,fields.productId,fields.materialId,clean(b.kind),fields.quantity,fields.amount,fields.unitPrice,fields.note).lastInsertRowid);
      return failed(saved)?json({error:saved.error},saved.status):json({id:saved.value},201);
    }
    const txId=idFrom(url,"transactions");
    if(txId&&(method==="PATCH"||method==="DELETE")){
      const tx=db.query("SELECT * FROM transactions WHERE id=?").get(txId) as {kind:string}|null;
      if(!tx)return json({error:"Операция не найдена"},404);
      if(method==="DELETE"){
        const removed=commit(()=>db.query("DELETE FROM transactions WHERE id=?").run(txId));
        return failed(removed)?json({error:removed.error},removed.status):json({ok:true});
      }
      const fields=buildTx(tx.kind,await body(req),txId);
      if(failed(fields))return json({error:fields.error},fields.status);
      const saved=commit(()=>db.query("UPDATE transactions SET client_id=?,product_id=?,material_id=?,quantity=?,amount_cents=?,unit_price_cents=?,note=? WHERE id=?")
        .run(fields.personId,fields.productId,fields.materialId,fields.quantity,fields.amount,fields.unitPrice,fields.note,txId));
      return failed(saved)?json({error:saved.error},saved.status):json({ok:true});
    }

    return json({error:"Не найдено"},404);
  }catch(error){console.error(error);return json({error:error instanceof Error?error.message:"Непредвиденная ошибка"},500)}
}

const server=Bun.serve({port:Number(process.env.PORT||8790),async fetch(req){
  const url=new URL(req.url);
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"GET,POST,PATCH,DELETE,OPTIONS"}});
  if(url.pathname.startsWith("/api/"))return api(req,url);
  const path=url.pathname==="/"?"index.html":url.pathname.slice(1),file=Bun.file(join(process.cwd(),"dist",path));
  if(await file.exists())return new Response(file);
  const index=Bun.file(join(process.cwd(),"dist","index.html"));return await index.exists()?new Response(index):new Response("Запустите `bun run dev`.",{status:404});
}});
console.log(`API журнала запущено на http://localhost:${server.port}`);
