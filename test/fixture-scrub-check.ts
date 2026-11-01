// test/fixture-scrub-check.ts — what a recording keeps before it is committed.
//
//   node --experimental-strip-types test/fixture-scrub-check.ts
//
// The values below are made up; the point is the shape: personal fields go,
// model and message fields stay, and the committed fixtures carry nothing the
// scrubber would still change.

import fs from "node:fs";
import path from "node:path";
import { FIXTURE_DIR } from "./fixture-name.ts";
import { scrubBody, scrubHeaders, scrubUpstream, scrubValue } from "./fixture-scrub.ts";

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

console.log("");
console.log("账号的字段");

const user = scrubValue({
  id: "1a2b3c4d-1111-2222-3333-444455556666",
  name: "someone",
  email: "someone@corp.test",
  avatarUrl: "https://cdn.test/u/1a2b/avatar",
  userType: "personal",
  quota: 3,
}) as Record<string, unknown>;
check("UUID 换成全 0 的 UUID", user.id === "00000000-0000-0000-0000-000000000000", String(user.id));
check("名字换成占位", user.name === "test-user", String(user.name));
check("邮箱换成 example.com", user.email === "user@example.com", String(user.email));
check("头像换成 example.com", user.avatarUrl === "https://example.com/avatar.png", String(user.avatarUrl));
check("别的字段原样", user.userType === "personal" && user.quota === 3);

// 已经是占位的值原样留着（手写的 fixture 用自己的占位），但只认得很窄的几种。
const kept = scrubValue({
  id: "01a00000-0000-7000-8000-000000000001",
  name: "Test User",
  email: "test@example.com",
  avatarUrl: "https://cdn.test/users/01a00000-0000-7000-8000-000000000001/avatars",
  userType: "personal",
}) as Record<string, unknown>;
check("近乎全 0 的 UUID 留着", kept.id === "01a00000-0000-7000-8000-000000000001", String(kept.id));
check("Test User 留着", kept.name === "Test User", String(kept.name));
check("example.com 的邮箱留着", kept.email === "test@example.com", String(kept.email));
check("只含占位 UUID 的头像留着", String(kept.avatarUrl).includes("01a00000-0000-7000"), String(kept.avatarUrl));
const notKept = scrubValue({
  id: "01a17814-ad50-775e-8c08-6ff8df765b64",
  name: "Test Userx",
  email: "someone@example.com.evil.test",
  avatarUrl: "https://cdn.test/users/01a17814-ad50-775e-8c08-6ff8df765b64/avatars",
  userType: "personal",
}) as Record<string, unknown>;
check("像真的 UUID 照换", notKept.id === "00000000-0000-0000-0000-000000000000", String(notKept.id));
check("不是占位的名字照换", notKept.name === "test-user", String(notKept.name));
check("别的域名的邮箱照换", notKept.email === "user@example.com", String(notKept.email));
check("带真 UUID 的头像照换", notKept.avatarUrl === "https://example.com/avatar.png", String(notKept.avatarUrl));

const nested = scrubValue({ data: { owner: { userId: "998877", phone: "13800000000" } } }) as any;
check("嵌套的 userId 换成同长度的 0", nested.data.owner.userId === "000000", nested.data.owner.userId);
check("手机号换掉", nested.data.owner.phone === "00000000000", nested.data.owner.phone);

console.log("");
console.log("不是账号的字段");

const model = scrubValue({ id: "glm-5.3", name: "GLM 5.3", object: "model" }) as any;
check("模型的 id 与 name 不动", model.id === "glm-5.3" && model.name === "GLM 5.3", JSON.stringify(model));
const tool = scrubValue({ type: "function", function: { name: "get_weather" } }) as any;
check("工具名不动", tool.function.name === "get_weather");

console.log("");
console.log("正文与响应头");

const plain = '{"id":"msg_1", "content":[]}';
check("没有要换的正文一字不改（连空格）", scrubBody(plain) === plain);
const sse = 'data: {"id":"x","user":{"email":"a@b.test","userType":"t"}}\n\ndata: [DONE]\n';
check("流里的 data: 行也脱敏", !scrubBody(sse).includes("a@b.test") && scrubBody(sse).includes("data: [DONE]"));
const headers = scrubHeaders({
  "Content-Type": "application/json",
  "transfer-encoding": "chunked",
  "set-cookie": "sid=1",
  "x-user-id": "u1",
  "x-real-ip": "203.0.113.9",
});
check("响应头只留回放要的", Object.keys(headers).sort().join(",") === "content-type,transfer-encoding", Object.keys(headers).join(","));

console.log("");
console.log("来源地址");

// 局域网里的中转机地址是网络的，不是上游的；回放只用得到路径。
check("10.x 的来源换成回环", scrubUpstream("http://10.1.2.3:8080/v1/messages") === "http://127.0.0.1:8080/v1/messages");
check("192.168.x 的来源换成回环", scrubUpstream("http://192.168.50.7:6448/v1/messages") === "http://127.0.0.1:6448/v1/messages");
check("172.16-31.x 的来源换成回环", scrubUpstream("https://172.20.0.5/x") === "https://127.0.0.1/x");
check("172.32.x 不是私网，不动", scrubUpstream("https://172.32.0.5/x") === "https://172.32.0.5/x");
check("平台的域名不动", scrubUpstream("https://gateway.qoder.com.cn/a") === "https://gateway.qoder.com.cn/a");

console.log("");
console.log("仓库里的 fixtures");

for (const name of fs.readdirSync(FIXTURE_DIR).sort()) {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
  const clean =
    scrubUpstream(String(fixture.upstream ?? "")) === String(fixture.upstream ?? "") &&
    scrubBody(fixture.body) === fixture.body &&
    JSON.stringify(scrubHeaders(fixture.headers)) === JSON.stringify(fixture.headers);
  check(`${name} 已脱敏`, clean, clean ? "" : "upstream 或正文/响应头里还有要换的");
}

console.log("");
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
