import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

export interface StaticServingOptions {
  /** Directory holding the built web bundle (index.html plus assets/). */
  webDist: string;
}

/**
 * A miss the browser will try to parse as something other than a page: it
 * carries a file extension, or it sits under the bundle's asset prefix. A
 * stale hashed asset is the case that matters — answering it with the SPA
 * shell hands the browser HTML where it expected a module, and the person
 * sees an opaque MIME error instead of the 404 that explains it (issue #101).
 */
function looksLikeAsset(pathname: string): boolean {
  if (pathname.startsWith("/assets/")) return true;
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9]+$/.test(lastSegment);
}

/**
 * Serve the built web bundle and decide what a miss means. Client routes are
 * indistinguishable from typos at this layer, so they keep the HTML fallback;
 * asset-shaped misses and unknown API routes fail loudly instead.
 */
export async function registerStaticServing(
  app: FastifyInstance,
  options: StaticServingOptions,
): Promise<void> {
  const { webDist } = options;
  const hasIndex = existsSync(join(webDist, "index.html"));
  if (hasIndex) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
  }
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?")[0] ?? "/";
    if (pathname.startsWith("/api/") || request.method !== "GET") {
      reply.code(404).send({ error: "not found" });
      return;
    }
    if (hasIndex && !looksLikeAsset(pathname)) {
      reply.code(200).sendFile("index.html");
      return;
    }
    reply.code(404).send({ error: "not found" });
  });
}
