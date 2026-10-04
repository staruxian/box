// Vercel entry point: one function behind every /api/* route, sharing the handler with server.ts.
//
// Node runtime, not edge: @libsql/hrana-client imports @libsql/isomorphic-ws unconditionally, and
// that package has no edge-light export condition, so an edge bundle resolves it to the node build
// and drags `ws` — node:net, node:tls, node:crypto — into a runtime that has none of them.
// lib/ledger.ts still imports @libsql/client/web, which keeps the native libsql binary out of the
// bundle; it is plain fetch, so it is happy on Node too.
//
// The import ends in .js, not .ts: Vercel typechecks this file with its own tsconfig, which has no
// allowImportingTsExtensions. TypeScript and esbuild both resolve it back to the .ts source.
import type { IncomingMessage, ServerResponse } from "node:http";
import { ensureSchema, handleApi } from "../lib/ledger.js";

// Classic (req, res) signature: the launcher always supports it, unlike the named web-handler exports.
// The platform helpers may already have parsed the body, so prefer req.body over re-reading the stream.
export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  try {
    await ensureSchema();
    const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
    let body: string | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.body !== undefined) body = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
      else { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); body = Buffer.concat(chunks).toString(); }
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const out = await handleApi(new Request(url.href, { method: req.method, headers, body }), url);
    res.statusCode = out.status;
    out.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : "Ошибка сервера" }));
  }
}
