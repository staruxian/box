// Vercel entry point: one edge function behind every /api/* route, sharing the handler with server.ts.
import { ensureSchema, handleApi } from "../lib/ledger.ts";

export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
  await ensureSchema();
  return handleApi(req, new URL(req.url));
}
