// test/quota-status-check.ts — 额度页的「没问到」：静默空了也出错误卡，注销时一并忘掉。
//
//   node --experimental-strip-types test/quota-status-check.ts
//
// 离线：临时数据目录，假的 Qoder 上游（本机端口），不碰真凭据。
//
//   1. 启用、有凭据、从没问到过的账号，取数函数静默回空（不抛）：面板上有错误卡。
//   2. 关着的账号、凭据不齐的账号（七牛没 cookie）：本来就没数，不出错误卡。
//   3. 快照还没生成时注销：面板记着的那份错误也清掉。
//   4. 七牛 / 星火按段写传平台 id：与按位置写的老路一样认。

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quota-status-"));
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

// 假的 Qoder：额度接口一律 500 —— fetchQoderCredits 只记日志、回 null，不抛。
let quotaCalls = 0;
const fake = http.createServer((req, res) => {
  const url = String(req.url ?? "");
  if (url.endsWith("/api/v3/user/status")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ userId: "u1", status: "active" }));
    return;
  }
  if (url.endsWith("/api/v2/quota/usage")) {
    quotaCalls++;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "boom" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
process.env.QODER_GLOBAL_OPENAPI_BASE = `http://127.0.0.1:${(fake.address() as net.AddressInfo).port}`;

const { addAccount, setProviderEnabled } = await import("../lib/providers.ts");
const { setSecret, closeStore } = await import("../lib/store.ts");
const { create } = await import("@bufbuild/protobuf");
const { GetBalanceRequestSchema } = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");
const { adminService } = await import("../lib/admin/service.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { forgetAccountSnapshot } = await import("../lib/admin/upstreams.ts");
const { panelQuotas, recordAccountQuota } = await import("../lib/admin/quota-status.ts");
const { clearHealthSnapshot, peekHealthSnapshot } = await import("../lib/health-cache.ts");
const { qiniuInferenceKey } = await import("../lib/qiniu/account.ts");
const { xinghuoInferenceKey } = await import("../lib/xinghuo/account.ts");

function qoderSession(id: string): void {
  setSecret(`session:provider:${id}`, "session", {
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
    loginAtMs: Date.now(),
    refreshedAtMs: Date.now(),
  });
}

async function getBalance(init: { upstreamId?: string; force?: boolean; peek?: boolean }) {
  // SAFETY: adminService 是 Partial<ServiceImpl>，getBalance 一定在。第二个参数是
  // Connect 的上下文，这个方法用不到。
  return (adminService.getBalance as any)(create(GetBalanceRequestSchema, init), {});
}

/* ------------------------------------------------------------------ */

section("从没问到过、取数静默回空：出错误卡");

const on = addAccount({ platform: "qoder", alias: "开着的" });
const onId = on.id ?? "";
qoderSession(onId);
const off = addAccount({ platform: "qoder", alias: "关着的" });
const offId = off.id ?? "";
qoderSession(offId);
setProviderEnabled(offId, false);

{
  const res = await getBalance({ upstreamId: "qoder", force: true });
  check("确实问了上游（假上游回了 500）", quotaCalls >= 1, String(quotaCalls));
  const card = res.quotas.find((q: any) => q.accountId === onId);
  check("开着的账号有一张卡", Boolean(card), JSON.stringify(res.quotas.map((q: any) => q.accountId)));
  check("卡上带着错误", Boolean(card?.error), String(card?.error));
  check("不是旧数（从没有过数）", card?.stale === false, String(card?.stale));
  check("卡上没有数", !card?.credits && !card?.balance, JSON.stringify(card?.credits));
  check("upstream_id 是平台 id", card?.upstreamId === "qoder", String(card?.upstreamId));
  check("关着的账号不出错误卡", !res.quotas.some((q: any) => q.accountId === offId));
}

{
  const res = await getBalance({ peek: true });
  const card = res.quotas.find((q: any) => q.accountId === onId);
  check("peek 里也看得见这张错误卡", Boolean(card?.error), JSON.stringify(card?.error));
}

section("凭据不齐：本来就没数，不出错误卡");

{
  // 七牛只有推理 key、没有门户 cookie：问不了额度，这不是上游的错。
  const qiniu = addAccount({ platform: "qiniu" });
  const qiniuId = qiniu.id ?? "";
  setProviderKeys(qiniuId, ["k1", ""]);
  const res = await getBalance({ upstreamId: "qiniu", force: true });
  check("七牛没 cookie：没有卡", !res.quotas.some((q: any) => q.accountId === qiniuId), JSON.stringify(res.quotas));
}

/* ------------------------------------------------------------------ */

section("快照还没生成时注销：面板那份也清掉");

{
  recordAccountQuota("ghost", [], "上游超时");
  check("准备：记着一条错误", panelQuotas({ id: "ghost", platform: "qoder" }, []).length === 1);
  clearHealthSnapshot();
  check("准备：快照是空的", peekHealthSnapshot() === null);
  forgetAccountSnapshot("ghost");
  const left = panelQuotas({ id: "ghost", platform: "qoder" }, []);
  check("注销之后没有错误卡了", left.length === 0, JSON.stringify(left));
}

/* ------------------------------------------------------------------ */

section("按段写传平台 id");

{
  // 平台 id 认成该平台的第一个账号；没有账号就拒绝（见 credentials.ts accountIdFor）。
  const none = setProviderKeys("xinghuo", [], { apiKey: "x-none" });
  check("星火：没有账号时平台 id 不写", !none.ok, none.message);
  const xinghuoAccount = addAccount({ platform: "xinghuo" }).id ?? "";
  const result = setProviderKeys("xinghuo", [], { apiKey: "x-platform" });
  check("星火：平台 id 按段写成功", result.ok, result.message);
  check("星火：key 写在那个账号上", xinghuoInferenceKey(xinghuoAccount) === "x-platform", xinghuoInferenceKey(xinghuoAccount));
  const cleared = setProviderKeys("xinghuo", [], { clear: true });
  check("星火：平台 id 的 clear 也认", cleared.ok && xinghuoInferenceKey(xinghuoAccount) === "", cleared.message);
}

{
  const result = setProviderKeys("tokenrhythm", [], { apiKey: "nope" });
  check("别的平台 id 照旧不收", !result.ok, result.message);
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
