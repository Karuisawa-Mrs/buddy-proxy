// lib/router/body-limit.ts — how large a request body the gateway reads.
//
// koa-bodyparser hands the limit to raw-body, which parses it with `bytes`. A
// value `bytes` cannot read ("lots", "-1", "16 megs") comes back as null, and a
// null limit is no limit at all: a typo in ROUTER_JSON_LIMIT would let any
// body be held in memory whole. So the value is parsed here, and a value that
// does not parse falls back to the default with a warning.

import { configString } from "../config.ts";

/** The default limit, and what an unreadable value falls back to. */
export const DEFAULT_JSON_LIMIT = "16mb";

const UNITS: Record<string, number> = {
  "": 1,
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
};

/**
 * A size like `16mb`, `512kb`, `1.5gb` or `1048576`, in bytes; null when it is
 * not one. Units are binary (1kb = 1024 bytes), the same as `bytes`.
 */
export function parseByteSize(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(text);
  if (!match) return null;
  const bytes = Math.floor(Number(match[1]) * UNITS[(match[2] ?? "").toLowerCase()]);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

/**
 * The body limit from ROUTER_JSON_LIMIT, as the plain byte count koa-bodyparser
 * takes (a string of digits: `bytes` reads it back unchanged).
 */
export function jsonLimit(): string {
  const raw = configString("ROUTER_JSON_LIMIT", DEFAULT_JSON_LIMIT);
  const parsed = parseByteSize(raw);
  if (parsed !== null) return String(parsed);
  console.warn(
    `[CONFIG] ROUTER_JSON_LIMIT=${JSON.stringify(raw)} is not a size (like 16mb or 512kb), using ${DEFAULT_JSON_LIMIT}`,
  );
  return String(parseByteSize(DEFAULT_JSON_LIMIT));
}
