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
import { ensureSchema, handleApi } from "../lib/ledger.js";

async function serve(req: Request): Promise<Response> {
  await ensureSchema();
  return handleApi(req, new URL(req.url));
}

export const GET = serve;
export const POST = serve;
export const PATCH = serve;
export const DELETE = serve;
export const OPTIONS = serve;
