import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerStaticServing } from "../../../apps/server/src/api/static";

const SHELL = "<!doctype html><title>Chief of Staff</title><div id=root></div>";

let app: FastifyInstance | null = null;

function makeWebDist(withIndex: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "web-dist-"));
  if (withIndex) {
    writeFileSync(join(dir, "index.html"), SHELL);
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "index-live.js"), "export const live = true;\n");
  }
  return dir;
}

async function serve(withIndex = true): Promise<FastifyInstance> {
  const instance = fastify({ logger: false });
  await registerStaticServing(instance, { webDist: makeWebDist(withIndex) });
  await instance.ready();
  app = instance;
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("static serving — a miss means different things for assets, client routes and the API", () => {
  it("serves a real asset", async () => {
    const server = await serve();
    const res = await server.inject({ method: "GET", url: "/assets/index-live.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("export const live");
  });

  it("404s a stale hashed asset instead of handing back the shell", async () => {
    const server = await serve();
    const res = await server.inject({ method: "GET", url: "/assets/index-STALE.js" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("<div id=root>");
    expect(res.json()).toEqual({ error: "not found" });
  });

  it("404s any extension-bearing miss outside the asset prefix", async () => {
    const server = await serve();
    for (const url of ["/missing.js", "/missing.css", "/nested/path/missing.map"]) {
      const res = await server.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("still serves the shell for client routes, including deep and query-carrying ones", async () => {
    const server = await serve();
    for (const url of [
      "/settings",
      "/runs/run_20260829-062332_1d82d47c",
      "/meeting-brief?tab=live",
    ]) {
      const res = await server.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain("<div id=root>");
    }
  });

  it("keeps unknown API routes and non-GET methods on JSON 404", async () => {
    const server = await serve();
    const api = await server.inject({ method: "GET", url: "/api/nope" });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: "not found" });

    const post = await server.inject({ method: "POST", url: "/settings" });
    expect(post.statusCode).toBe(404);
    expect(post.json()).toEqual({ error: "not found" });
  });

  it("404s every GET when no bundle was built", async () => {
    const server = await serve(false);
    const res = await server.inject({ method: "GET", url: "/settings" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
  });
});
