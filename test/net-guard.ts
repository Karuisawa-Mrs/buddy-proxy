// test/net-guard.ts — a gateway started by a test must not reach the internet.
//
//   node --import ./test/net-guard.ts router-proxy.ts
//
// test/harness.ts preloads this into every gateway it starts, and every node
// test task in mise.toml runs with it (`node --import ./test/net-guard.ts ...`),
// so the test process itself is guarded as well. The tests point
// every upstream at a fake on 127.0.0.1; a request to anywhere else means an
// upstream base was not overridden, and the test would spend real quota (or
// rotate a real session) without anybody noticing. So such a request fails
// at once, the failure names the host in the log, and the process exits
// non-zero (test/harness.ts also fails the test when its gateway's log has it).
//
// Covered: globalThis.fetch and node:http / node:https request() and get().
// Not covered: raw sockets (net.connect) and DNS lookups. The gateway's own
// upstream traffic goes through the two above, and patching net would also
// catch the test's own loopback plumbing for no gain.

import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

let blockedCount = 0;

function blocked(host: string, how: string): Error {
  blockedCount++;
  const message = `[NET-GUARD] blocked ${how} to ${host}: a test gateway may only talk to 127.0.0.1`;
  console.error(message);
  return new Error(message);
}

// A blocked request turns into an error the code under test may well swallow
// (a fallback, a retry, a catch that logs and moves on), and the test would go
// green with the leak in it. So the process that was stopped fails on the way
// out, whatever it was about to exit with. process.exit(0) sets exitCode before
// the "exit" listeners run, and node exits with exitCode after them.
// NET_GUARD_EXPECT_BLOCKS=1 is for test/net-guard-check.ts, whose child is
// there to be blocked.
process.on("exit", () => {
  if (blockedCount === 0 || process.env.NET_GUARD_EXPECT_BLOCKS === "1") return;
  console.error(`[NET-GUARD] ${blockedCount} request(s) to a non-loopback host were blocked: failing this process`);
  process.exitCode = 1;
});

function hostOf(input: unknown): string {
  try {
    if (typeof input === "string") return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input && typeof input === "object" && "url" in input) return new URL(String((input as { url: string }).url)).hostname;
  } catch {
    /* not a URL: let the real call explain what is wrong with it */
  }
  return "";
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = hostOf(input);
  if (host && !LOOPBACK.has(host)) throw blocked(host, "fetch");
  return realFetch(input, init);
}) as typeof fetch;

type HostOptions = { hostname?: unknown; host?: unknown };

/**
 * The host a request() call goes to, decided the way node decides it:
 * request(url, options) spreads the options over the URL's own fields, so an
 * options.hostname or options.host beats the URL; then hostname || host ||
 * "localhost". Reading the URL first would let request("http://127.0.0.1",
 * { hostname: "example.com" }) through.
 */
export function requestHost(args: unknown[]): string {
  const [first, second] = args;
  const isUrl = typeof first === "string" || first instanceof URL;
  const fromUrl: HostOptions = isUrl ? { hostname: hostOf(first) } : {};
  const options = (isUrl ? second : first) as HostOptions | undefined;
  const merged: HostOptions =
    options && typeof options === "object" ? { ...fromUrl, ...options } : fromUrl;
  const host = String(merged.hostname || merged.host || "localhost");
  // node strips the brackets of an IPv6 literal; a "host" may carry a port.
  return host.startsWith("[") ? host : host.replace(/:\d+$/, "");
}

for (const [mod, name] of [[http, "http"], [https, "https"]] as const) {
  const realRequest = mod.request;
  const realGet = mod.get;
  (mod as any).request = (...args: unknown[]) => {
    const host = requestHost(args);
    if (!LOOPBACK.has(host)) throw blocked(host, `${name}.request`);
    return (realRequest as any)(...args);
  };
  (mod as any).get = (...args: unknown[]) => {
    const host = requestHost(args);
    if (!LOOPBACK.has(host)) throw blocked(host, `${name}.get`);
    return (realGet as any)(...args);
  };
}
// A marker other test code can check before it does anything on purpose
// (test/net-guard-check.ts only fires its leak once the guard is in place).
(globalThis as Record<symbol, unknown>)[Symbol.for("buddy.netGuard")] = true;

// `import { request } from "node:http"` reads the ES module's own copy of the
// export: push the patched functions into it as well.
syncBuiltinESMExports();
