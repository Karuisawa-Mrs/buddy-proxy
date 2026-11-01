// lib/router/request-life.ts — one client request, seen from the gateway.
//
// A request lives as long as the client keeps its connection. Everything the
// gateway does for it — the upstream call, the rate-limit waits, the frames
// it writes back — has to stop when the client goes, or the upstream keeps
// generating (and charging) an answer nobody reads.
//
// Two things are kept apart here on purpose:
//   - a client that reads slowly: `res.write()` returns false and the next
//     frame waits for `drain`. That is backpressure, not a disconnect.
//   - a client that is gone: the response closed before it was finished.

import type Koa from "koa";
import type { ServerResponse } from "node:http";

/** The client closed its connection before the answer was finished. */
export class ClientClosedError extends Error {
  constructor() {
    super("the client closed the connection");
    this.name = "ClientClosedError";
  }
}

/** What one client request shares across its targets and accounts. */
export interface RequestLife {
  /** Fires when the client goes away before the answer is finished. */
  signal: AbortSignal;
  /** Time already spent waiting on rate limits: one budget per request. */
  rateWait: { spentMs: number };
}

const lives = new WeakMap<object, RequestLife>();
const failures = new WeakMap<object, { error: unknown }>();

/**
 * The life of this request: created on first use, the same one afterwards.
 *
 * The root route tries several targets for one request, and they must share
 * the abort and the wait budget — so it hangs off the Koa context.
 */
export function requestLife(ctx: Koa.Context): RequestLife {
  const known = lives.get(ctx);
  if (known) return known;
  const controller = new AbortController();
  const res = ctx.res;
  const gone = () => {
    // `close` also fires after a response that was written to the end; only a
    // close before that is the client walking away.
    if (!res.writableFinished && !controller.signal.aborted) controller.abort(new ClientClosedError());
  };
  res.once("close", gone);
  // The client may have gone while the body was being read.
  if (res.destroyed || ctx.req.socket?.destroyed) gone();
  const life: RequestLife = { signal: controller.signal, rateWait: { spentMs: 0 } };
  lives.set(ctx, life);
  return life;
}

/** Whether the client is gone (as opposed to slow). */
export function clientGone(ctx: Koa.Context): boolean {
  const res = ctx.res;
  if (lives.get(ctx)?.signal.aborted) return true;
  return res.destroyed || res.socket?.destroyed === true;
}

/**
 * Write one frame and wait until the client can take the next one.
 *
 * `false` means the client is gone, and only that: a full socket buffer just
 * makes this wait for `drain`.
 */
export async function writeFrame(ctx: Koa.Context, chunk: string | Uint8Array): Promise<boolean> {
  const res = ctx.res;
  if (res.writableEnded || clientGone(ctx)) return false;
  let flushed: boolean;
  try {
    flushed = res.write(chunk);
  } catch {
    return false;
  }
  if (!flushed && !res.destroyed) await drained(res);
  return !clientGone(ctx);
}

/** The socket buffer was emptied, or the connection closed. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

/**
 * Note that the upstream stream broke after the headers went out.
 *
 * The client gets an error event and the call ends without an exception, so
 * the bookkeeping would otherwise count a broken answer as a success.
 */
export function markStreamFailed(ctx: Koa.Context, error: unknown): void {
  if (!failures.has(ctx)) failures.set(ctx, { error });
}

/** The failure of the stream, if it broke. */
export function streamFailureOf(ctx: Koa.Context): { error: unknown } | undefined {
  return failures.get(ctx);
}

/** Wait, unless the client goes first: then reject with why it went. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
