// test/fixture-scrub.ts — what a recorded answer may keep before it is written down.
//
// The fixtures are committed, so whatever the upstream said about the account
// (its id, its name, its mail, its avatar) would end up in the repository.
// record-proxy.ts and capture-legacy.ts run every answer through here first.
//
// Only what the mock server needs to replay the answer survives: the body with
// the personal fields replaced by placeholders of the same shape, and the few
// headers that change how the router reads the body.

/** The headers the replay needs. The rest (cookies, user ids, client IPs, trace ids) is the account's. */
const KEEP_HEADERS = new Set(["content-type", "transfer-encoding", "cache-control", "x-accel-buffering", "retry-after"]);

/** Fields that are personal wherever they appear. */
const PERSONAL = new Set([
  "email", "mail", "phone", "mobile", "phonenumber", "avatar", "avatarurl",
  "userid", "user_id", "uid", "username", "user_name", "nickname", "nick_name", "realname", "real_name",
]);

/**
 * Fields that are personal only in an object that describes a user: "id" and
 * "name" also name a model, a tool or a message, and those must stay as they
 * are or the replay answers something else.
 */
const PERSONAL_IN_USER = new Set(["id", "name"]);

function isUserShaped(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some((k) => PERSONAL.has(k.toLowerCase()) || k === "userType");
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** A UUID made up by hand: almost all zeros (a real one has ~30 non-zero hex digits). */
function isPlaceholderUuid(text: string): boolean {
  return text.replace(/[-0]/g, "").length <= 8;
}

/**
 * Values that are already placeholders and may stay as they are: hand-written
 * fixtures (and the ones scrubbed by hand) use their own placeholders rather than
 * the exact strings placeholder() would pick. Narrow on purpose: reserved mail
 * domains (RFC 2606), a "test user" name, near-zero UUIDs, and URLs whose only
 * identifier is such a UUID.
 */
function isPlaceholder(key: string, value: string): boolean {
  const k = key.toLowerCase();
  if (k.includes("mail")) return /@example\.(com|org|net)$/i.test(value);
  if (/^test[-_ ]?user$/i.test(value)) return true;
  const uuids = value.match(UUID) ?? [];
  if (uuids.length === 0) return false;
  if (!uuids.every(isPlaceholderUuid)) return false;
  return value.length === uuids[0].length || /^https:\/\//.test(value);
}

/** A placeholder with the same shape: a UUID stays a UUID, a number stays a number. */
function placeholder(key: string, value: unknown): unknown {
  if (typeof value === "number") return 0;
  if (typeof value !== "string" || value === "") return value;
  if (isPlaceholder(key, value)) return value;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return "00000000-0000-0000-0000-000000000000";
  }
  const k = key.toLowerCase();
  if (k.includes("mail")) return "user@example.com";
  if (k.includes("avatar")) return "https://example.com/avatar.png";
  if (k.includes("phone") || k === "mobile") return "00000000000";
  if (/^\d+$/.test(value)) return "0".repeat(value.length);
  return "test-user";
}

export function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubValue);
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const user = isUserShaped(obj);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    const personal = PERSONAL.has(key.toLowerCase()) || (user && PERSONAL_IN_USER.has(key));
    out[key] = personal && (typeof v === "string" || typeof v === "number") ? placeholder(key, v) : scrubValue(v);
  }
  return out;
}

/** One JSON text, scrubbed; anything that is not JSON is left alone. */
function scrubJson(text: string): string {
  try {
    const parsed = JSON.parse(text);
    const scrubbed = JSON.stringify(scrubValue(parsed));
    // Nothing personal in it: keep the upstream's own bytes (its spacing, its
    // escapes), so the replay is what the upstream sent.
    return scrubbed === JSON.stringify(parsed) ? text : scrubbed;
  } catch {
    return text;
  }
}

/** The body: a JSON answer, or a stream whose `data:` lines carry JSON. */
export function scrubBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const scrubbed = scrubJson(trimmed);
    return scrubbed === trimmed ? body : scrubbed;
  }
  return body.replace(/^(data:\s?)(\{.*\})$/gm, (_m, prefix: string, json: string) => prefix + scrubJson(json));
}

/**
 * The `upstream` field: where the answer came from. A recording made through a
 * local relay names a machine on the LAN, and its address is the network's, not
 * the upstream's; the replay only needs the path. Private, loopback and
 * link-local IPv4 hosts become 127.0.0.1; public hosts (the platforms) stay.
 */
export function scrubUpstream(url: string): string {
  return url.replace(/^(\w+:\/\/)([^/:?#]+)/, (whole, scheme: string, host: string) =>
    isPrivateIPv4(host) ? scheme + "127.0.0.1" : whole,
  );
}

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (KEEP_HEADERS.has(key.toLowerCase())) out[key.toLowerCase()] = value;
  }
  return out;
}
