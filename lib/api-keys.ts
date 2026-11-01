// lib/api-keys.ts — the shared front-door API-key check for every proxy here.
//
// The keys live in the database (the secrets table, under `keys:clients`).
// api-keys.json is only the fallback: it is read once, when the database has
// no keys yet, so a fresh install without the file just gets a new pair.
//
// Default is public mode (any key, or none, passes) because the upstream free
// tier is gated by the client's own login, not by a client-supplied key.
// `REQUIRE_API_KEY=true` turns the front door on for every proxy in the repo.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configFlag, markHotSetting } from "./config.ts";
import { readEnvValue } from "./env.ts";
import { getSecret, setSecret } from "./store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The front door is checked on every request, so the switch is hot: the panel
// turns it on and the next request meets the locked door.
markHotSetting("REQUIRE_API_KEY");

// Ask for it here, at load time: a setting nobody has asked for is not in the
// snapshot, so the panel would not show it and config-cli would refuse to
// write it. The value itself is read again on every request.
configFlag("REQUIRE_API_KEY", false);

/** Does the front door need a key? The value in use right now. */
export function requireApiKey(): boolean {
  return configFlag("REQUIRE_API_KEY", false);
}

// The file the keys used to live in. It is only read once, when the database
// has no keys yet, so it stays a path the deployment decides.
export const KEYS_FILE = readEnvValue("KEYS_FILE") || path.join(HERE, "..", "api-keys.json");

export type KeyStore = Record<string, string>;

/** Where the agents' keys are kept. */
const KEYS_ID = "keys:clients";

/** Whether the empty key table has been reported (once, not every reload). */
let warnedEmpty = false;

/**
 * Load the agents' keys, generating one set on a fresh install.
 *
 * "No record" and "an empty table" are not the same. No record is a fresh
 * install: a pair is generated, as always. An empty table is someone having
 * cleared the keys: generating a fresh random pair then would silently replace
 * them with keys nobody has. The table stays empty instead — every request
 * with a key is refused — and the log says why.
 */
export function loadKeys(prefix = "oc-"): KeyStore {
  let keys: KeyStore = {};
  const stored = getSecret<{ keys: KeyStore }>(KEYS_ID);
  if (stored?.keys && typeof stored.keys === "object") {
    keys = stored.keys;
    if (Object.keys(keys).length === 0) {
      if (!warnedEmpty) {
        console.warn(
          `[INIT] the API key table (${KEYS_ID}) is empty: not generating new keys, ` +
            "every request is refused while REQUIRE_API_KEY is on. Put the keys back into the table to let the agents in.",
        );
        warnedEmpty = true;
      }
      return keys;
    }
    warnedEmpty = false;
  } else {
    // The file the keys used to live in.
    try {
      const fromFile = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
      if (fromFile && typeof fromFile === "object") keys = fromFile;
    } catch {
      keys = {};
    }
  }
  if (Object.keys(keys).length === 0) {
    keys = {
      admin: prefix + crypto.randomBytes(20).toString("hex"),
      "user-default": prefix + crypto.randomBytes(20).toString("hex"),
    };
    setSecret(KEYS_ID, "key", { keys });
    console.log("[INIT] Generated new API keys → the database");
  }
  return keys;
}

/** Bearer token, x-api-key header, or raw Authorization header. */
export function extractToken(headers: Record<string, unknown>): string {
  const hdr: string = (headers.authorization as string) || (headers["x-api-key"] as string) || "";
  return hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
}

/**
 * How long the keys read from the store are trusted.
 *
 * The keys are checked on every request, and they can change underneath the
 * running gateway (rotated in the database, or in the fallback file). Reading
 * them once at startup meant a revoked key kept working until a restart; a
 * short cache keeps a rotation to a few seconds without a database read per
 * request.
 */
export const KEYS_TTL_MS = 2000;

let cachedKeys: { keys: KeyStore; at: number } | null = null;

/** The agents' keys as of now (at most KEYS_TTL_MS old). */
export function currentKeys(): KeyStore {
  const now = Date.now();
  if (!cachedKeys || now - cachedKeys.at >= KEYS_TTL_MS) cachedKeys = { keys: loadKeys(), at: now };
  return cachedKeys.keys;
}

/** sha256 of a string: equal-length inputs for timingSafeEqual. */
function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

/**
 * Returns the key name, or null when a required key is missing/unknown.
 *
 * The comparison takes the same time whichever key matches and however much of
 * it does: both sides are hashed to the same length, compared with
 * timingSafeEqual, and every key is compared — no early return on a match.
 */
export function authenticate(headers: Record<string, unknown>, keys: KeyStore = currentKeys()): string | null {
  const tok = extractToken(headers);
  // Public mode (default): accept anything, even a blank token.
  if (!requireApiKey()) return "public";
  const given = digest(tok);
  let found: string | null = null;
  for (const [name, key] of Object.entries(keys)) {
    if (typeof key !== "string" || !key) continue;
    if (crypto.timingSafeEqual(given, digest(key)) && found === null) found = name;
  }
  return found;
}
