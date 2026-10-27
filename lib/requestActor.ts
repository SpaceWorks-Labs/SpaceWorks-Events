import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who a request acts for when it is not a browser with a cookie session: a
 * mobile app session authenticated by a bearer token. The mobile route
 * wrapper runs the handler inside `runAsRequestActor`, so deep permission
 * helpers (`staffMfaState` and everything built on it) judge the app session
 * rather than looking for a cookie that is not there.
 *
 * The store lives on `globalThis` so that every Next.js bundle copy of this
 * module sees the same one.
 */
export type MobileRequestActor = {
  kind: "mobile";
  userId: string;
  sessionId: string;
  /** When this app session last passed an authenticator check, if ever. */
  mfaVerifiedAt: Date | null;
  /** When this app session last proved the password or Google credential. */
  authenticatedAt: Date;
};

export type RequestActor = MobileRequestActor;

const key = Symbol.for("spaceworks.requestActor");
const globalStore = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<RequestActor>; };
const store = globalStore[key] ??= new AsyncLocalStorage<RequestActor>();

export function runAsRequestActor<T>(actor: RequestActor, callback: () => Promise<T>): Promise<T> {
  return store.run(actor, callback);
}

export function currentRequestActor(): RequestActor | undefined {
  return store.getStore();
}
