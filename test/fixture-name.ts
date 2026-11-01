// test/fixture-name.ts — how a fixture is named.
//
// The recorder, the mock server and the capture script have to agree on it, so
// it lives in one place.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubBody, scrubHeaders, scrubUpstream } from "./fixture-scrub.ts";

// The path of this file, as the platform sees it. `new URL(...).pathname` is
// a POSIX path — on Windows it starts with a slash ("/D:/projects/..."), and
// joining it with path.join() yields "\D:\projects\...", which does not exist.
// fileURLToPath() is the one that gives the native path.
//
// Where the fixtures came from: each one records its source in `upstream`.
// Most are the platforms themselves; the two MiniMax ones
// (post-minimax-v1-messages-*) were recorded through a gateway on the LAN
// (MINIMAX_RECORD_BASE), not from MiniMax Code directly. The personal fields
// were scrubbed afterwards (test/fixture-scrub.ts).
export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A name for the fixture: the method, the whole path and the variant. */
export function fixtureName(method: string, route: string, variant: string): string {
  const slug = route.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";
  return `${method.toLowerCase()}-${slug}${variant === "all" ? "" : `-${variant}`}.json`;
}

/**
 * Which variant of the answer a request wants.
 *
 * The same path serves a streaming and a non-streaming request, and the two
 * answers have different shapes — so they cannot share a fixture. A request
 * that carries tools gets its own fixture as well: the answer is a tool call
 * rather than an answer.
 */
export function variantOf(body: Buffer | string): string {
  try {
    const parsed = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
    if (parsed && typeof parsed === "object") {
      const tools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const stream = typeof parsed.stream === "boolean" ? (parsed.stream ? "stream" : "nostream") : "all";
      return tools ? `${stream}-tools` : stream;
    }
  } catch {
    /* not JSON — the legacy protocol sends its own encoded body */
  }
  return "all";
}

export interface Fixture {
  upstream: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Write a fixture down, scrubbed: the fixtures are committed, so the account's
 * own fields and headers never reach the file (test/fixture-scrub.ts).
 *
 * FIXTURE_DIR_OUT points the recording somewhere else: capture.sh records into
 * a fresh directory and only swaps it in when the whole run succeeded.
 */
export function writeFixture(name: string, fixture: Fixture): void {
  const dir = process.env.FIXTURE_DIR_OUT || FIXTURE_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const clean: Fixture = { ...fixture, upstream: scrubUpstream(fixture.upstream), headers: scrubHeaders(fixture.headers), body: scrubBody(fixture.body) };
  fs.writeFileSync(path.join(dir, name), JSON.stringify(clean, null, 2) + "\n");
}

export function readFixture(name: string): Fixture | null {
  const file = path.join(FIXTURE_DIR, name);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;
  } catch {
    return null;
  }
}
