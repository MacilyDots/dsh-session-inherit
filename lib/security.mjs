// HTTP 小工具与请求边界判定。
//
// 为什么要单独放：这些函数决定了"谁能调这个插件的端点"。DSH 的 webServer 对
// 自定义 exact 路由不做任何鉴权（dsh-host-webserver 的 README 原话："No
// server-wide authentication or origin policy — route owners enforce their own
// request policy"），所以边界必须由插件自己划。

export const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * 回写 JSON。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} payload - 负载。
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 读取请求体（带上限 + 超时）。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {number} [timeoutMs] - 读取超时（默认 8 秒）。
 * @returns {Promise<string>} 请求体文本。
 */
export function readBody(req, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    let timer
    /**
     * 只结算一次并清掉超时器。
     * @param {Function} settle - resolve 或 reject。
     * @param {unknown} value - 结算值。
     */
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle(value)
    }
    // 必须能超时退出：如果上游已经把 body 消费掉，'end' 永远不会再来，
    // 这个 Promise 就会连同 handler 和界面一起永久挂起——正是卡死的症状之一。
    timer = setTimeout(() => finish(reject, new Error('request body timeout (8s)')), timeoutMs)
    req.on('data', (chunk) => {
      // 按 Buffer 收集、最后一次性解码。以前是 `data += chunk`，Buffer 会隐式
      // toString()，chunk 边界正好落在多字节字符（CJK、emoji）中间时会被切成
      // U+FFFD；4MB 上限下的大 doc 每次分块都可能中招，而且损坏是静默的。
      // 上限也改成按字节数算：字符串 length 比非 ASCII 正文的字节数小得多。
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        if (typeof req.destroy === 'function') req.destroy()
        finish(reject, new Error('request body too large'))
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => finish(reject, error))
    req.on('aborted', () => finish(reject, new Error('aborted')))
  })
}

/**
 * 同源判定：拒绝跨站发起（浏览器侧的 CSRF 护栏）。
 *
 * 注意它**不是**认证：没有 Origin 头的请求（curl、本机进程）直接放行，所以
 * 它挡不住非浏览器发起的调用。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} 是否同源。
 */
export function sameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true // 非浏览器发起
  const host = req.headers.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
