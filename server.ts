import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const databasePath = process.env.LEDGER_DB || "data/ledger.sqlite";
mkdirSync(join(databasePath, ".."), { recursive: true });
const db = new Database(databasePath, { create: true });
db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
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
  CREATE INDEX IF NOT EXISTS idx_transactions_person_created ON transactions(client_id,created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses(created_at DESC);
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
db.exec(`UPDATE clients SET person_type='supplier'
  WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.client_id=clients.id AND t.kind IN ('purchase','supplier_payment'))
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.client_id=clients.id AND t.kind IN ('sale','client_payment'))`);
db.exec("PRAGMA optimize");

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"Access-Control-Allow-Origin":"*"}});
const body=async(req:Request)=>req.json() as Promise<Record<string,unknown>>;
const clean=(v:unknown)=>String(v??"").trim();
const cents=(v:unknown)=>Math.round(Number(String(v??"").replace(/\s/g,"").replace(",","."))*100);

function snapshot(){
  const people=db.query(`SELECT p.*,
    COALESCE(SUM(CASE WHEN t.kind IN ('sale','purchase') THEN -t.amount_cents ELSE t.amount_cents END),0) balance_cents,
    COUNT(t.id) transaction_count
    FROM clients p LEFT JOIN transactions t ON t.client_id=p.id GROUP BY p.id ORDER BY p.name`).all() as Array<Record<string,unknown>>;
  const products=db.query(`SELECT p.*,COALESCE(SUM(CASE WHEN t.kind='sale' THEN 1 ELSE 0 END),0) sale_count,
    COALESCE(SUM(CASE WHEN t.kind='sale' THEN t.quantity ELSE 0 END),0) units_sold
    FROM products p LEFT JOIN transactions t ON t.product_id=p.id GROUP BY p.id ORDER BY p.name`).all();
  const transactions=db.query(`SELECT t.*,p.name person_name,p.person_type,pr.name product_name
    FROM transactions t JOIN clients p ON p.id=t.client_id LEFT JOIN products pr ON pr.id=t.product_id
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
  return {people,products,transactions,expenses,totals:{...raw,expenses_cents:expensesTotal,my_balance_cents:raw.client_payments_cents-raw.purchases_cents-expensesTotal,client_debt_cents:clientDebt,supplier_debt_cents:supplierDebt}};
}

async function api(req:Request,url:URL){
  try{
    if(url.pathname==="/api/snapshot"&&req.method==="GET")return json(snapshot());
    if(url.pathname==="/api/people"&&req.method==="POST"){
      const b=await body(req),name=clean(b.name),type=clean(b.personType);
      if(!name)return json({error:"Укажите имя"},400);
      if(!['client','supplier'].includes(type))return json({error:"Выберите тип"},400);
      const result=db.query("INSERT INTO clients(name,phone,note,person_type) VALUES(?,?,?,?)").run(name,clean(b.phone),clean(b.note),type);
      return json({id:result.lastInsertRowid},201);
    }
    if(url.pathname==="/api/products"&&req.method==="POST"){
      const b=await body(req),name=clean(b.name);if(!name)return json({error:"Укажите название товара"},400);
      const result=db.query("INSERT INTO products(name,sku) VALUES(?,?)").run(name,clean(b.sku));return json({id:result.lastInsertRowid},201);
    }
    if(url.pathname==="/api/expenses"&&req.method==="POST"){
      const b=await body(req),amount=cents(b.amount),comment=clean(b.comment);
      if(!Number.isFinite(amount)||amount<=0)return json({error:"Укажите сумму расхода"},400);
      if(!comment)return json({error:"Укажите комментарий к расходу"},400);
      const result=db.query("INSERT INTO expenses(amount_cents,comment) VALUES(?,?)").run(amount,comment);return json({id:result.lastInsertRowid},201);
    }
    if(url.pathname==="/api/transactions"&&req.method==="POST"){
      const b=await body(req),kind=clean(b.kind),personId=Number(b.personId),inputAmount=cents(b.amount);
      if(!['sale','client_payment','purchase','supplier_payment'].includes(kind))return json({error:"Неизвестный тип операции"},400);
      if(!personId)return json({error:"Выберите человека"},400);
      const person=db.query("SELECT id,person_type FROM clients WHERE id=?").get(personId) as {id:number;person_type:string}|null;
      if(!person)return json({error:"Человек не найден"},404);
      const clientKind=kind==='sale'||kind==='client_payment';
      if((clientKind&&person.person_type!=='client')||(!clientKind&&person.person_type!=='supplier'))return json({error:clientKind?"Эта операция доступна только клиентам":"Эта операция доступна только поставщикам"},400);
      let productId:number|null=null,quantity:number|null=null,unitPrice:number|null=null,amount=inputAmount;
      if(kind==='sale'){
        productId=Number(b.productId);quantity=Number(b.quantity);unitPrice=inputAmount;
        if(!productId||!Number.isFinite(quantity)||quantity<=0)return json({error:"Выберите товар и укажите количество"},400);
        if(!Number.isFinite(unitPrice)||unitPrice<=0)return json({error:"Укажите цену"},400);
        amount=Math.round(unitPrice*quantity);
      }else if(kind==='purchase'){
        quantity=Number(b.quantity);unitPrice=cents(b.unitPrice);
        if(!Number.isFinite(quantity)||quantity<=0)return json({error:"Укажите вес"},400);
        if(!Number.isFinite(unitPrice)||unitPrice<=0)return json({error:"Укажите цену за килограмм"},400);
        amount=Math.round(unitPrice*quantity);
      }else if(!Number.isFinite(amount)||amount<=0)return json({error:"Укажите сумму платежа"},400);
      const result=db.query("INSERT INTO transactions(client_id,product_id,kind,quantity,amount_cents,unit_price_cents,note) VALUES(?,?,?,?,?,?,?)")
        .run(personId,productId,kind,quantity,amount,unitPrice,clean(b.note));
      return json({id:result.lastInsertRowid},201);
    }
    return json({error:"Не найдено"},404);
  }catch(error){console.error(error);return json({error:error instanceof Error?error.message:"Непредвиденная ошибка"},500)}
}

const server=Bun.serve({port:Number(process.env.PORT||8790),async fetch(req){
  const url=new URL(req.url);
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"GET,POST,OPTIONS"}});
  if(url.pathname.startsWith("/api/"))return api(req,url);
  const path=url.pathname==="/"?"index.html":url.pathname.slice(1),file=Bun.file(join(process.cwd(),"dist",path));
  if(await file.exists())return new Response(file);
  const index=Bun.file(join(process.cwd(),"dist","index.html"));return await index.exists()?new Response(index):new Response("Запустите `bun run dev`.",{status:404});
}});
console.log(`API журнала запущено на http://localhost:${server.port}`);
