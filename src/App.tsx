import {createContext,useContext,useEffect,useMemo,useState} from 'react'
import {Outlet,useLocation,useMatch} from 'react-router-dom'
import Link from './Link'
import './App.css'
import './people.css'

type PersonType='client'|'supplier'
type Person={id:number;name:string;phone:string;note:string;person_type:PersonType;balance_cents:number;transaction_count:number}
type Product={id:number;name:string;sku:string;sale_count:number;units_sold:number;units_produced:number;stock_qty:number}
type Material={id:number;code:string;name:string;unit:string;purchased_qty:number;intake_qty:number;consumed_qty:number;purchased_cents:number;stock_qty:number}
type Intake={id:number;material_id:number;material_name:string;unit:string;quantity:number;note:string;created_at:string}
type RunInput={run_id:number;material_id:number;material_name:string;unit:string;quantity:number}
type Run={id:number;product_id:number;product_name:string|null;output_quantity:number;note:string;created_at:string;inputs:RunInput[]}
type TxKind='sale'|'client_payment'|'purchase'|'supplier_payment'
type Tx={id:number;client_id:number;product_id:number|null;material_id:number|null;kind:TxKind;quantity:number|null;amount_cents:number;unit_price_cents:number|null;note:string;created_at:string;person_name:string;person_type:PersonType;product_name:string|null;material_name:string|null}
type Expense={id:number;amount_cents:number;comment:string;created_at:string}
type Totals={my_balance_cents:number;client_debt_cents:number;supplier_debt_cents:number;sales_cents:number;client_payments_cents:number;purchases_cents:number;supplier_payments_cents:number;expenses_cents:number;intake_qty:number;material_stock_qty:number;finished_stock_qty:number;produced_qty:number;sold_qty:number}
type Data={people:Person[];products:Product[];materials:Material[];production:Run[];transactions:Tx[];expenses:Expense[];intake:Intake[];totals:Totals}
type Kind=TxKind|'person'|'product'|'material'|'expense'|'production'|'intake'
type EditRow={id:number;quantity_in?:number;name?:string;phone?:string;note?:string;sku?:string;comment?:string;person_type?:PersonType;transaction_count?:number;client_id?:number;product_id?:number|null;material_id?:number|null;quantity?:number|null;amount_cents?:number;unit_price_cents?:number|null;output_quantity?:number;inputs?:RunInput[]}
type OpenOpts={personId?:number;personType?:PersonType;productId?:number;materialId?:number;edit?:EditRow}
type ModalState=OpenOpts&{kind:Kind}
type Ask={title:string;copy:string;path:string;toast:string}
type View='overview'|'inventory'|'production'|'clients'|'suppliers'|'products'|'expenses'|'ledger'

const views:Record<View,{href:string;label:string;letter:string}>={overview:{href:'/',label:'Обзор',letter:'О'},inventory:{href:'/inventory',label:'Склад',letter:'С'},production:{href:'/production',label:'Производство',letter:'Пр'},clients:{href:'/clients',label:'Клиенты',letter:'К'},suppliers:{href:'/suppliers',label:'Поставщики',letter:'П'},products:{href:'/products',label:'Товары',letter:'Т'},expenses:{href:'/expenses',label:'Расходы',letter:'Р'},ledger:{href:'/ledger',label:'Журнал',letter:'Ж'}}
const zero:Totals={my_balance_cents:0,client_debt_cents:0,supplier_debt_cents:0,sales_cents:0,client_payments_cents:0,purchases_cents:0,supplier_payments_cents:0,expenses_cents:0,intake_qty:0,material_stock_qty:0,finished_stock_qty:0,produced_qty:0,sold_qty:0}
const empty:Data={people:[],products:[],materials:[],production:[],transactions:[],expenses:[],intake:[],totals:zero}
const money=(c:number)=>new Intl.NumberFormat('uz-UZ',{style:'currency',currency:'UZS',maximumFractionDigits:0}).format(c/100)
const qty=(n:number)=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:3}).format(n||0)
const kg=(n:number)=>`${qty(n)} кг`
const date=(s:string)=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',year:'numeric'}).format(new Date(s.replace(' ','T')+'Z'))
const toCents=(v:unknown)=>Math.round(Number(v)*100)
const num=(v:unknown)=>{const n=Number(String(v??'').replace(',','.'));return Number.isFinite(n)?n:0}
const plural=(n:number,one:string,few:string,many:string)=>{const a=Math.abs(n)%100,l=a%10;return a>10&&a<20?many:l===1?one:l>=2&&l<=4?few:many}
const kindLabel=(k:TxKind)=>({sale:'Продажа',client_payment:'Оплата клиента',purchase:'Закупка',supplier_payment:'Оплата поставщику'}[k])
const positiveKind=(k:TxKind)=>k==='client_payment'||k==='supplier_payment'
const txDetail=(t:Tx)=>t.kind==='sale'?`${t.product_name||'Товар'} · ${kg(t.quantity||0)} × ${money(t.unit_price_cents||0)}/кг`:t.kind==='purchase'?`${t.material_name?`${t.material_name} · `:''}${kg(t.quantity||0)} × ${money(t.unit_price_cents||0)}/кг`:t.note||kindLabel(t.kind)
const runDetail=(r:Run)=>r.inputs.length?r.inputs.map(i=>`${i.material_name} ${kg(i.quantity)}`).join(' · '):r.note||'Без расхода материалов'
const txAsk=(t:Tx):Ask=>({title:'Удалить операцию?',copy:`${kindLabel(t.kind)} · ${t.person_name} · ${money(t.amount_cents)} · ${date(t.created_at)} Баланс и остатки пересчитаются.`,path:`/api/transactions/${t.id}`,toast:'Операция удалена'})
const intakeAsk=(a:Intake):Ask=>({title:'Удалить поступление?',copy:`${a.material_name} ${kg(a.quantity)} уйдёт со склада.`,path:`/api/intake/${a.id}`,toast:'Поступление удалено'})
const runAsk=(r:Run):Ask=>({title:'Удалить партию?',copy:`${kg(r.output_quantity)} готовой продукции вернётся со склада, сырьё (${runDetail(r)}) вернётся на склад.`,path:`/api/production/${r.id}`,toast:'Партия удалена'})
async function send(path:string,payload?:unknown,method='POST'){
 const r=await fetch(path,{method,...(payload===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})})
 const v=await r.json().catch(()=>({}));if(!r.ok)throw new Error(v.error||'Что-то пошло не так');return v
}
function Mark(){return <div className="mark"><span/><span/><span/></div>}
function Empty({title,copy,action,onClick}:{title:string;copy:string;action:string;onClick:()=>void}){return <div className="empty"><div className="empty-art"><i/><i/><i/></div><h3>{title}</h3><p>{copy}</p><button className="text-btn" onClick={onClick}>＋ {action}</button></div>}
function RowActions({onEdit,onDelete}:{onEdit:()=>void;onDelete:()=>void}){
 const stop=(fn:()=>void)=>(event:React.MouseEvent)=>{event.preventDefault();event.stopPropagation();fn()}
 return <div className="row-actions"><button type="button" className="icon-btn" title="Изменить" aria-label="Изменить" onClick={stop(onEdit)}>✎</button><button type="button" className="icon-btn danger" title="Удалить" aria-label="Удалить" onClick={stop(onDelete)}>✕</button></div>
}
function TxRow({t,hidePerson}:{t:Tx;hidePerson?:boolean}){
 const {open,ask}=useLedger()
 return <div className="tx-row"><div className={`tx-icon ${t.kind}`}>{positiveKind(t.kind)?'↙':'↗'}</div><div className="grow"><b>{hidePerson?txDetail(t):t.person_name}</b><small>{hidePerson?date(t.created_at):`${txDetail(t)} · ${date(t.created_at)}`}</small></div><strong className={positiveKind(t.kind)?'green':'red'}>{positiveKind(t.kind)?'+':'−'}{money(t.amount_cents)}</strong><RowActions onEdit={()=>open(t.kind,{edit:t})} onDelete={()=>ask(txAsk(t))}/></div>
}
const viewOf=(path:string):View=>path.startsWith('/inventory')?'inventory':path.startsWith('/production')?'production':path.startsWith('/clients')?'clients':path.startsWith('/suppliers')?'suppliers':path.startsWith('/products')?'products':path.startsWith('/expenses')?'expenses':path.startsWith('/ledger')?'ledger':'overview'

type Ctx={data:Data;open:(kind:Kind,opts?:OpenOpts)=>void;ask:(spec:Ask)=>void}
const LedgerCtx=createContext<Ctx>({data:empty,open:()=>{},ask:()=>{}})
const useLedger=()=>useContext(LedgerCtx)

export default function App(){
 const location=useLocation(),clientMatch=useMatch('/clients/:id'),supplierMatch=useMatch('/suppliers/:id'),view=viewOf(location.pathname)
 const [data,setData]=useState<Data>(empty),[modal,setModal]=useState<ModalState|null>(null),[confirm,setConfirm]=useState<Ask|null>(null),[loading,setLoading]=useState(true),[toast,setToast]=useState('')
 const load=()=>fetch('/api/snapshot').then(r=>r.json()).then(setData).finally(()=>setLoading(false));useEffect(()=>{load()},[])
 const open=(kind:Kind,opts:OpenOpts={})=>{setModal({kind,...opts});setConfirm(null);setToast('')}
 const ask=(spec:Ask)=>{setConfirm(spec);setModal(null);setToast('')}
 const done=async(message:string)=>{await load();setModal(null);setConfirm(null);setToast(message);setTimeout(()=>setToast(''),2500)}
 const profileId=clientMatch?.params.id||supplierMatch?.params.id,profile=profileId?data.people.find(p=>String(p.id)===profileId):undefined
 const title:Record<View,string>={overview:'СП Shoxina Prestij',inventory:'Склад',production:'Производство',clients:'Клиенты',suppliers:'Поставщики',products:'Товары',expenses:'Расходы',ledger:'Журнал'}
 const subtitle:Record<View,string>={overview:'Деньги, склад, дебиторская и кредиторская задолженность.',inventory:'Остатки сырья и готовой продукции в килограммах.',production:'Партии: сырьё уходит со склада, картон приходит.',clients:'Только продажи клиентам и их погашения.',suppliers:'Закупка сырья у поставщиков и ваши погашения.',products:'Готовая продукция, которую вы производите и продаёте.',expenses:'Дополнительные расходы, которые уменьшают ваш баланс.',ledger:'Все закупки, партии, продажи и платежи в одном месте.'}
 const profileActions=profile?<>{profile.person_type==='client'?<><button className="secondary" onClick={()=>open('client_payment',{personId:profile.id})}>↓ Клиент оплатил</button><button className="primary" onClick={()=>open('sale',{personId:profile.id})}>＋ Продажа</button></>:<><button className="secondary" onClick={()=>open('supplier_payment',{personId:profile.id})}>↑ Оплатить долг</button><button className="primary" onClick={()=>open('purchase',{personId:profile.id})}>＋ Закупка</button></>}<RowActions onEdit={()=>open('person',{edit:profile})} onDelete={()=>ask({title:'Удалить профиль?',copy:`«${profile.name}» исчезнет из списка.`,path:`/api/people/${profile.id}`,toast:'Профиль удалён'})}/></>:null
 return <LedgerCtx.Provider value={{data,open,ask}}><div className="app"><aside><Link href="/" className="brand"><Mark/><b>Ledgerly</b><span>ЛОКАЛЬНО</span></Link><nav>{(Object.keys(views) as View[]).map(v=><Link key={v} href={views[v].href} className={({isActive})=>isActive?'active':''}><span className="nav-dot">{views[v].letter}</span><i>{views[v].label}</i></Link>)}</nav><div className="local-note"><span className="pulse"/><div><b>Локально и конфиденциально</b><small>Сохраняется только на этом устройстве</small></div></div></aside>
 <main><header><div><p className="eyebrow">{profile?(profile.person_type==='client'?'ПРОФИЛЬ КЛИЕНТА':'ПРОФИЛЬ ПОСТАВЩИКА'):'ФИНАНСОВЫЙ ЖУРНАЛ'}</p><h1>{profile?profile.name:title[view]}</h1><p className="subtitle">{profile?[profile.phone,profile.note].filter(Boolean).join(' · ')||'История операций и баланс':subtitle[view]}</p></div><div className="header-actions">{profileActions}</div></header>{loading?<div className="loading">Открываем журнал…</div>:<div className="page-in" key={location.pathname}><Outlet/></div>}</main>
 {modal&&<Modal state={modal} people={data.people} products={data.products} materials={data.materials} close={()=>setModal(null)} done={done}/>}
 {confirm&&<Confirm ask={confirm} close={()=>setConfirm(null)} done={done}/>}
 {toast&&<div className="toast">✓ {toast}</div>}</div></LedgerCtx.Provider>
}

function StockStrip({materials,finished}:{materials:Material[];finished:number}){
 return <section className="stock-strip">{materials.map(m=><Link href="/inventory" className="stock-chip" key={m.id}><span>{m.name.toUpperCase()}</span><strong className={m.stock_qty>0?'':'muted'}>{kg(m.stock_qty)}</strong></Link>)}<Link href="/inventory" className="stock-chip finished"><span>ГОТОВАЯ ПРОДУКЦИЯ</span><strong className={finished>0?'':'muted'}>{kg(finished)}</strong></Link></section>
}

export function Overview(){
 const {data}=useLedger(),clients=data.people.filter(p=>p.person_type==='client'&&p.balance_cents<0).sort((a,b)=>a.balance_cents-b.balance_cents),suppliers=data.people.filter(p=>p.person_type==='supplier'&&p.balance_cents<0).sort((a,b)=>a.balance_cents-b.balance_cents)
 return <><section className="stats"><article className="stat featured"><span>МОЙ БАЛАНС</span><strong className={data.totals.my_balance_cents>=0?'green':'red'}>{data.totals.my_balance_cents<0?'−':''}{money(Math.abs(data.totals.my_balance_cents))}</strong><small>Оплаты клиентов − закупки − расходы</small><div className="mini-bars"><i/><i/><i/><i/><i/><i/></div></article><article className="stat"><span>ДОЛГИ КЛИЕНТОВ</span><strong>{money(data.totals.client_debt_cents)}</strong><small>{clients.length} {plural(clients.length,'клиент должен','клиента должны','клиентов должны')} вам</small></article><article className="stat"><span>ДОЛГИ ПОСТАВЩИКАМ</span><strong className="red">{money(data.totals.supplier_debt_cents)}</strong><small>{suppliers.length} {plural(suppliers.length,'поставщику','поставщикам','поставщикам')} нужно оплатить</small></article></section>
 <StockStrip materials={data.materials} finished={data.totals.finished_stock_qty}/>
 <section className="grid-two"><DebtPanel title="Клиенты должны вам" people={clients} href="/clients" empty="Долгов клиентов пока нет."/><DebtPanel title="Вы должны поставщикам" people={suppliers} href="/suppliers" empty="Долгов поставщикам пока нет."/></section></>
}
function DebtPanel({title,people,href,empty}:{title:string;people:Person[];href:string;empty:string}){return <article className="panel"><div className="panel-head"><div><p className="eyebrow">БАЛАНСЫ</p><h2>{title}</h2></div><Link href={href} className="link">Все →</Link></div>{people.length?<div className="rows">{people.slice(0,6).map((p,i)=><Link href={`${href}/${p.id}`} className="person-row" key={p.id}><div className={`avatar a${i%4}`}>{p.name.slice(0,2).toUpperCase()}</div><div className="grow"><b>{p.name}</b><small>{p.transaction_count} {plural(p.transaction_count,'операция','операции','операций')}</small></div><strong className="red">−{money(Math.abs(p.balance_cents))}</strong></Link>)}</div>:<div className="empty"><p>{empty}</p></div>}</article>}

export function Inventory(){
 const {data,open,ask}=useLedger()
 return <div className="profile-page"><section className="material-grid">{data.materials.map(m=><article className="material-card" key={m.id}><div className="material-head"><div className={`material-icon ${m.code}`}>{m.name.slice(0,1)}</div><RowActions onEdit={()=>open('material',{edit:m})} onDelete={()=>ask({title:'Удалить материал?',copy:`«${m.name}» исчезнет из склада и форм закупки.`,path:`/api/materials/${m.id}`,toast:'Материал удалён'})}/></div><span>{m.name.toUpperCase()}</span><strong className={m.stock_qty>0?'':'red'}>{kg(m.stock_qty)}</strong><p>Закуплено {kg(m.purchased_qty)}{m.intake_qty>0?` · Добавлено ${kg(m.intake_qty)}`:''} · В производство {kg(m.consumed_qty)}</p><small>На закупку: {money(m.purchased_cents)}</small><button className="stock-add" onClick={()=>open('intake',{materialId:m.id})}>＋ Пополнить склад</button></article>)}
 <button className="add-card" onClick={()=>open('material')}>＋<span>Добавить материал</span></button></section>
 {data.intake.length>0&&<section className="page-panel"><div className="table-toolbar"><div><h2>Поступления без поставщика <span>{data.intake.length}</span></h2><p className="subtitle">Добавлено напрямую: <b>{kg(data.totals.intake_qty)}</b> — без долга и оплаты.</p></div></div><div className="rows">{data.intake.map(a=><div className="tx-row" key={a.id}><div className="tx-icon intake">＋</div><div className="grow"><b>{a.material_name}{a.note?` · ${a.note}`:''}</b><small>{date(a.created_at)}</small></div><strong className="green">+{kg(a.quantity)}</strong><RowActions onEdit={()=>open('intake',{edit:a})} onDelete={()=>ask(intakeAsk(a))}/></div>)}</div></section>}
 <section className="page-panel"><div className="table-toolbar"><div><h2>Готовая продукция <span>{data.products.length}</span></h2><p className="subtitle">Всего на складе: <b>{kg(data.totals.finished_stock_qty)}</b></p></div><div className="toolbar-actions"><button className="secondary small" onClick={()=>open('purchase')}>＋ Закупка сырья</button><button className="primary small" onClick={()=>open('production')}>＋ Новая партия</button></div></div>
 {data.products.length?<div className="rows">{data.products.map(p=><div className="tx-row" key={p.id}><div className="tx-icon production">▣</div><div className="grow"><b>{p.name}</b><small>Произведено {kg(p.units_produced)} · Продано {kg(p.units_sold)}</small></div><strong className={p.stock_qty>0?'green':'muted'}>{kg(p.stock_qty)}</strong><RowActions onEdit={()=>open('product',{edit:p})} onDelete={()=>ask({title:'Удалить товар?',copy:`«${p.name}» исчезнет из каталога.`,path:`/api/products/${p.id}`,toast:'Товар удалён'})}/></div>)}</div>:<Empty title="Товаров пока нет" copy="Добавьте товар в каталог, чтобы записывать выпуск и продажи." action="Добавить товар" onClick={()=>open('product')}/>}</section></div>
}

export function Production(){
 const {data,open,ask}=useLedger()
 return <section className="page-panel"><div className="table-toolbar"><div><h2>Партии <span>{data.production.length}</span></h2><p className="subtitle">Выпущено всего: <b>{kg(data.totals.produced_qty)}</b></p></div><button className="primary small" onClick={()=>open('production')}>＋ Новая партия</button></div>
 {data.production.length?<div className="rows">{data.production.map(r=><div className="tx-row run-row" key={r.id}><div className="tx-icon production">▣</div><div className="grow"><b>{r.product_name||'Товар удалён'}{r.note?` · ${r.note}`:''}</b><small>{runDetail(r)} · {date(r.created_at)}</small></div><strong className="green">+{kg(r.output_quantity)}</strong><RowActions onEdit={()=>open('production',{edit:r})} onDelete={()=>ask(runAsk(r))}/></div>)}</div>:<Empty title="Партий пока нет" copy="Запишите расход глины, красителя и макулатуры — и сколько картона получилось." action="Новая партия" onClick={()=>open('production')}/>}</section>
}

export function Clients(){return <PeoplePage type="client"/>}
export function Suppliers(){return <PeoplePage type="supplier"/>}
function PeoplePage({type}:{type:PersonType}){
 const {data,open,ask}=useLedger(),[q,setQ]=useState(''),label=type==='client'?'клиента':'поставщика',base=type==='client'?'/clients':'/suppliers'
 const people=data.people.filter(p=>p.person_type===type&&`${p.name} ${p.phone} ${p.note}`.toLowerCase().includes(q.toLowerCase()))
 return <section className="page-panel"><div className="table-toolbar"><h2>{type==='client'?'Все клиенты':'Все поставщики'} <span>{people.length}</span></h2><div className="toolbar-actions"><input className="search" placeholder="Поиск…" value={q} onChange={e=>setQ(e.target.value)}/><button className="primary small" onClick={()=>open('person',{personType:type})}>＋ Добавить {label}</button></div></div>{people.length?<div className="cards">{people.map((p,i)=><article className="client-card" key={p.id}><Link href={`${base}/${p.id}`} className="client-main"><div className={`avatar big a${i%4}`}>{p.name.slice(0,2).toUpperCase()}</div><div className="grow"><h3>{p.name}</h3><p>{p.phone||'Нет телефона'} · {p.transaction_count} {plural(p.transaction_count,'операция','операции','операций')}</p></div><div className="balance"><span>БАЛАНС</span><strong className={p.balance_cents<0?'red':'green'}>{p.balance_cents<0?'−':'+'}{money(Math.abs(p.balance_cents))}</strong></div><span className="profile-arrow">Открыть →</span></Link><div className="card-actions">{type==='client'?<><button className="pay-mini" onClick={()=>open('sale',{personId:p.id})}>Продажа</button><button className="pay-mini" onClick={()=>open('client_payment',{personId:p.id})}>Оплата</button></>:<><button className="pay-mini" onClick={()=>open('purchase',{personId:p.id})}>Закупка</button><button className="pay-mini" onClick={()=>open('supplier_payment',{personId:p.id})}>Погасить</button></>}<RowActions onEdit={()=>open('person',{edit:p})} onDelete={()=>ask({title:`Удалить ${label}?`,copy:`«${p.name}» исчезнет из списка.${p.transaction_count?` Сначала нужно удалить операции — их ${p.transaction_count}.`:''}`,path:`/api/people/${p.id}`,toast:'Профиль удалён'})}/></div></article>)}</div>:<Empty title={`Добавьте первого ${label}`} copy={type==='client'?'Клиентам можно продавать готовую продукцию и принимать оплату.':'У поставщиков закупается глина, краситель и макулатура.'} action={`Добавить ${label}`} onClick={()=>open('person',{personType:type})}/>}</section>
}

export function PersonProfile(){
 const {data,open}=useLedger(),clientMatch=useMatch('/clients/:id'),supplierMatch=useMatch('/suppliers/:id'),id=clientMatch?.params.id||supplierMatch?.params.id,person=data.people.find(p=>String(p.id)===id)
 if(!person)return <section className="page-panel"><Empty title="Профиль не найден" copy="Вернитесь к списку и выберите человека." action="Назад" onClick={()=>history.back()}/></section>
 const txs=data.transactions.filter(t=>t.client_id===person.id),primary=txs.filter(t=>t.kind===(person.person_type==='client'?'sale':'purchase')),payments=txs.filter(t=>t.kind===(person.person_type==='client'?'client_payment':'supplier_payment')),base=person.person_type==='client'?'/clients':'/suppliers'
 return <div className="profile-page"><Link href={base} className="back-link">← {person.person_type==='client'?'Все клиенты':'Все поставщики'}</Link><section className="profile-summary"><article className="profile-balance"><span>ТЕКУЩИЙ ДОЛГ</span><strong className={person.balance_cents<0?'red':'green'}>{money(Math.max(0,-person.balance_cents))}</strong><p>{person.balance_cents<0?(person.person_type==='client'?'Клиент должен вам.':'Вы должны поставщику.'):'Баланс закрыт.'}</p></article><article className="profile-metric"><span>{person.person_type==='client'?'ПРОДАЖИ':'ЗАКУПКИ'}</span><strong>{money(primary.reduce((s,t)=>s+t.amount_cents,0))}</strong><small>{kg(primary.reduce((s,t)=>s+(t.quantity||0),0))} · {primary.length} операций</small></article><article className="profile-metric"><span>ПОГАШЕНО</span><strong className="green">{money(payments.reduce((s,t)=>s+t.amount_cents,0))}</strong><small>{payments.length} платежей</small></article></section><section className="page-panel profile-history"><div className="table-toolbar"><h2>История операций <span>{txs.length}</span></h2><div className="toolbar-actions">{person.person_type==='client'?<><button className="secondary small" onClick={()=>open('client_payment',{personId:person.id})}>↓ Оплата</button><button className="primary small" onClick={()=>open('sale',{personId:person.id})}>＋ Продажа</button></>:<><button className="secondary small" onClick={()=>open('supplier_payment',{personId:person.id})}>↑ Погасить</button><button className="primary small" onClick={()=>open('purchase',{personId:person.id})}>＋ Закупка</button></>}</div></div>{txs.length?<div className="profile-transactions">{txs.map(t=><TxRow t={t} hidePerson key={t.id}/>)}</div>:<Empty title="Операций пока нет" copy="Новая операция появится здесь." action={person.person_type==='client'?'Создать продажу':'Создать закупку'} onClick={()=>open(person.person_type==='client'?'sale':'purchase',{personId:person.id})}/>}</section></div>
}

export function Products(){
 const {data,open,ask}=useLedger()
 return <section className="page-panel"><div className="table-toolbar"><h2>Каталог товаров <span>{data.products.length}</span></h2><button className="primary small" onClick={()=>open('product')}>＋ Добавить товар</button></div>{data.products.length?<div className="product-grid">{data.products.map(p=><article className="product-card" key={p.id}><div className="material-head"><div className="product-icon">□</div><RowActions onEdit={()=>open('product',{edit:p})} onDelete={()=>ask({title:'Удалить товар?',copy:`«${p.name}» исчезнет из каталога.${p.units_produced||p.units_sold?' Сначала нужно удалить его партии и продажи.':''}`,path:`/api/products/${p.id}`,toast:'Товар удалён'})}/></div><span className="sku">{p.sku||'БЕЗ АРТИКУЛА'}</span><h3>{p.name}</h3><div className="product-stock"><span>НА СКЛАДЕ</span><strong className={p.stock_qty>0?'green':'muted'}>{kg(p.stock_qty)}</strong></div><p>Произведено {kg(p.units_produced)} · Продано {kg(p.units_sold)} за {p.sale_count} {plural(p.sale_count,'продажу','продажи','продаж')}</p><div className="card-actions"><button className="pay-mini" onClick={()=>open('production',{productId:p.id})}>Партия</button><button className="pay-mini" onClick={()=>open('sale',{productId:p.id})}>Продажа</button></div></article>)}</div>:<Empty title="Соберите каталог" copy="Товар — это то, что вы производите из сырья и продаёте клиентам." action="Добавить товар" onClick={()=>open('product')}/>}</section>
}

export function Expenses(){
 const {data,open,ask}=useLedger()
 return <section className="page-panel"><div className="table-toolbar"><div><h2>Все расходы <span>{data.expenses.length}</span></h2><p className="subtitle">Всего: <b className="red">−{money(data.totals.expenses_cents)}</b></p></div><button className="primary small" onClick={()=>open('expense')}>＋ Добавить расход</button></div>{data.expenses.length?<div className="rows">{data.expenses.map(e=><div className="tx-row" key={e.id}><div className="tx-icon sale">↗</div><div className="grow"><b>{e.comment||'Расход'}</b><small>{date(e.created_at)}</small></div><strong className="red">−{money(e.amount_cents)}</strong><RowActions onEdit={()=>open('expense',{edit:e})} onDelete={()=>ask({title:'Удалить расход?',copy:`${e.comment||'Расход'} · ${money(e.amount_cents)}. Ваш баланс вырастет на эту сумму.`,path:`/api/expenses/${e.id}`,toast:'Расход удалён'})}/></div>)}</div>:<Empty title="Расходов пока нет" copy="Каждый расход уменьшает ваш баланс на главной странице." action="Добавить расход" onClick={()=>open('expense')}/>}</section>
}

export function Ledger(){
 const {data,open,ask}=useLedger(),[q,setQ]=useState('')
 const items=useMemo(()=>[
  ...data.transactions.map(t=>({type:'transaction' as const,id:`t-${t.id}`,created_at:t.created_at,search:`${kindLabel(t.kind)} ${t.person_name} ${t.product_name||''} ${t.material_name||''} ${t.note}`,tx:t})),
  ...data.production.map(r=>({type:'production' as const,id:`r-${r.id}`,created_at:r.created_at,search:`производство партия ${r.product_name||''} ${r.note} ${r.inputs.map(i=>i.material_name).join(' ')}`,run:r})),
  ...data.intake.map(a=>({type:'intake' as const,id:`a-${a.id}`,created_at:a.created_at,search:`поступление склад ${a.material_name} ${a.note}`,intake:a})),
  ...data.expenses.map(e=>({type:'expense' as const,id:`e-${e.id}`,created_at:e.created_at,search:`расход expense ${e.comment}`,expense:e}))
 ].filter(item=>item.search.toLowerCase().includes(q.toLowerCase())).sort((a,b)=>new Date(b.created_at.replace(' ','T')+'Z').getTime()-new Date(a.created_at.replace(' ','T')+'Z').getTime()),[data.transactions,data.production,data.intake,data.expenses,q])
 return <section className="page-panel"><div className="table-toolbar"><h2>Все операции <span>{items.length}</span></h2><input className="search" placeholder="Поиск…" value={q} onChange={e=>setQ(e.target.value)}/></div>{items.length?<div className="ledger-table"><div className="table-head"><span>ТИП</span><span>ЧЕЛОВЕК</span><span>ДЕТАЛИ</span><span>ДАТА</span><span>СУММА</span><span/></div>
 {items.map(item=>item.type==='expense'
  ?<div className="table-row" key={item.id}><span><em className="expense">Расход</em></span><b>—</b><span>{item.expense.comment||'Дополнительный расход'}</span><span>{date(item.expense.created_at)}</span><strong className="red">−{money(item.expense.amount_cents)}</strong><RowActions onEdit={()=>open('expense',{edit:item.expense})} onDelete={()=>ask({title:'Удалить расход?',copy:`${item.expense.comment||'Расход'} · ${money(item.expense.amount_cents)}.`,path:`/api/expenses/${item.expense.id}`,toast:'Расход удалён'})}/></div>
  :item.type==='intake'
  ?<div className="table-row" key={item.id}><span><em className="intake">Поступление</em></span><b>—</b><span>{item.intake.material_name}{item.intake.note?` · ${item.intake.note}`:''}</span><span>{date(item.intake.created_at)}</span><strong className="green">+{kg(item.intake.quantity)}</strong><RowActions onEdit={()=>open('intake',{edit:item.intake})} onDelete={()=>ask(intakeAsk(item.intake))}/></div>
  :item.type==='production'
  ?<div className="table-row" key={item.id}><span><em className="production">Партия</em></span><b>{item.run.product_name||'—'}</b><span>{runDetail(item.run)}</span><span>{date(item.run.created_at)}</span><strong className="green">+{kg(item.run.output_quantity)}</strong><RowActions onEdit={()=>open('production',{edit:item.run})} onDelete={()=>ask(runAsk(item.run))}/></div>
  :<div className="table-row" key={item.id}><span><em className={item.tx.kind}>{kindLabel(item.tx.kind)}</em></span><b>{item.tx.person_name}</b><span>{txDetail(item.tx)}</span><span>{date(item.tx.created_at)}</span><strong className={positiveKind(item.tx.kind)?'green':'red'}>{positiveKind(item.tx.kind)?'+':'−'}{money(item.tx.amount_cents)}</strong><RowActions onEdit={()=>open(item.tx.kind,{edit:item.tx})} onDelete={()=>ask(txAsk(item.tx))}/></div>)}</div>:<div className="empty"><p>Операций пока нет.</p></div>}</section>
}

function Confirm({ask,close,done}:{ask:Ask;close:()=>void;done:(s:string)=>Promise<void>}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 async function remove(){setBusy(true);setError('');try{await send(ask.path,undefined,'DELETE');await done(ask.toast)}catch(e){setError(e instanceof Error?e.message:'Не удалось удалить')}finally{setBusy(false)}}
 return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><div className="modal narrow"><button className="close" onClick={close}>×</button><p className="eyebrow">УДАЛЕНИЕ</p><h2>{ask.title}</h2><p className="modal-copy">{ask.copy} Отменить это действие нельзя.</p>{error&&<p className="error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary" onClick={close}>Отмена</button><button type="button" className="primary danger" disabled={busy} onClick={remove}>{busy?'Удаление…':'Удалить'}</button></div></div></div>
}

function Modal({state,people,products,materials,close,done}:{state:ModalState;people:Person[];products:Product[];materials:Material[];close:()=>void;done:(s:string)=>Promise<void>}){
 const {kind,personId}=state,row=state.edit,editing=!!row
 const personType=state.personType??row?.person_type
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 const [qtyIn,setQtyIn]=useState(kind==='sale'&&row?.quantity!=null?String(row.quantity):'1')
 const [unit,setUnit]=useState(kind==='sale'&&row?.unit_price_cents!=null?String(row.unit_price_cents/100):'')
 const [weight,setWeight]=useState(kind==='purchase'&&row?.quantity!=null?String(row.quantity):'')
 const [perKg,setPerKg]=useState(kind==='purchase'&&row?.unit_price_cents!=null?String(row.unit_price_cents/100):'')
 const [amount,setAmount]=useState(row?.amount_cents!=null&&kind!=='sale'&&kind!=='purchase'?String(row.amount_cents/100):'')
 const [output,setOutput]=useState(row?.output_quantity!=null?String(row.output_quantity):'')
 const [productId,setProductId]=useState(row?.product_id?String(row.product_id):state.productId?String(state.productId):products.length===1?String(products[0].id):'')
 const [materialId,setMaterialId]=useState(row?.material_id?String(row.material_id):state.materialId?String(state.materialId):'')
 const [intakeQty,setIntakeQty]=useState(kind==='intake'&&row?.quantity!=null?String(row.quantity):'')
 const [used,setUsed]=useState<Record<number,string>>(row?.inputs?Object.fromEntries(row.inputs.map(i=>[i.material_id,String(i.quantity)])):{})
 const requiredType:PersonType=kind==='sale'||kind==='client_payment'?'client':'supplier',available=people.filter(p=>p.person_type===requiredType)
 const preset=row?.client_id?String(row.client_id):personId?String(personId):''
 const product=products.find(p=>String(p.id)===productId)
 // When editing, the row's own consumption is still counted in stock — add it back so an unchanged edit isn't flagged.
 const ownSale=kind==='sale'&&row?.quantity!=null&&row.product_id===Number(productId)?row.quantity:0
 const stock=(product?.stock_qty??0)+ownSale
 const ownUse=(id:number)=>kind==='production'&&row?.inputs?(row.inputs.find(i=>i.material_id===id)?.quantity??0):0
 const availableOf=(m:Material)=>m.stock_qty+ownUse(m.id)
 const saleQty=num(qtyIn),saleTotal=saleQty>0&&num(unit)>0?Math.round(toCents(num(unit))*saleQty):0,purchaseTotal=num(weight)>0&&num(perKg)>0?Math.round(toCents(num(perKg))*num(weight)):0
 const intakeMaterial=materials.find(m=>String(m.id)===materialId)
 const ownIntake=kind==='intake'&&row?.quantity!=null&&row.material_id===Number(materialId)?row.quantity:0
 const overSell=kind==='sale'&&!!product&&saleQty>stock+1e-9
 const shortages=materials.filter(m=>num(used[m.id])>availableOf(m)+1e-9)
 const usedTotal=materials.reduce((s,m)=>s+num(used[m.id]),0)
 const noun=kind==='person'?(personType==='supplier'?'поставщик':'клиент'):kind==='product'?'товар':kind==='material'?'материал':kind==='expense'?'расход':kind==='production'?'партия':''
 const title=kind==='person'?(editing?`Изменить ${personType==='supplier'?'поставщика':'клиента'}`:`Новый ${noun}`)
  :kind==='product'?(editing?'Изменить товар':'Новый товар')
  :kind==='material'?(editing?'Изменить материал':'Новый материал')
  :kind==='expense'?(editing?'Изменить расход':'Новый расход')
  :kind==='production'?(editing?'Изменить партию':'Новая партия')
  :kind==='intake'?(editing?'Изменить поступление':'Пополнить склад')
  :`${editing?'Изменить: ':''}${({sale:'Продажа клиенту',client_payment:'Оплата от клиента',purchase:'Закупка сырья',supplier_payment:'Оплата поставщику'} as Record<TxKind,string>)[kind as TxKind]}`
 const endpoint=kind==='person'?'/api/people':kind==='product'?'/api/products':kind==='material'?'/api/materials':kind==='expense'?'/api/expenses':kind==='production'?'/api/production':kind==='intake'?'/api/intake':'/api/transactions'
 async function submit(e:React.FormEvent<HTMLFormElement>){
  e.preventDefault();setBusy(true);setError('')
  const v=Object.fromEntries(new FormData(e.currentTarget)),path=editing?`${endpoint}/${row?.id}`:endpoint,method=editing?'PATCH':'POST'
  try{
   if(kind==='person')await send(path,{...v,personType:v.personType||personType},method)
   else if(kind==='product'||kind==='material'||kind==='expense')await send(path,v,method)
   else if(kind==='intake')await send(path,{materialId:Number(materialId),quantity:num(intakeQty),note:v.note},method)
   else if(kind==='production')await send(path,{productId:Number(productId),output:num(output),note:v.note,inputs:materials.map(m=>({materialId:m.id,quantity:num(used[m.id])})).filter(i=>i.quantity>0)},method)
   else await send(path,{kind,personId:Number(v.personId),productId:productId?Number(productId):undefined,materialId:materialId?Number(materialId):undefined,quantity:v.quantity?num(v.quantity):undefined,amount:Number(v.amount),unitPrice:v.unitPrice?num(v.unitPrice):undefined,note:v.note},method)
   await done(editing?'Изменения сохранены':kind==='person'?'Профиль добавлен':kind==='product'?'Товар добавлен':kind==='material'?'Материал добавлен':kind==='expense'?'Расход добавлен':kind==='production'?'Партия записана':kind==='intake'?'Склад пополнен':'Операция записана')
  }catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить')}finally{setBusy(false)}
 }
 const copy=editing?'Остатки и балансы пересчитаются после сохранения.':kind==='expense'?'Сумма сразу уменьшит ваш баланс.':kind==='sale'?'Продать можно не больше, чем есть на складе.':kind==='purchase'?'Сырьё придёт на склад и создаст долг перед поставщиком.':kind==='production'?'Сырьё спишется со склада, готовая продукция придёт на склад.':kind==='intake'?'Остаток вырастет сразу. Поставщик не нужен, долг и оплата не создаются.':kind==='material'?'Материал появится на складе и в форме закупки.':kind==='client_payment'?'Оплата клиента уменьшает его долг и увеличивает ваш баланс.':kind==='supplier_payment'?'Ваша оплата уменьшает долг перед поставщиком.':'Укажите основные данные.'
 const blocked=busy||overSell||(kind==='production'&&(!productId||shortages.length>0||usedTotal<=0||num(output)<=0))||(kind==='sale'&&(!available.length||!products.length))||((kind==='purchase'||kind==='client_payment'||kind==='supplier_payment')&&!available.length)||(kind==='purchase'&&!materials.length)||(kind==='intake'&&(!materialId||num(intakeQty)<=0))
 return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><div className="modal"><button className="close" onClick={close}>×</button><p className="eyebrow">{editing?'ИЗМЕНЕНИЕ':'НОВАЯ ЗАПИСЬ'}</p><h2>{title}</h2><p className="modal-copy">{copy}</p><form onSubmit={submit}>
 {kind==='person'?<><label>Имя<input name="name" autoFocus required defaultValue={row?.name??''} placeholder={personType==='supplier'?'Название поставщика':'Имя клиента'}/></label><label>Телефон <span>необязательно</span><input name="phone" defaultValue={row?.phone??''} placeholder="+998 90 123-45-67"/></label><label>Заметка <span>необязательно</span><textarea name="note" defaultValue={row?.note??''}/></label>{editing&&(row?.transaction_count?<p className="hint">Тип: <b>{personType==='supplier'?'Поставщик':'Клиент'}</b> — нельзя изменить, есть операции ({row.transaction_count}).</p>:<label>Тип<select name="personType" defaultValue={personType}><option value="client">Клиент</option><option value="supplier">Поставщик</option></select></label>)}</>
 :kind==='product'?<><label>Название товара<input name="name" autoFocus required defaultValue={row?.name??''} placeholder="Картон"/></label><label>Артикул <span>необязательно</span><input name="sku" defaultValue={row?.sku??''}/></label></>
 :kind==='material'?<><label>Название материала<input name="name" autoFocus required defaultValue={row?.name??''} placeholder="Глина"/></label><p className="hint">Учёт ведётся в килограммах.</p></>
 :kind==='expense'?<><label>Сумма расхода<input name="amount" autoFocus type="number" min="1" step="1" value={amount} onChange={e=>setAmount(e.target.value)} required placeholder="0"/></label><label>Комментарий<textarea name="comment" required defaultValue={row?.comment??''} placeholder="На что потрачены деньги?"/></label></>
 :kind==='production'?<><label>Что произвели<select value={productId} onChange={e=>setProductId(e.target.value)} required><option value="" disabled>Выберите товар</option>{products.map(p=><option value={p.id} key={p.id}>{p.name} · на складе {kg(p.stock_qty)}</option>)}</select></label>
  <div className="material-inputs"><p className="eyebrow">РАСХОД СЫРЬЯ</p>{materials.map(m=>{const over=num(used[m.id])>availableOf(m)+1e-9;return <label className={over?'over':''} key={m.id}>{m.name} <span>в наличии {kg(availableOf(m))}</span><input type="number" min="0" step="0.01" placeholder="0" value={used[m.id]??''} onChange={e=>setUsed({...used,[m.id]:e.target.value})}/></label>})}{shortages.length>0&&<p className="error">Недостаточно: {shortages.map(m=>`${m.name} (в наличии ${kg(availableOf(m))})`).join(', ')}</p>}</div>
  <label>Выпуск картона, кг<input type="number" min="0.01" step="0.01" value={output} onChange={e=>setOutput(e.target.value)} required placeholder="0"/></label>
  {num(output)>0&&usedTotal>0&&<p className="hint">Из <b>{kg(usedTotal)}</b> сырья получено <b>{kg(num(output))}</b> · выход {Math.round(num(output)/usedTotal*100)}%</p>}
  <label>Заметка <span>необязательно</span><input name="note" defaultValue={row?.note??''}/></label></>
 :kind==='intake'?<><label>Материал<select value={materialId} onChange={e=>setMaterialId(e.target.value)} required><option value="" disabled>Выберите материал</option>{materials.map(m=><option value={m.id} key={m.id}>{m.name} · на складе {kg(m.stock_qty)}</option>)}</select></label>
  <label>Сколько добавить, кг<input type="number" min="0.01" step="0.01" autoFocus value={intakeQty} onChange={e=>setIntakeQty(e.target.value)} required placeholder="0"/></label>
  {intakeMaterial&&num(intakeQty)>0&&<p className="hint">Станет: <b>{kg(intakeMaterial.stock_qty-ownIntake+num(intakeQty))}</b> — сейчас {kg(intakeMaterial.stock_qty)}</p>}
  <label>Заметка <span>необязательно</span><input name="note" defaultValue={row?.note??''} placeholder="Откуда поступило"/></label></>
 :<><label>{requiredType==='client'?'Клиент':'Поставщик'}<select name="personId" required defaultValue={preset}><option value="" disabled>Выберите</option>{available.map(p=><option value={p.id} key={p.id}>{p.name} · долг {money(Math.max(0,-p.balance_cents))}</option>)}</select></label>
  {kind==='sale'&&<><label>Товар<select value={productId} onChange={e=>setProductId(e.target.value)} required><option value="" disabled>Выберите товар</option>{products.map(p=><option value={p.id} key={p.id}>{p.name} · на складе {kg(p.stock_qty)}</option>)}</select></label><div className="form-pair"><label className={overSell?'over':''}>Вес, кг {product&&<span>в наличии {kg(stock)}</span>}<input name="quantity" type="number" min="0.01" step="0.01" value={qtyIn} onChange={e=>setQtyIn(e.target.value)} required/></label><label>Цена за кг<input name="amount" type="number" min="1" step="1" value={unit} onChange={e=>setUnit(e.target.value)} required/></label></div>{overSell&&<p className="error">Недостаточно на складе: нужно {kg(saleQty)}, в наличии {kg(stock)}</p>}{saleTotal>0&&!overSell&&<p className="hint">Итого: <b>{money(saleTotal)}</b></p>}</>}
  {kind==='purchase'&&<><label>Материал<select value={materialId} onChange={e=>setMaterialId(e.target.value)} required><option value="" disabled>Выберите материал</option>{materials.map(m=><option value={m.id} key={m.id}>{m.name} · на складе {kg(m.stock_qty)}</option>)}</select></label><div className="form-pair"><label>Вес, кг<input name="quantity" type="number" min="0.01" step="0.01" value={weight} onChange={e=>setWeight(e.target.value)} required/></label><label>Цена за кг<input name="unitPrice" type="number" min="1" step="1" value={perKg} onChange={e=>setPerKg(e.target.value)} required/></label></div><label>Итого <span>автоматически</span><input name="amount" readOnly required value={purchaseTotal?purchaseTotal/100:''}/></label>{purchaseTotal>0&&<p className="hint">Итого: <b>{money(purchaseTotal)}</b></p>}</>}
  {(kind==='client_payment'||kind==='supplier_payment')&&<label>Сумма<input name="amount" type="number" min="1" step="1" value={amount} onChange={e=>setAmount(e.target.value)} required/></label>}
  <label>Заметка <span>необязательно</span><input name="note" defaultValue={row?.note??''}/></label></>}
 {error&&<p className="error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary" onClick={close}>Отмена</button><button className="primary" disabled={blocked}>{busy?'Сохранение…':editing?'Сохранить изменения':'Сохранить'}</button></div></form></div></div>
}
