// test/balance-panel-check.ts — 额度页的后端：首屏只读快照、单家失败不消失、七牛按段写。
//
//   node --experimental-strip-types test/balance-panel-check.ts
//
// 离线：临时数据目录，假的 Qoder 上游（本机端口），不碰真凭据。
//
//   1. GetBalance 空 upstream_id + peek：不问上游、不等全量刷新，立刻回快照；
//      而且把名下有账号的平台列出来（快照里还没数的也在）。
//   2. 单家这一轮没问到：账号不消失，带 error，数是上一次的（stale）。
//   3. upstream_id 一律是平台 id，account_id 是账号 id。
//   4. 七牛按段写：只写 API key 时门户 cookie 不动；空值不清；清除只认 clear。

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "balance-panel-"));
process.env.BUDDY_DATA_DIR = tmp;

let pass = 0;
let fail = 0;

function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log("");
  console.log(title);
}

/* ------------------------------------------------------------------ *
 * 假的 Qoder：额度接口的行为由测试切换
 * ------------------------------------------------------------------ */

type Mode = "ok" | "hang" | "fail";
let mode: Mode = "ok";
let quotaCalls = 0;
/** hang 模式下压着没回的请求：测试说放才放（不按墙钟等）。 */
const held: (() => void)[] = [];
function releaseHeld(): void {
  for (const reply of held.splice(0)) reply();
}

const fake = http.createServer((req, res) => {
  const url = String(req.url ?? "");
  if (url.endsWith("/api/v3/user/status")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ userId: "u1", status: "active" }));
    return;
  }
  if (url.endsWith("/api/v2/quota/usage")) {
    quotaCalls++;
    if (mode === "hang") {
      // 慢的那一家：测试放行之前不回。首屏不该等它。
      held.push(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ userQuota: { total: 100, used: 10, remaining: 90 } }));
      });
      return;
    }
    if (mode === "fail") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ userQuota: { total: 100, used: 30, remaining: 70 } }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
const fakeBase = `http://127.0.0.1:${(fake.address() as net.AddressInfo).port}`;
process.env.QODER_GLOBAL_OPENAPI_BASE = fakeBase;

const { addAccount } = await import("../lib/providers.ts");
const { setSecret, closeStore } = await import("../lib/store.ts");
const { create } = await import("@bufbuild/protobuf");
const { GetBalanceRequestSchema } = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");
const { adminService } = await import("../lib/admin/service.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { qiniuInferenceKey, qiniuPortalCookie } = await import("../lib/qiniu/account.ts");

// 一个 Qoder 全球区账号，带一份能用的会话。
const qoder = addAccount({ platform: "qoder", alias: "邱德一" });
const qoderId = qoder.id ?? "";
setSecret(`session:provider:${qoderId}`, "session", {
  schemaVersion: 1,
  region: "global",
  clientId: "c",
  accessToken: "dt-test",
  refreshToken: "drt-test",
  userId: "u1",
  expiresAtMs: Date.now() + 3_600_000,
  refreshExpiresAtMs: Date.now() + 86_400_000,
  machineId: "m",
  machineToken: "t",
  machineType: "x",
  generation: 1,
});

async function getBalance(init: { upstreamId?: string; force?: boolean; peek?: boolean }) {
  // SAFETY: adminService 是 Partial<ServiceImpl>，getBalance 一定在。第二个参数是
  // Connect 的上下文，这个方法用不到。
  return (adminService.getBalance as any)(create(GetBalanceRequestSchema, init), {});
}

/* ------------------------------------------------------------------ *
 * 一、peek：首屏不等全量
 * ------------------------------------------------------------------ */

section("首屏：空 upstream_id + peek 只读快照");

// 不量墙钟（机器慢就抖）：先起一个不带 peek 的全量刷新，假上游把它压住不回；
// peek 要在它还压着的时候就回来。对照组就是那个全量：放行之前它不该回来。
{
  mode = "hang";
  let fullDone = false;
  const full = getBalance({}).then((res) => {
    fullDone = true;
    return res;
  });
  // 等全量的那一趟真的到了假上游（压住了），再来 peek。
  for (let i = 0; i < 500 && !held.length; i++) await new Promise((r) => setTimeout(r, 10));
  check("全量那一趟到了假上游，被压着", held.length === 1, String(held.length));
  const before = quotaCalls;
  const res = await getBalance({ peek: true });
  check("peek 回来时全量还压着（不等那一家）", !fullDone && held.length === 1, `${fullDone}/${held.length}`);
  check("没去问上游", quotaCalls === before, `${quotaCalls - before} 次`);
  check("名下有账号的平台列出来了", res.upstreamIds.includes("qoder"), JSON.stringify(res.upstreamIds));
  check("快照里还没数：额度是空的", res.quotas.length === 0, String(res.quotas.length));

  // 对照：不带 peek 的老调用要等全量刷新 —— 放行之前它没回来，放行之后才回来。
  await new Promise((r) => setTimeout(r, 50));
  check("对照：放行之前全量没回来", !fullDone);
  releaseHeld();
  await full;
  check("对照：放行之后全量回来了", fullDone);
}

/* ------------------------------------------------------------------ *
 * 二、单家问到 / 没问到
 * ------------------------------------------------------------------ */

section("单家：问到了");

{
  mode = "ok";
  const res = await getBalance({ upstreamId: "qoder", force: true });
  const quota = res.quotas[0];
  check("这一家有一条", res.quotas.length === 1, String(res.quotas.length));
  check("upstream_id 是平台 id", quota?.upstreamId === "qoder", String(quota?.upstreamId));
  check("account_id 是账号 id", quota?.accountId === qoderId, String(quota?.accountId));
  check("数是这一轮的", quota?.credits?.remaining === 70, String(quota?.credits?.remaining));
  check("没有错误", quota?.error === "" && quota?.stale === false, `${quota?.error}/${quota?.stale}`);
}

section("单家：这一轮没问到");

{
  mode = "fail";
  const res = await getBalance({ upstreamId: "qoder", force: true });
  const quota = res.quotas[0];
  check("账号没消失", res.quotas.length === 1, String(res.quotas.length));
  check("带着错误", Boolean(quota?.error), String(quota?.error));
  check("标着旧数", quota?.stale === true, String(quota?.stale));
  check("旧数留着", quota?.credits?.remaining === 70, String(quota?.credits?.remaining));
  check("account_id 还是那个账号", quota?.accountId === qoderId, String(quota?.accountId));
}

{
  // 首屏的 peek 也看得见这张错误卡。
  const res = await getBalance({ peek: true });
  const quota = res.quotas.find((q: any) => q.accountId === qoderId);
  check("peek 里也有这个账号的错误", Boolean(quota?.error) && quota?.stale === true, JSON.stringify(quota?.error));
}

{
  mode = "ok";
  const res = await getBalance({ upstreamId: "qoder", force: true });
  const quota = res.quotas[0];
  check("下一轮问到了：错误清掉", quota?.error === "" && quota?.stale === false, `${quota?.error}/${quota?.stale}`);
}

/* ------------------------------------------------------------------ *
 * 三、七牛按段写
 * ------------------------------------------------------------------ */

section("七牛云：按段写");

const qiniu = addAccount({ platform: "qiniu" });
const qiniuId = qiniu.id ?? "";

{
  setProviderKeys(qiniuId, ["k1", "c=1"]);
  const result = setProviderKeys(qiniuId, [], { apiKey: "k2" });
  check("只写 API key：成功", result.ok, result.message);
  check("API key 换了", qiniuInferenceKey(qiniuId) === "k2", qiniuInferenceKey(qiniuId));
  check("门户 cookie 没动", qiniuPortalCookie(qiniuId) === "c=1", qiniuPortalCookie(qiniuId));
}

{
  const result = setProviderKeys(qiniuId, [], { portalCookie: "c=2" });
  check("只写 cookie：API key 没动", qiniuInferenceKey(qiniuId) === "k2", qiniuInferenceKey(qiniuId));
  check("只写 cookie：cookie 换了", qiniuPortalCookie(qiniuId) === "c=2", result.message);
}

{
  const result = setProviderKeys(qiniuId, [], { apiKey: "", portalCookie: "" });
  check("两段都空：不写，报错", !result.ok, result.message);
  check("两段都空：凭据还在", qiniuInferenceKey(qiniuId) === "k2" && qiniuPortalCookie(qiniuId) === "c=2");
}

{
  const result = setProviderKeys(qiniuId, [], { clear: true });
  check("clear：清掉了", result.ok && qiniuInferenceKey(qiniuId) === "" && qiniuPortalCookie(qiniuId) === "", result.message);
}

{
  // 旧写法照旧：按位置整段覆盖。
  const result = setProviderKeys(qiniuId, ["k3", ""]);
  check("按位置写的老路还在", result.ok && qiniuInferenceKey(qiniuId) === "k3" && qiniuPortalCookie(qiniuId) === "");
}

section("讯飞星火：按段写");

{
  const xinghuo = addAccount({ platform: "xinghuo" });
  const id = xinghuo.id ?? "";
  setProviderKeys(id, [], { apiKey: "x1" });
  const empty = setProviderKeys(id, [], { apiKey: "" });
  const { xinghuoInferenceKey } = await import("../lib/xinghuo/account.ts");
  check("空值不清 key", !empty.ok && xinghuoInferenceKey(id) === "x1", empty.message);
  const cleared = setProviderKeys(id, [], { clear: true });
  check("clear 才清", cleared.ok && xinghuoInferenceKey(id) === "", cleared.message);
}

/* ------------------------------------------------------------------ */

fake.close();
// Windows 上 SQLite 的句柄不关，删目录会 EPERM。
closeStore();
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录删不掉不算失败 */
}

console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
