// lib/admin/quota-status.ts — 每个账号上一次问到的额度，和这一轮为什么没问到。
//
// 额度页上一个账号「这一轮没问到」时不能就这么消失：用户看到的是少了一张卡，
// 不知道是账号没了还是上游没答。所以这里记两样东西，只给面板用：
//
//   last   上一次问到的额度（已经按 kind 读成面板的形状）
//   error  这一轮为什么没问到
//
// 路由用的健康快照不动：快照里没问到就是没问到（「不知道」），路由不拿旧数
// 判「用尽」。旧数只在面板上出现，而且标着 stale。

import type { QuotaView } from "../provider-kinds.ts";

/** 面板上的一条额度：kind 给的那份，加上「没问到」的说明。 */
export type PanelQuota = QuotaView & {
  /** 这一轮没问到的原因。空就是问到了。 */
  error?: string;
  /** 数是上一次问到的旧数。 */
  stale?: boolean;
};

interface AccountQuotaMemory {
  last: QuotaView[];
  error: string;
}

const memory = new Map<string, AccountQuotaMemory>();

/**
 * 记下一个账号这一轮的结果。
 *
 * `views` 是这一轮读出来的额度；`thrown` 是这一轮问的时候抛出来的错。
 * 问到了（有数）就换掉旧数、清掉错误；没问到的时候，之前有过数才算「没
 * 问到」—— 一次也没有过数的账号（没配 cookie、没登录）本来就没有额度可说。
 *
 * 例外是 `expected`：账号开着、凭据也齐，按说该有数。这样的账号一次也没
 * 问到过、取数函数又只是静默地回了空（它们把失败记进日志、返回 null，不抛），
 * 面板上不能就这么少一张卡 —— 也记一条错误，让面板画错误卡。
 */
export function recordAccountQuota(
  accountId: string,
  views: QuotaView[],
  thrown?: string,
  expected = false,
): void {
  const previous = memory.get(accountId);
  if (!thrown && views.length) {
    memory.set(accountId, { last: views, error: "" });
    return;
  }
  if (thrown) {
    memory.set(accountId, { last: previous?.last ?? [], error: thrown });
    return;
  }
  if (previous?.last.length) {
    memory.set(accountId, { last: previous.last, error: "这一轮没问到额度（上游没给数，详见日志）" });
    return;
  }
  if (expected) {
    memory.set(accountId, { last: [], error: "上游没给额度数，详见日志" });
    return;
  }
  // 本来就不该有数（关了、凭据不齐）、也从没有过数：以前记的那条错误不再作数，
  // 不然账号关掉以后面板上还挂着一张错误卡。
  memory.delete(accountId);
}

/**
 * 一个账号在面板上的额度。
 *
 * 快照里有数就用快照的（它就是现数）。快照里没有、而这个账号记着没问到：
 * 拿上一次的数标成 stale；一次也没有过数就只报错误 —— 面板照它画一张错误卡。
 */
export function panelQuotas(
  account: { id: string; platform: string },
  fromSnapshot: QuotaView[],
): PanelQuota[] {
  const views = fromSnapshot.map((view) => withPlatform(view, account));
  const remembered = memory.get(account.id);
  if (views.length || !remembered?.error) return views;
  if (remembered.last.length) {
    return remembered.last.map((view) => ({
      ...withPlatform(view, account),
      error: remembered.error,
      stale: true,
    }));
  }
  return [{ upstreamId: account.platform, accountId: account.id, error: remembered.error }];
}

/**
 * upstream_id 一律是平台 id，account_id 是账号 id。
 *
 * 以前各 kind 各填各的（TokenRhythm 填平台，别的填账号），面板按它分组时
 * 同一个平台的两个账号会被当成两个平台去问。这里统一一次，不靠每个 kind
 * 自己记得。各 kind 也都填平台 id，但以这里为准：额度对外的两条路
 * （面板的 panelQuotas、上游列表的合并）都过这一道。
 */
export function withPlatform(view: QuotaView, account: { id: string; platform: string }): QuotaView {
  return { ...view, upstreamId: account.platform, accountId: view.accountId || account.id };
}

/** 忘掉一个账号：注销就是删干净。 */
export function forgetAccountQuota(accountId: string): void {
  memory.delete(accountId);
}
