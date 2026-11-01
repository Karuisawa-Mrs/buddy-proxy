// lib/admin/credentials.ts — 凭据状态的词表。
//
// 各家上游各说各的（qoder 说 "authenticated"、minimax 说 "anonymous"、
// 面板的凭据表说 "usable"），面板要的是一套：契约里的 CredentialState 枚举。
//
// 词表只有这一处：字符串进来，枚举出去。反过来也有（契约里账号与凭据的
// status 仍是字符串），那是给人看的词。

import { CredentialState } from "../gen/buddy/admin/v1/admin_pb.ts";
import { clearQiniuAccount, qiniuAccountOf, writeQiniuAccount } from "../qiniu/account.ts";
import { clearXinghuoKey, writeXinghuoKey } from "../xinghuo/account.ts";
import { accountsOfPlatform, provider, providerKindOf } from "../providers.ts";
import { platformOf } from "../platforms.ts";

/**
 * 上游报的状态 → 契约里的枚举。
 *
 * "usable" 是面板自己的说法：这条凭据能用。
 * "anonymous" 在**上游**那里是「没登录」的意思（qoder、workbuddy、minimax
 * 都这么报），所以上游的 anonymous 要算「没有凭据」—— 那是
 * `fromUpstreamStatus` 那里单独判的。这里的 anonymous 是「有凭据，但还没
 * 过期」—— 账号密码型上游（TokenRhythm）的常态。
 */
/**
 * 写一个账号的 API Key 列表。
 *
 * upstreamId 是账号行的 id：key 挂在账号下面，同一个平台下有两个账号时各写
 * 各的。
 *
 * 七牛云：推理用的 API key 与门户 cookie 两段。讯飞星火：一把推理用的 key。
 *
 * MiniMax Code 网关不收 key：它用登录的会话，套餐额度也跟着会话走。
 *
 * key 写在账号自己名下：面板写什么就是什么，环境变量不参与（它会在每次读的
 * 时候把自己写回数据库，删掉的账号转眼又有一把 key）。
 */
export function setProviderKeys(
  requestedId: string,
  keys: string[],
  parts?: KeyParts,
): { ok: boolean; message: string; count: number } {
  // 老的调用方传平台 id（qiniu / xinghuo）。账号 id 不复用之后，同名的那一行
  // 可能早就删了：照着平台 id 写，就是一份谁也认领不了、也删不掉的凭据。所以
  // 先认成一个真在的账号；认不出来就拒绝。
  if (requestedId === "minimax" || providerKindOf(requestedId)?.kind === "minimax") {
    // Code 网关只用会话：额度也走会话，没有要贴的 key。
    return {
      ok: false,
      message: "MiniMax Code 用登录的会话，不用 key（套餐额度也跟着会话走）。",
      count: 0,
    };
  }
  const upstreamId = accountIdFor(requestedId);
  if (upstreamId === null) {
    const kind = platformOf(requestedId)?.kind;
    if (kind === "qiniu" || kind === "xinghuo") {
      return { ok: false, message: `${requestedId} 下还没有账号：先加一个账号，再往账号上写 key`, count: 0 };
    }
    const message = kind ? `这个 Provider 不接受 API Key：${requestedId}` : `没有这个账号：${requestedId}`;
    return { ok: false, message, count: 0 };
  }
  // 按段写：没给的段不改。面板走这一条 —— 按位置写的那份里空串就是「清掉」，
  // 弹窗里留空一段等于把已有的那段删了。
  if (parts && (parts.clear || parts.apiKey !== undefined || parts.portalCookie !== undefined)) {
    return setProviderKeyParts(upstreamId, parts);
  }
  const kind = providerKindOf(upstreamId);
  if (kind?.kind === "qiniu" || upstreamId === "qiniu") {
    // 七牛云的凭据有两段：推理用的 API key 与门户 cookie（额度只认 cookie）。
    // 位置就是顺序：第一段是 key，第二段是 cookie。空的那段表示清掉它。
    const apiKey = String(keys[0] ?? "").trim();
    const portalCookie = String(keys[1] ?? "").trim();
    const count = writeQiniuAccount(upstreamId, { apiKey, portalCookie });
    const message =
      count === 0
        ? "清掉了七牛云的凭据"
        : count === 2
          ? "写了 API key 与门户 cookie"
          : apiKey
            ? "只写了 API key（查不了额度）"
            : "只写了门户 cookie（不能推理）";
    return { ok: true, message, count };
  }
  if (kind?.kind === "xinghuo" || upstreamId === "xinghuo") {
    // 讯飞星火只有一把推理用的 API key：位置就是第一个。空的那把表示清掉它。
    const apiKey = String(keys[0] ?? "").trim();
    const count = writeXinghuoKey(upstreamId, apiKey);
    return {
      ok: true,
      message: count ? "写了讯飞星火的 API key" : "清掉了讯飞星火的 API key",
      count,
    };
  }
  // 别的平台没有「贴一把 key」这一步：它们的凭据各有各的形状。
  return { ok: false, message: `这个 Provider 不接受 API Key：${upstreamId}`, count: 0 };
}

/**
 * 按段写的那几样。
 *
 * undefined 是「这一段不改」；空串也当不改（空值不是清除的写法，清除只有
 * clear 一条路，免得误点保存把已有的凭据抹掉）。
 */
export interface KeyParts {
  apiKey?: string;
  portalCookie?: string;
  clear?: boolean;
}

/**
 * 按段写一个账号的 key：只覆盖给了值的那一段。
 *
 * id 的认法与按位置写的老路一样：先认账号行；认不出来而传的是平台 id
 * （qiniu / xinghuo）时也收 —— 老的调用方拿平台 id 写，按段写不能比它窄。
 */
function setProviderKeyParts(
  upstreamId: string,
  parts: KeyParts,
): { ok: boolean; message: string; count: number } {
  const kind = providerKindOf(upstreamId)?.kind;
  const given = (value: string | undefined) => String(value ?? "").trim();
  if (kind === "qiniu") {
    if (parts.clear) {
      clearQiniuAccount(upstreamId);
      return { ok: true, message: "清掉了七牛云的凭据", count: 0 };
    }
    const apiKey = given(parts.apiKey);
    const portalCookie = given(parts.portalCookie);
    if (!apiKey && !portalCookie) {
      return { ok: false, message: "没有要写的东西：两段都是空的。要清掉凭据请用「清除」", count: 0 };
    }
    // 没给的那段取库里现在那份：只换给了的那一段。
    const current = qiniuAccountOf(upstreamId);
    const count = writeQiniuAccount(upstreamId, {
      apiKey: apiKey || current?.apiKey || "",
      portalCookie: portalCookie || current?.portalCookie || "",
    });
    const message =
      apiKey && portalCookie
        ? "写了 API key 与门户 cookie"
        : apiKey
          ? "写了 API key，门户 cookie 没动"
          : "写了门户 cookie，API key 没动";
    return { ok: true, message, count };
  }
  if (kind === "xinghuo") {
    if (parts.clear) {
      clearXinghuoKey(upstreamId);
      return { ok: true, message: "清掉了讯飞星火的 API key", count: 0 };
    }
    const apiKey = given(parts.apiKey);
    if (!apiKey) {
      return { ok: false, message: "API key 是空的。要清掉它请用「清除」", count: 0 };
    }
    return { ok: true, message: "写了讯飞星火的 API key", count: writeXinghuoKey(upstreamId, apiKey) };
  }
  return { ok: false, message: `这个 Provider 不接受 API Key：${upstreamId}`, count: 0 };
}

export function credentialState(status: string): CredentialState {
  switch (status) {
    case "authenticated":
      return CredentialState.AUTHENTICATED;
    case "expired":
      return CredentialState.EXPIRED;
    case "error":
      return CredentialState.ERROR;
    case "usable":
      return CredentialState.USABLE;
    case "anonymous":
      return CredentialState.ANONYMOUS;
    case "missing":
      return CredentialState.MISSING;
    default:
      return CredentialState.MISSING;
  }
}

/**
 * 枚举 → 面板账号与凭据表里的那个词。
 *
 * 契约里 Account.status 与 Credential.status 仍是字符串（usable / expired /
 * missing），所以这里把枚举换成人能读的词。
 */
export function credentialStateText(state: CredentialState): string {
  switch (state) {
    case CredentialState.AUTHENTICATED:
    case CredentialState.ANONYMOUS:
    case CredentialState.USABLE:
      return "usable";
    case CredentialState.EXPIRED:
      return "expired";
    case CredentialState.ERROR:
      return "error";
    default:
      return "missing";
  }
}

/** 这个状态算「有能用的凭据」吗。 */
export function hasUsableCredential(state: CredentialState): boolean {
  return (
    state === CredentialState.AUTHENTICATED ||
    state === CredentialState.ANONYMOUS ||
    state === CredentialState.USABLE
  );
}

/* ------------------------------------------------------------------ *
 * 凭据的 id
 * ------------------------------------------------------------------ */

/**
 * 一条凭据 id 的形状。
 *
 * 凭据的 id 就是它在数据库里的地址（见 lib/providers.ts 的 providerSecretId）：
 * 会话是 session:provider:<账号>，钥匙是 key:provider:<账号>:<后缀>。后缀各家
 * 不同（一把 key 一个配额的是 key-1，账号密码是 account），所以认出它是
 * 哪一种要靠后缀。
 *
 * 账号就是 provider 表那一行的 id —— 账号模型里一行一个登录，所以凭据的 id
 * 里没有比账号更细的东西。
 */
export interface CredentialRef {
  /** 它属于哪个账号：provider 表里那一行的 id。 */
  accountId: string;
  /** session / api_key / login。 */
  form: string;
  /** 第几把 key：只有一把 key 一个配额的那种形状才有。 */
  tenant: number | null;
  /** 从账号里派生出来的那一条：api_key、discovery_key。 */
  derived: string;
}

/**
 * 把凭据的 id 读成它指向的东西。
 *
 * 面板把凭据的 id 原样交回来（「试一下」「刷新一下」），所以这里是唯一的算法：
 * 认不出来的 id 就是不认识的凭据，不会去猜。
 */
export function parseCredentialId(id: string): CredentialRef | null {
  const raw = String(id ?? "").trim();
  if (!raw) return null;
  // 派生出来的那一条用 # 记：账号是它来的地方，值是账号里取的那个。
  const hash = raw.indexOf("#");
  const derived = hash >= 0 ? raw.slice(hash + 1) : "";
  const base = hash >= 0 ? raw.slice(0, hash) : raw;
  const parts = base.split(":");
  if (parts[0] === "session" && parts[1] === "provider" && parts.length === 3) {
    const accountId = parts[2];
    return accountId ? { accountId, form: "session", tenant: null, derived } : null;
  }
  if (parts[0] === "key" && parts[1] === "provider" && parts.length === 4) {
    const accountId = parts[2];
    const suffix = parts[3];
    if (!accountId) return null;
    if (suffix === "account") return { accountId, form: "login", tenant: null, derived };
    const key = /^key-(\d+)$/.exec(suffix);
    if (key) return { accountId, form: "api_key", tenant: Number(key[1]), derived };
    return null;
  }
  return null;
}

/**
 * 把面板传来的 id 认成一个真在的账号行。
 *
 * 账号 id 直接认；平台 id 认成该平台的第一个账号（写法同 login.ts 的
 * accountFor）。都认不出来就是 null。
 */
function accountIdFor(id: string): string | null {
  if (provider(id)) return id;
  return accountsOfPlatform(id)[0]?.id ?? null;
}
