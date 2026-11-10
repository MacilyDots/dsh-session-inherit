// 诊断日志与路径规则。
//
// 第一次真实点击时卡在"正在创建…"而没有现场可看，所以每个阶段都落一行到
// %DSH_HOME%\logs\dsh-session-inherit.log。写日志永远不能影响主流程。
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** @returns {string} 诊断日志文件路径。 */
export function logFile() {
  // 环境变量优先：离线测试必须把日志写到临时文件，绝不能污染真实诊断日志
  // （上一次就发生过——测试用的假 session id 混进了生产日志，差点误判）。
  if (typeof process.env.DSH_SESSION_INHERIT_LOG === 'string' && process.env.DSH_SESSION_INHERIT_LOG.length > 0) {
    return process.env.DSH_SESSION_INHERIT_LOG
  }
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'logs', 'dsh-session-inherit.log')
}

/** @returns {string} 自检标志文件路径（存在即触发一次真实链路自检）。 */
export function selfTestFlag() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'session-inherit-selftest.json')
}

/**
 * 追加一行诊断日志（失败静默）。
 * @param {string} message - 内容。
 */
export function note(message) {
  try {
    const file = logFile()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* 日志永远不能影响主流程 */
  }
}
