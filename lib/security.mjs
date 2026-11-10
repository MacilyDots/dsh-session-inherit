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

/**
 * 是否是本机地址。
 *
 * `::ffff:127.0.0.1` 是双栈 socket 上 IPv4 映射地址的常见形态，必须一起认；
 * `127.0.0.0/8` 整段都算本机（不只是 127.0.0.1）。
 * @param {unknown} address - `socket.remoteAddress`。
 * @returns {boolean} 是否本机。
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const value = address.startsWith('::ffff:') ? address.slice(7) : address
  if (value === '::1') return true
  return /^127\./.test(value)
}

/**
 * 请求准入判定。
 *
 * `sameOrigin` 挡的是**浏览器跨站**；这一层挡的是**非本机来源**。两者正交：
 * 本机的 curl 没有 Origin 头（sameOrigin 放行），但它确实来自本机（这里放行）；
 * 局域网另一台机器上的浏览器带一模一样的 Origin（sameOrigin 可能放行），
 * 但它不是本机——所以必须单独判来源地址。
 *
 * 默认只放 loopback。要远程用就把 `allowRemote` 打开并配 `token`，
 * 两个条件缺一不可；没有 token 时即便 allowRemote 也拒绝（否则等于公开）。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {{allowRemote?: boolean, token?: string}} config - 归一化配置。
 * @returns {{ok: boolean, status: number, reason: string}} 判定结果。
 */
export function allowRequest(req, config = {}) {
  const socket = req.socket
  const address = socket !== null && typeof socket === 'object' ? socket.remoteAddress : undefined
  // 判不出来源一律拒绝（fail closed）：这个端点的能力是"在任何会话里写文本"，
  // 不能因为拿不到地址就默认放行。
  if (typeof address !== 'string' || address.length === 0) {
    return { ok: false, status: 403, reason: 'unknown-remote-address' }
  }
  if (isLoopbackAddress(address)) return { ok: true, status: 200, reason: 'loopback' }
  if (config.allowRemote !== true) return { ok: false, status: 403, reason: 'remote-not-allowed' }
  const expected = typeof config.token === 'string' ? config.token : ''
  if (expected.length === 0) return { ok: false, status: 403, reason: 'remote-without-token' }
  const given = req.headers['x-session-inherit-token']
  if (typeof given !== 'string' || given.length === 0 || given !== expected) {
    return { ok: false, status: 401, reason: 'bad-token' }
  }
  return { ok: true, status: 200, reason: 'remote-token' }
}
