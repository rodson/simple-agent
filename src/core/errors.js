// @ts-check

/** 用户主动取消时抛出的错误，调用方据此区分「取消」与「失败」。 */
export function abortError() {
  return new DOMException("已取消", "AbortError");
}

/** @param {unknown} err */
export function isAbort(err) {
  return err instanceof Error && err.name === "AbortError";
}

/** @param {unknown} err */
export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
