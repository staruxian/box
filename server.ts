import { join } from "node:path";
import { databaseUrl, ensureSchema, handleApi } from "./lib/ledger.ts";

await ensureSchema();

const server=Bun.serve({port:Number(process.env.PORT||8790),async fetch(req){
  const url=new URL(req.url);
  if(url.pathname.startsWith("/api/"))return handleApi(req,url);
  const path=url.pathname==="/"?"index.html":url.pathname.slice(1),file=Bun.file(join(process.cwd(),"dist",path));
  if(await file.exists())return new Response(file);
  const index=Bun.file(join(process.cwd(),"dist","index.html"));return await index.exists()?new Response(index):new Response("Запустите `bun run dev`.",{status:404});
}});
console.log(`API журнала запущено на http://localhost:${server.port}`);
console.log(`База: Turso ${new URL(databaseUrl).host}`);
