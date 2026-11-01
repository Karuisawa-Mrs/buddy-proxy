// test/net-guard-check.ts — the guard that keeps a test gateway off the internet.
//
//   node --experimental-strip-types test/net-guard-check.ts
//
// Runs a child with test/net-guard.ts preloaded, the way test/harness.ts runs
// the gateway, and checks that a request to a real host fails before it leaves
// the machine while one to 127.0.0.1 still goes through. Nothing is sent out:
// the guard throws before any socket is opened.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = pathToFileURL(path.join(ROOT, "test", "net-guard.ts")).href;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// A loopback server the guarded child may reach.
const server = http.createServer((_req, res) => res.end("ok"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const script = `
  import http from "node:http";
  import https from "node:https";
  import { request as namedRequest } from "node:https";
  const out = {};
  const attempt = async (name, fn) => {
    try { await fn(); out[name] = "passed"; } catch (e) { out[name] = String(e.message).includes("NET-GUARD") ? "blocked" : "error: " + e.message; }
  };
  await attempt("fetch-out", () => fetch("https://example.com/"));
  await attempt("https-request-out", () => { https.request("https://example.com/").destroy(); });
  await attempt("https-named-out", () => { namedRequest({ hostname: "example.com", path: "/" }).destroy(); });
  await attempt("http-get-out", () => { http.get({ host: "example.com", path: "/" }).destroy(); });
  // node spreads the options over the URL: options.hostname / host win.
  await attempt("url-loopback-options-out", () => { http.request("http://127.0.0.1:${port}/", { hostname: "example.com" }).destroy(); });
  // ...but hostname beats host: the URL's hostname (example.com) wins over a loopback options.host.
  await attempt("url-out-options-host-loopback", () => { http.request(new URL("http://example.com/"), { host: "127.0.0.1", port: ${port} }).destroy(); });
  await attempt("url-out-options-loopback", () => new Promise((resolve, reject) => {
    http.get("http://example.com/", { hostname: "127.0.0.1", port: ${port} }, (r) => { r.resume(); r.on("end", resolve); }).on("error", reject);
  }));
  await attempt("fetch-loopback", async () => { const r = await fetch("http://127.0.0.1:${port}/"); if ((await r.text()) !== "ok") throw new Error("wrong body"); });
  await attempt("http-loopback", () => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: ${port}, path: "/" }, (r) => { r.resume(); r.on("end", resolve); }).on("error", reject);
  }));
  console.log(JSON.stringify(out));
`;

// Not spawnSync: it would block this process's event loop, and with it the
// loopback server the child is asking.
const child = spawn(process.execPath, ["--import", GUARD, "--input-type=module", "-e", script], {
  cwd: ROOT,
  // This child is there to be blocked: without this the guard fails it on exit.
  env: { ...process.env, NET_GUARD_EXPECT_BLOCKS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
const code: number = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
server.close();

let result: Record<string, string> = {};
try {
  result = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
} catch {
  /* reported below */
}
check("子进程跑完了", code === 0, `${code} ${stderr.slice(-300)}`);
check("fetch 出网被挡", result["fetch-out"] === "blocked", result["fetch-out"]);
check("https.request 出网被挡", result["https-request-out"] === "blocked", result["https-request-out"]);
check("具名导入的 https.request 也被挡", result["https-named-out"] === "blocked", result["https-named-out"]);
check("http.get 出网被挡", result["http-get-out"] === "blocked", result["http-get-out"]);
check("URL 是回环、options.hostname 指外网 → 按 options 挡", result["url-loopback-options-out"] === "blocked", result["url-loopback-options-out"]);
check("URL 指外网、options 只给回环的 host → hostname 优先，挡", result["url-out-options-host-loopback"] === "blocked", result["url-out-options-host-loopback"]);
check("URL 指外网、options.hostname 是回环 → 按 options 放行", result["url-out-options-loopback"] === "passed", result["url-out-options-loopback"]);
check("fetch 到 127.0.0.1 照常", result["fetch-loopback"] === "passed", result["fetch-loopback"]);
check("http.get 到 127.0.0.1 照常", result["http-loopback"] === "passed", result["http-loopback"]);
check("挡下的时候日志里说了是哪个主机", stderr.includes("[NET-GUARD] blocked fetch to example.com"), stderr.slice(-300));

// The guard fails the process that was stopped, even if the code swallowed the error.
const swallow = spawn(
  process.execPath,
  ["--import", GUARD, "--input-type=module", "-e", `try { await fetch("https://example.com/"); } catch {} process.exit(0);`],
  { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, NET_GUARD_EXPECT_BLOCKS: "" } },
);
let swallowErr = "";
swallow.stderr.on("data", (c: Buffer) => (swallowErr += c.toString()));
const swallowCode: number = await new Promise((resolve) => swallow.on("exit", (c) => resolve(c ?? 1)));
check("吞掉了拦截错误的进程照样以非零退出", swallowCode !== 0, `${swallowCode} ${swallowErr.slice(-200)}`);

// test/harness.ts：网关日志里有 [NET-GUARD]，起它的测试进程就失败。
// 让网关自己漏一次：NODE_OPTIONS 再预加载一个小脚本，网关起来后往外发一个
// 请求再吞掉错误。目标是 .invalid（保留的顶级域，解析不出来），脚本也先确认
// net-guard 已经装上才发，所以就算顺序不对也出不了机器。
const TMP = path.join(ROOT, "test", ".tmp");
fs.mkdirSync(TMP, { recursive: true });
const leakFile = path.join(TMP, `net-guard-leak-${process.pid}.mjs`);
fs.writeFileSync(
  leakFile,
  `setTimeout(() => { if (globalThis[Symbol.for("buddy.netGuard")]) fetch("https://leak.example.invalid/").catch(() => {}); }, 200);\n`,
);
const HARNESS = pathToFileURL(path.join(ROOT, "test", "harness.ts")).href;
const harnessScript = `
  const { startGateway } = await import(${JSON.stringify(HARNESS)});
  const gw = await startGateway({
    env: { NODE_OPTIONS: ${JSON.stringify(`${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(leakFile).href}`.trim())} },
  });
  await new Promise((r) => setTimeout(r, 1500));
  await gw.stopAndWait();
  process.exit(0);
`;
const viaHarness = spawn(process.execPath, ["--input-type=module", "-e", harnessScript], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
let harnessOut = "";
viaHarness.stdout.on("data", (c: Buffer) => (harnessOut += c.toString()));
viaHarness.stderr.on("data", (c: Buffer) => (harnessOut += c.toString()));
const harnessCode: number = await new Promise((resolve) => viaHarness.on("exit", (c) => resolve(c ?? 1)));
fs.rmSync(leakFile, { force: true });
check("网关被拦过请求，harness 让测试进程失败", harnessCode === 1, `${harnessCode} ${harnessOut.slice(-400)}`);
check("harness 打出了被拦的主机", harnessOut.includes("[NET-GUARD] blocked fetch to leak.example.invalid"), harnessOut.slice(-400));

console.log("");
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
