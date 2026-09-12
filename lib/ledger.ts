// Web build: pure HTTP with no native binary, so this runs unchanged on Bun locally and on Vercel.
import { createClient, type InArgs, type ResultSet, type Transaction } from "@libsql/client/web";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
// Thrown, not process.exit: edge runtimes have no process.exit, and both hosts surface the message.
if (!url) throw new Error("Не задан TURSO_DATABASE_URL. Скопируйте .env.example в .env и заполните подключение к Turso.");
const databaseUrl = url; // narrowed past the throw, so callers get a plain string
const db = createClient({ url, authToken });

type Row=Record<string,unknown>;
type Exec={execute(stmt:{sql:string;args:InArgs}):Promise<ResultSet>};
const rowsOn=async<T=Row>(ex:Exec,sql:string,args:InArgs=[])=>(await ex.execute({sql,args})).rows as unknown as T[];
const oneOn=async<T=Row>(ex:Exec,sql:string,args:InArgs=[])=>(await rowsOn<T>(ex,sql,args))[0]??null;
const one=<T=Row>(sql:string,args:InArgs=[])=>oneOn<T>(db,sql,args);
const countOn=async(ex:Exec,sql:string,args:InArgs=[])=>Number((await oneOn<{c:number}>(ex,sql,args))?.c??0);

class ApiError extends Error{
  status:number;
  constructor(message:string,status=400){super(message);this.status=status}
}
const fail=(message:string,status=400):never=>{throw new ApiError(message,status)};

const SCHEMA=`
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
    material_id INTEGER REFERENCES materials(id) ON DELETE RESTRICT,
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
  CREATE TABLE IF NOT EXISTS stock_intake (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
    quantity REAL NOT NULL CHECK(quantity > 0),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_transactions_person_created ON transactions(client_id,created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_material ON transactions(material_id);
  CREATE INDEX IF NOT EXISTS idx_clients_type_name ON clients(person_type,name);
  CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_product ON production_runs(product_id);
  CREATE INDEX IF NOT EXISTS idx_runs_created ON production_runs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_inputs_run ON production_inputs(run_id);
  CREATE INDEX IF NOT EXISTS idx_inputs_material ON production_inputs(material_id);
  CREATE INDEX IF NOT EXISTS idx_intake_material ON stock_intake(material_id);
  CREATE INDEX IF NOT EXISTS idx_intake_created ON stock_intake(created_at DESC);
`;
const SEED:Array<[string,string,number]>=[["kraxmal","Крахмал",1],["color","Краситель",2],["makulatura","Макулатура",3]];

async function createSchema(){
  await db.execute("PRAGMA foreign_keys=ON");
  await db.executeMultiple(SCHEMA);
  // Renamed in place so existing stock, purchases and batch inputs keep pointing at the same row.
  await db.execute("UPDATE materials SET code='kraxmal',name='Крахмал' WHERE code='clay'");
  await db.batch(SEED.map(([code,name,order])=>({sql:"INSERT OR IGNORE INTO materials(code,name,unit,sort_order) VALUES(?,?,'кг',?)",args:[code,name,order] as InArgs})),"write");
}

const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"GET,POST,PATCH,DELETE,OPTIONS"};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"Access-Control-Allow-Origin":"*"}});
const body=async(req:Request)=>req.json() as Promise<Record<string,unknown>>;
const clean=(v:unknown)=>String(v??"").trim();
const cents=(v:unknown)=>Math.round(Number(String(v??"").replace(/\s/g,"").replace(",","."))*100);
const qty=(n:number)=>String(Number(n.toFixed(3))).replace(".",",");
const EPSILON=1e-9;

type MaterialRow={id:number;code:string;name:string;unit:string;purchased_qty:number;intake_qty:number;consumed_qty:number;purchased_cents:number;stock_qty:number};
type ProductRow={id:number;name:string;sku:string;units_sold:number;units_produced:number;sale_count:number;stock_qty:number};

const MATERIAL_SQL=`SELECT m.id,m.code,m.name,m.unit,m.sort_order,
  COALESCE((SELECT SUM(t.quantity) FROM transactions t WHERE t.material_id=m.id AND t.kind='purchase'),0) purchased_qty,
  COALESCE((SELECT SUM(t.amount_cents) FROM transactions t WHERE t.material_id=m.id AND t.kind='purchase'),0) purchased_cents,
  COALESCE((SELECT SUM(a.quantity) FROM stock_intake a WHERE a.material_id=m.id),0) intake_qty,
  COALESCE((SELECT SUM(i.quantity) FROM production_inputs i WHERE i.material_id=m.id),0) consumed_qty
  FROM materials m ORDER BY m.sort_order,m.id`;
const PRODUCT_SQL=`SELECT p.id,p.name,p.sku,
  COALESCE((SELECT COUNT(*) FROM transactions t WHERE t.product_id=p.id AND t.kind='sale'),0) sale_count,
  COALESCE((SELECT SUM(t.quantity) FROM transactions t WHERE t.product_id=p.id AND t.kind='sale'),0) units_sold,
  COALESCE((SELECT SUM(r.output_quantity) FROM production_runs r WHERE r.product_id=p.id),0) units_produced
  FROM products p ORDER BY p.name`;
const withMaterialStock=(list:MaterialRow[])=>list.map(m=>({...m,stock_qty:m.purchased_qty+m.intake_qty-m.consumed_qty}));
const withProductStock=(list:ProductRow[])=>list.map(p=>({...p,stock_qty:p.units_produced-p.units_sold}));
const materialStock=async(ex:Exec=db)=>withMaterialStock(await rowsOn<MaterialRow>(ex,MATERIAL_SQL));
const productStock=async(ex:Exec=db)=>withProductStock(await rowsOn<ProductRow>(ex,PRODUCT_SQL));

// Every write runs through this: the change is applied, then stock is re-checked inside the same
// transaction. A negative remainder anywhere rolls the whole thing back, so edits and deletes
// cannot break the invariant.
async function mutate<T>(work:(tx:Transaction)=>Promise<T>):Promise<T>{
  const tx=await db.transaction("write");
  try{
    const result=await work(tx);
    const bad=[...(await materialStock(tx)).filter(m=>m.stock_qty<-EPSILON).map(m=>`${m.name} ${qty(m.stock_qty)} ${m.unit}`),
      ...(await productStock(tx)).filter(p=>p.stock_qty<-EPSILON).map(p=>`${p.name} ${qty(p.stock_qty)} кг`)];
    if(bad.length)fail(`Остаток уйдёт в минус: ${bad.join(", ")}. Сначала измените или удалите операции, которые это используют.`);
    await tx.commit();
    return result;
  }catch(error){
    await tx.rollback().catch(()=>{});
    throw error;
  }
}
const idFrom=(url:URL,prefix:string)=>{const m=url.pathname.match(new RegExp(`^/api/${prefix}/(\\d+)$`));return m?Number(m[1]):0};

async function snapshot(){
  // One round trip for the whole page — the database is remote, so batching matters.
  const [people,materials,products,runs,inputs,transactions,expenses,intake,raw,expenseTotal]=await db.batch([
    `SELECT p.*,
      COALESCE(SUM(CASE WHEN t.kind IN ('sale','purchase') THEN -t.amount_cents ELSE t.amount_cents END),0) balance_cents,
      COUNT(t.id) transaction_count
      FROM clients p LEFT JOIN transactions t ON t.client_id=p.id GROUP BY p.id ORDER BY p.name`,
    MATERIAL_SQL,
    PRODUCT_SQL,
    `SELECT r.*,p.name product_name FROM production_runs r LEFT JOIN products p ON p.id=r.product_id
      ORDER BY datetime(r.created_at) DESC,r.id DESC LIMIT 500`,
    `SELECT i.run_id,i.material_id,i.quantity,m.name material_name,m.unit FROM production_inputs i
      JOIN materials m ON m.id=i.material_id ORDER BY i.run_id,m.sort_order,m.id`,
    `SELECT t.*,p.name person_name,p.person_type,pr.name product_name,m.name material_name
      FROM transactions t JOIN clients p ON p.id=t.client_id LEFT JOIN products pr ON pr.id=t.product_id LEFT JOIN materials m ON m.id=t.material_id
      ORDER BY datetime(t.created_at) DESC,t.id DESC LIMIT 500`,
    "SELECT * FROM expenses ORDER BY datetime(created_at) DESC,id DESC LIMIT 500",
    `SELECT a.*,m.name material_name,m.unit FROM stock_intake a JOIN materials m ON m.id=a.material_id
      ORDER BY datetime(a.created_at) DESC,a.id DESC LIMIT 500`,
    `SELECT
      COALESCE(SUM(CASE WHEN kind='sale' THEN amount_cents ELSE 0 END),0) sales_cents,
      COALESCE(SUM(CASE WHEN kind='client_payment' THEN amount_cents ELSE 0 END),0) client_payments_cents,
      COALESCE(SUM(CASE WHEN kind='purchase' THEN amount_cents ELSE 0 END),0) purchases_cents,
      COALESCE(SUM(CASE WHEN kind='supplier_payment' THEN amount_cents ELSE 0 END),0) supplier_payments_cents
      FROM transactions`,
    "SELECT COALESCE(SUM(amount_cents),0) expenses_cents FROM expenses",
  ],"read");

  const byRun=new Map<number,unknown[]>();
  for(const i of inputs.rows as unknown as Array<{run_id:number}>)(byRun.get(i.run_id)??byRun.set(i.run_id,[]).get(i.run_id)!).push(i);
  const production=(runs.rows as unknown as Array<Row&{id:number}>).map(r=>({...r,inputs:byRun.get(r.id)??[]}));
  const materialList=withMaterialStock(materials.rows as unknown as MaterialRow[]);
  const productList=withProductStock(products.rows as unknown as ProductRow[]);
  const peopleList=people.rows as unknown as Array<Row&{person_type:string;balance_cents:number}>;
  const totals=raw.rows[0] as unknown as Record<string,number>;
  const expensesTotal=Number((expenseTotal.rows[0] as unknown as {expenses_cents:number}).expenses_cents);
  const clientDebt=peopleList.filter(p=>p.person_type==='client').reduce((sum,p)=>sum+Math.max(0,-Number(p.balance_cents)),0);
  const supplierDebt=peopleList.filter(p=>p.person_type==='supplier').reduce((sum,p)=>sum+Math.max(0,-Number(p.balance_cents)),0);
  return {people:peopleList,products:productList,materials:materialList,production,transactions:transactions.rows,expenses:expenses.rows,intake:intake.rows,
    totals:{...totals,expenses_cents:expensesTotal,
      my_balance_cents:totals.client_payments_cents-totals.purchases_cents-expensesTotal,client_debt_cents:clientDebt,supplier_debt_cents:supplierDebt,
      intake_qty:materialList.reduce((s,m)=>s+m.intake_qty,0),
      material_stock_qty:materialList.reduce((s,m)=>s+m.stock_qty,0),finished_stock_qty:productList.reduce((s,p)=>s+p.stock_qty,0),
      produced_qty:productList.reduce((s,p)=>s+p.units_produced,0),sold_qty:productList.reduce((s,p)=>s+p.units_sold,0)}};
}

type TxFields={personId:number;productId:number|null;materialId:number|null;quantity:number|null;amount:number;unitPrice:number|null;note:string};
// `skipId` is the row being edited: its own quantity is added back to available stock so an
// unchanged edit never reports a shortage against itself.
async function buildTx(ex:Exec,kind:string,b:Record<string,unknown>,skipId=0):Promise<TxFields>{
  const personId=Number(b.personId),inputAmount=cents(b.amount);
  if(!['sale','client_payment','purchase','supplier_payment'].includes(kind))fail("Неизвестный тип операции");
  if(!personId)fail("Выберите человека");
  const person=await oneOn<{id:number;person_type:string}>(ex,"SELECT id,person_type FROM clients WHERE id=?",[personId]);
  if(!person)fail("Человек не найден",404);
  const clientKind=kind==='sale'||kind==='client_payment';
  if((clientKind&&person!.person_type!=='client')||(!clientKind&&person!.person_type!=='supplier'))
    fail(clientKind?"Эта операция доступна только клиентам":"Эта операция доступна только поставщикам");
  let productId:number|null=null,materialId:number|null=null,quantity:number|null=null,unitPrice:number|null=null,amount=inputAmount;
  if(kind==='sale'){
    productId=Number(b.productId);quantity=Number(b.quantity);unitPrice=inputAmount;
    if(!productId||!Number.isFinite(quantity)||quantity<=0)fail("Выберите товар и укажите вес");
    if(!Number.isFinite(unitPrice)||unitPrice<=0)fail("Укажите цену");
    const product=(await productStock(ex)).find(p=>p.id===productId);
    if(!product)fail("Товар не найден",404);
    const own=skipId?Number((await oneOn<{quantity:number}>(ex,"SELECT quantity FROM transactions WHERE id=? AND kind='sale' AND product_id=?",[skipId,productId]))?.quantity??0):0;
    const available=product!.stock_qty+own;
    if(quantity!>available+EPSILON)fail(`Недостаточно на складе. ${product!.name}: нужно ${qty(quantity!)} кг, в наличии ${qty(available)} кг`);
    amount=Math.round(unitPrice*quantity!);
  }else if(kind==='purchase'){
    materialId=Number(b.materialId);quantity=Number(b.quantity);unitPrice=cents(b.unitPrice);
    if(!materialId)fail("Выберите материал");
    if(!await oneOn(ex,"SELECT id FROM materials WHERE id=?",[materialId]))fail("Материал не найден",404);
    if(!Number.isFinite(quantity)||quantity<=0)fail("Укажите вес");
    if(!Number.isFinite(unitPrice)||unitPrice<=0)fail("Укажите цену за килограмм");
    amount=Math.round(unitPrice*quantity!);
  }else if(!Number.isFinite(amount)||amount<=0)fail("Укажите сумму платежа");
  return {personId,productId,materialId,quantity,amount,unitPrice,note:clean(b.note)};
}

type RunFields={productId:number;output:number;note:string;inputs:Array<{materialId:number;quantity:number}>};
async function buildRun(ex:Exec,b:Record<string,unknown>,skipId=0):Promise<RunFields>{
  const productId=Number(b.productId),output=Number(b.output);
  if(!productId)fail("Выберите готовый товар");
  if(!(await productStock(ex)).some(p=>p.id===productId))fail("Товар не найден",404);
  if(!Number.isFinite(output)||output<=0)fail("Укажите выпуск в кг");
  const raw=Array.isArray(b.inputs)?b.inputs as Array<Record<string,unknown>>:[];
  const inputs=raw.map(i=>({materialId:Number(i.materialId),quantity:Number(i.quantity)})).filter(i=>i.quantity>0);
  if(!inputs.length)fail("Укажите расход хотя бы одного материала");
  if(new Set(inputs.map(i=>i.materialId)).size!==inputs.length)fail("Материал указан дважды");
  const own=skipId?await rowsOn<{material_id:number;quantity:number}>(ex,"SELECT material_id,quantity FROM production_inputs WHERE run_id=?",[skipId]):[];
  const stock=await materialStock(ex);
  for(const i of inputs){
    const material=stock.find(m=>m.id===i.materialId);
    if(!material)fail("Материал не найден",404);
    if(!Number.isFinite(i.quantity))fail(`Укажите расход: ${material!.name}`);
    const available=material!.stock_qty+Number(own.find(o=>o.material_id===i.materialId)?.quantity??0);
    if(i.quantity>available+EPSILON)
      fail(`Недостаточно материала. ${material!.name}: нужно ${qty(i.quantity)} ${material!.unit}, в наличии ${qty(available)} ${material!.unit}`);
  }
  return {productId,output,note:clean(b.note),inputs};
}

type IntakeFields={materialId:number;quantity:number;note:string};
async function buildIntake(ex:Exec,b:Record<string,unknown>):Promise<IntakeFields>{
  const materialId=Number(b.materialId),quantity=Number(b.quantity);
  if(!materialId)fail("Выберите материал");
  if(!await oneOn(ex,"SELECT id FROM materials WHERE id=?",[materialId]))fail("Материал не найден",404);
  if(!Number.isFinite(quantity)||quantity<=0)fail("Укажите количество в кг");
  return {materialId,quantity,note:clean(b.note)};
}

async function writeRunInputs(tx:Transaction,runId:number,inputs:RunFields["inputs"]){
  await tx.execute({sql:"DELETE FROM production_inputs WHERE run_id=?",args:[runId]});
  for(const i of inputs)await tx.execute({sql:"INSERT INTO production_inputs(run_id,material_id,quantity) VALUES(?,?,?)",args:[runId,i.materialId,i.quantity]});
}

export async function handleApi(req:Request,url:URL){
  try{
    const method=req.method;
    if(method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
    if(url.pathname==="/api/snapshot"&&method==="GET")return json(await snapshot());

    if(url.pathname==="/api/people"&&method==="POST"){
      const b=await body(req),name=clean(b.name),type=clean(b.personType);
      if(!name)fail("Укажите имя");
      if(!['client','supplier'].includes(type))fail("Выберите тип");
      const result=await db.execute({sql:"INSERT INTO clients(name,phone,note,person_type) VALUES(?,?,?,?)",args:[name,clean(b.phone),clean(b.note),type]});
      return json({id:Number(result.lastInsertRowid)},201);
    }
    const personId=idFrom(url,"people");
    if(personId&&(method==="PATCH"||method==="DELETE")){
      const person=await one<{person_type:string}>("SELECT * FROM clients WHERE id=?",[personId]);
      if(!person)fail("Человек не найден",404);
      const operations=await countOn(db,"SELECT COUNT(*) c FROM transactions WHERE client_id=?",[personId]);
      if(method==="DELETE"){
        if(operations)fail(`Сначала удалите операции этого человека — их ${operations}`);
        await db.execute({sql:"DELETE FROM clients WHERE id=?",args:[personId]});return json({ok:true});
      }
      const b=await body(req),name=clean(b.name),type=clean(b.personType)||person!.person_type;
      if(!name)fail("Укажите имя");
      if(!['client','supplier'].includes(type))fail("Выберите тип");
      if(type!==person!.person_type&&operations)fail("Нельзя сменить тип: у человека уже есть операции");
      await db.execute({sql:"UPDATE clients SET name=?,phone=?,note=?,person_type=? WHERE id=?",args:[name,clean(b.phone),clean(b.note),type,personId]});
      return json({ok:true});
    }

    if(url.pathname==="/api/products"&&method==="POST"){
      const b=await body(req),name=clean(b.name);if(!name)fail("Укажите название товара");
      const result=await db.execute({sql:"INSERT INTO products(name,sku) VALUES(?,?)",args:[name,clean(b.sku)]});
      return json({id:Number(result.lastInsertRowid)},201);
    }
    const productId=idFrom(url,"products");
    if(productId&&(method==="PATCH"||method==="DELETE")){
      if(!await one("SELECT id FROM products WHERE id=?",[productId]))fail("Товар не найден",404);
      if(method==="DELETE"){
        const runs=await countOn(db,"SELECT COUNT(*) c FROM production_runs WHERE product_id=?",[productId]);
        const sales=await countOn(db,"SELECT COUNT(*) c FROM transactions WHERE product_id=? AND kind='sale'",[productId]);
        if(runs||sales)fail(`Сначала удалите партии (${runs}) и продажи (${sales}) этого товара`);
        await db.execute({sql:"DELETE FROM products WHERE id=?",args:[productId]});return json({ok:true});
      }
      const b=await body(req),name=clean(b.name);if(!name)fail("Укажите название товара");
      await db.execute({sql:"UPDATE products SET name=?,sku=? WHERE id=?",args:[name,clean(b.sku),productId]});return json({ok:true});
    }

    if(url.pathname==="/api/materials"&&method==="POST"){
      const b=await body(req),name=clean(b.name);if(!name)fail("Укажите название материала");
      const order=await countOn(db,"SELECT COALESCE(MAX(sort_order),0) c FROM materials")+1;
      const result=await db.execute({sql:"INSERT INTO materials(code,name,unit,sort_order) VALUES(?,?,'кг',?)",args:[`m${Date.now()}`,name,order]});
      return json({id:Number(result.lastInsertRowid)},201);
    }
    const materialId=idFrom(url,"materials");
    if(materialId&&(method==="PATCH"||method==="DELETE")){
      if(!await one("SELECT id FROM materials WHERE id=?",[materialId]))fail("Материал не найден",404);
      if(method==="DELETE"){
        const purchases=await countOn(db,"SELECT COUNT(*) c FROM transactions WHERE material_id=?",[materialId]);
        const used=await countOn(db,"SELECT COUNT(*) c FROM production_inputs WHERE material_id=?",[materialId]);
        const added=await countOn(db,"SELECT COUNT(*) c FROM stock_intake WHERE material_id=?",[materialId]);
        if(purchases||used||added)fail(`Сначала удалите закупки (${purchases}), поступления (${added}) и партии (${used}) с этим материалом`);
        await db.execute({sql:"DELETE FROM materials WHERE id=?",args:[materialId]});return json({ok:true});
      }
      const b=await body(req),name=clean(b.name);if(!name)fail("Укажите название материала");
      await db.execute({sql:"UPDATE materials SET name=? WHERE id=?",args:[name,materialId]});return json({ok:true});
    }

    if(url.pathname==="/api/expenses"&&method==="POST"){
      const b=await body(req),amount=cents(b.amount),comment=clean(b.comment);
      if(!Number.isFinite(amount)||amount<=0)fail("Укажите сумму расхода");
      if(!comment)fail("Укажите комментарий к расходу");
      const result=await db.execute({sql:"INSERT INTO expenses(amount_cents,comment) VALUES(?,?)",args:[amount,comment]});
      return json({id:Number(result.lastInsertRowid)},201);
    }
    const expenseId=idFrom(url,"expenses");
    if(expenseId&&(method==="PATCH"||method==="DELETE")){
      if(!await one("SELECT id FROM expenses WHERE id=?",[expenseId]))fail("Расход не найден",404);
      if(method==="DELETE"){await db.execute({sql:"DELETE FROM expenses WHERE id=?",args:[expenseId]});return json({ok:true})}
      const b=await body(req),amount=cents(b.amount),comment=clean(b.comment);
      if(!Number.isFinite(amount)||amount<=0)fail("Укажите сумму расхода");
      if(!comment)fail("Укажите комментарий к расходу");
      await db.execute({sql:"UPDATE expenses SET amount_cents=?,comment=? WHERE id=?",args:[amount,comment,expenseId]});return json({ok:true});
    }

    if(url.pathname==="/api/production"&&method==="POST"){
      const b=await body(req);
      const id=await mutate(async tx=>{
        const fields=await buildRun(tx,b);
        const run=await tx.execute({sql:"INSERT INTO production_runs(product_id,output_quantity,note) VALUES(?,?,?)",args:[fields.productId,fields.output,fields.note]});
        const runId=Number(run.lastInsertRowid);
        await writeRunInputs(tx,runId,fields.inputs);
        return runId;
      });
      return json({id},201);
    }
    const runId=idFrom(url,"production");
    if(runId&&(method==="PATCH"||method==="DELETE")){
      if(!await one("SELECT id FROM production_runs WHERE id=?",[runId]))fail("Партия не найдена",404);
      if(method==="DELETE"){
        await mutate(async tx=>{
          // Explicit child delete: the foreign_keys pragma is per-connection, so cascade is not guaranteed.
          await tx.execute({sql:"DELETE FROM production_inputs WHERE run_id=?",args:[runId]});
          await tx.execute({sql:"DELETE FROM production_runs WHERE id=?",args:[runId]});
        });
        return json({ok:true});
      }
      const b=await body(req);
      await mutate(async tx=>{
        const fields=await buildRun(tx,b,runId);
        await tx.execute({sql:"UPDATE production_runs SET product_id=?,output_quantity=?,note=? WHERE id=?",args:[fields.productId,fields.output,fields.note,runId]});
        await writeRunInputs(tx,runId,fields.inputs);
      });
      return json({ok:true});
    }

    // Stock added straight to the warehouse — no supplier, no money, no debt.
    if(url.pathname==="/api/intake"&&method==="POST"){
      const b=await body(req);
      const id=await mutate(async tx=>{
        const f=await buildIntake(tx,b);
        const r=await tx.execute({sql:"INSERT INTO stock_intake(material_id,quantity,note) VALUES(?,?,?)",args:[f.materialId,f.quantity,f.note]});
        return Number(r.lastInsertRowid);
      });
      return json({id},201);
    }
    const intakeId=idFrom(url,"intake");
    if(intakeId&&(method==="PATCH"||method==="DELETE")){
      if(!await one("SELECT id FROM stock_intake WHERE id=?",[intakeId]))fail("Поступление не найдено",404);
      if(method==="DELETE"){
        await mutate(t=>t.execute({sql:"DELETE FROM stock_intake WHERE id=?",args:[intakeId]}));
        return json({ok:true});
      }
      const b=await body(req);
      await mutate(async t=>{
        const f=await buildIntake(t,b);
        await t.execute({sql:"UPDATE stock_intake SET material_id=?,quantity=?,note=? WHERE id=?",args:[f.materialId,f.quantity,f.note,intakeId]});
      });
      return json({ok:true});
    }

    if(url.pathname==="/api/transactions"&&method==="POST"){
      const b=await body(req),kind=clean(b.kind);
      const id=await mutate(async tx=>{
        const f=await buildTx(tx,kind,b);
        const result=await tx.execute({sql:"INSERT INTO transactions(client_id,product_id,material_id,kind,quantity,amount_cents,unit_price_cents,note) VALUES(?,?,?,?,?,?,?,?)",
          args:[f.personId,f.productId,f.materialId,kind,f.quantity,f.amount,f.unitPrice,f.note]});
        return Number(result.lastInsertRowid);
      });
      return json({id},201);
    }
    const txId=idFrom(url,"transactions");
    if(txId&&(method==="PATCH"||method==="DELETE")){
      const tx=await one<{kind:string}>("SELECT * FROM transactions WHERE id=?",[txId]);
      if(!tx)fail("Операция не найдена",404);
      if(method==="DELETE"){
        await mutate(t=>t.execute({sql:"DELETE FROM transactions WHERE id=?",args:[txId]}));
        return json({ok:true});
      }
      const b=await body(req);
      await mutate(async t=>{
        const f=await buildTx(t,tx!.kind,b,txId);
        await t.execute({sql:"UPDATE transactions SET client_id=?,product_id=?,material_id=?,quantity=?,amount_cents=?,unit_price_cents=?,note=? WHERE id=?",
          args:[f.personId,f.productId,f.materialId,f.quantity,f.amount,f.unitPrice,f.note,txId]});
      });
      return json({ok:true});
    }

    return json({error:"Не найдено"},404);
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    console.error(error);return json({error:error instanceof Error?error.message:"Непредвиденная ошибка"},500);
  }
}


// Schema work is idempotent but costs round trips, so do it once per process and skip the DDL
// entirely when the newest table is already there.
let ready:Promise<void>|null=null;
export function ensureSchema(){return ready??=(async()=>{
  const present=await one("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='stock_intake'");
  if(!present)await createSchema();
})()}
export { db, databaseUrl };
