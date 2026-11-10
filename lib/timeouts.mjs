// 超时与预算。
//
// 关键前提：withTimeout 是 Promise.race，**不能取消**被包住的 promise。超时只让
// 调用方放弃，底层操作该发生还是会发生。因此：
//   1. 只有"没有副作用"的步骤才适合用 cap 直接判失败（读会话、读日志）；
//   2. 有副作用的步骤（建会话、注入）超时后必须假设它可能已经成功，返回"部分完成"
//      而不是错误——否则用户看到失败，实际留了个没人知道的孤儿会话。

/**
 * 给一个 promise 加超时，避免界面无限等待。
 * @param {Promise<unknown>} promise - 目标。
 * @param {number} ms - 超时毫秒。
 * @param {string} label - 步骤名（拼进错误信息）。
 * @returns {Promise<unknown>} 结果，或超时错误。
 */
export function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label} 超过 ${Math.round(ms / 1000)} 秒未返回`)
        // 调用方要能区分"超时"和"真失败"：有副作用的步骤超时后可能已经成功。
        error.code = 'ETIMEOUT'
        error.label = label
        reject(error)
      }, ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * 一次操作的总预算：每一步的 cap 与剩余时间取小，任何一步超时都让后续步骤更快收手。
 * @param {number} totalMs - 总预算毫秒。
 * @param {() => number} [now] - 时钟（测试用）。
 * @returns {{left: () => number, step: (p: Promise<unknown>, capMs: number, label: string) => Promise<unknown>, exhausted: () => boolean}} 预算对象。
 */
export function createBudget(totalMs, now = Date.now) {
  const deadline = now() + totalMs
  return {
    left: () => Math.max(0, deadline - now()),
    step(promise, capMs, label) {
      return withTimeout(promise, Math.min(capMs, this.left()), label)
    },
    exhausted() {
      return this.left() === 0
    },
  }
}
