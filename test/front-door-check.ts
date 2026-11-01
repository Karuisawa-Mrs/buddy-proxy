// test/front-door-check.ts — 前门：API key 校验、/health 的明细、key 轮换。
//
//   node --experimental-strip-types test/front-door-check.ts
//
// 离线：起的是本进程里的网关（lib/router/app.ts），只读自己的临时数据库，
// 不问任何上游。
//
// 覆盖：
//   1. public 模式（默认）：/health 带明细，不带 key 也行；
//   2. REQUIRE_API_KEY=true：错 key / 没 key 401，对 key 放行；
//      /health 没有有效 key 只答 {status}，带 key 才有账号明细；
//      /v1/models 也要 key；
//   3. key 轮换（数据库里换掉 keys:clients）不重启就生效：旧 key 401，新 key 放行。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "front-door-"));
process.env.BUDDY_DATA_DIR = tmp;
// 部署钉住的值会盖过面板写进库的那份；这里要能来回切，所以环境里不能有它。
delete process.env.REQUIRE_API_KEY;

const { app } = await import("../lib/router/app.ts");
const { addAccount } = await import("../lib/providers.ts");
const { configOverride } = await import("../lib/config.ts");
const { loadKeys, KEYS_TTL_MS } = await import("../lib/api-keys.ts");
const { setSecret, closeStore } = await import("../lib/store.ts");

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

async function get(p: string, key?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${p}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function postMessages(key?: string): Promise<number> {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: JSON.stringify({ model: "nope", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  });
  await res.arrayBuffer();
  return res.status;
}

addAccount({ platform: "minimax", alias: "前门测试账号" });
const keys = loadKeys();
const goodKey = keys.admin;

console.log("");
console.log("public 模式（默认）");
{
  const health = await get("/health");
  check("/health 不带 key 也有明细", health.status === 200 && Boolean(health.body?.upstreams?.minimax), JSON.stringify(health.body).slice(0, 120));
  check("/health 说是 public", health.body?.auth === "public", String(health.body?.auth));
  check("没 key 的请求不是 401", (await postMessages()) !== 401);
  check("/v1/models 不带 key 不是 401", (await get("/v1/models")).status !== 401);
}

console.log("");
console.log("REQUIRE_API_KEY=true");
configOverride("REQUIRE_API_KEY", "true");
{
  check("没 key 401", (await postMessages()) === 401);
  check("错 key 401", (await postMessages("oc-wrong")) === 401);
  check("同长度的错 key 也 401", (await postMessages(goodKey.slice(0, -1) + (goodKey.endsWith("0") ? "1" : "0"))) === 401);
  check("对 key 放行（不是 401）", (await postMessages(goodKey)) !== 401);

  const bare = await get("/health");
  check("/health 没 key 仍是 200", bare.status === 200, String(bare.status));
  check(
    "/health 没 key 只有 status",
    JSON.stringify(bare.body) === JSON.stringify({ status: "ok" }),
    JSON.stringify(bare.body).slice(0, 160),
  );
  const wrong = await get("/health", "oc-wrong");
  check("/health 错 key 只有 status", Object.keys(wrong.body ?? {}).join(",") === "status", JSON.stringify(wrong.body).slice(0, 160));
  const full = await get("/health", goodKey);
  check("/health 对 key 有账号明细", Array.isArray(full.body?.upstreams?.minimax?.accounts), JSON.stringify(full.body).slice(0, 160));
  check("/health 对 key 说是 api-key", full.body?.auth === "api-key", String(full.body?.auth));

  check("/v1/models 没 key 401", (await get("/v1/models")).status === 401);
  check("/minimax/v1/models 没 key 401", (await get("/minimax/v1/models")).status === 401);
  check("/v1/models 对 key 不是 401", (await get("/v1/models", goodKey)).status !== 401);
}

console.log("");
console.log("key 轮换不重启");
{
  const fresh = "oc-rotated-" + "a".repeat(30);
  setSecret("keys:clients", "key", { keys: { admin: fresh } });
  // 缓存最多留 KEYS_TTL_MS：等它过期。
  await new Promise((r) => setTimeout(r, KEYS_TTL_MS + 200));
  check("旧 key 401", (await postMessages(goodKey)) === 401);
  check("新 key 放行", (await postMessages(fresh)) !== 401);
  const full = await get("/health", fresh);
  check("新 key 读得到 /health 明细", Boolean(full.body?.upstreams), JSON.stringify(full.body).slice(0, 120));
}

configOverride("REQUIRE_API_KEY", "false");
server.close();
closeStore();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
process.exit(fail === 0 ? 0 : 1);
