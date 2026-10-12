#!/usr/bin/env node
/**
 * dsh-session-inherit · 发布脚本：打包 + 建/更新 GitHub Release
 *
 * 为什么需要它：`releases/latest/download/<固定名>.tgz` 指向的是**最新那个 Release**
 * 的附件。所以每次发版都要传两个附件——带版本号的那个（留档）和**固定名**那个
 * （让 latest URL 永久有效）。少传固定名那个，市场里写好的安装命令下次发版就 404。
 *
 * 用法：
 *   node scripts/release.mjs               按 package.json 的版本发布
 *   node scripts/release.mjs --dry-run     只列出包内容，不打包不上传
 *   node scripts/release.mjs --tag v1.2.3  显式指定 tag（必须与 package.json 版本一致）
 *
 * 前置：改动已 commit 并 push、tag 已推到远端（脚本不碰 git，避免误操作），gh 已登录。
 *
 * 实现说明：Windows 上 npm / gh 都是 .cmd，Node 必须经 shell 才能执行它们；而
 * `shell: true` + 参数**数组**的组合已被 Node 弃用（DEP0190，参数不转义）。所以这里
 * 统一用 execSync 传整条命令字符串，路径一律加双引号（cmd 的引号规则）。
 */

import { execSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NAME = pkg.name
const REPO = (pkg.repository?.url ?? '').match(/github\.com[/:]([^/.]+(?:\/[^/.]+)?)/)?.[1] ?? ''

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const tagAt = argv.indexOf('--tag')
const tag = tagAt >= 0 ? argv[tagAt + 1] : `v${pkg.version}`

if (!REPO) {
  console.error('✗ 从 package.json 的 repository.url 解析不出 owner/repo')
  process.exit(1)
}
if (tag !== `v${pkg.version}`) {
  console.error(`✗ tag ${tag} 与 package.json 的版本 v${pkg.version} 不一致——先 bump 版本再发。`)
  process.exit(1)
}

/** 跑一条命令，输出直通终端。 */
const run = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts })

/** 跑一条命令并把 stdout 当字符串收回来。 */
const capture = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

console.log(`${NAME} ${tag}  →  ${REPO}`)

if (dryRun) {
  run('npm pack --dry-run')
  console.log('\n--dry-run：没有打包、没有上传。')
  process.exit(0)
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-release-'))
try {
  run(`npm pack --pack-destination "${tmp}"`)
  const versioned = join(tmp, `${NAME}-${pkg.version}.tgz`)
  // 固定名那份是给 latest URL 用的：附件名不带版本，换版本也不用改市场里的安装命令。
  const fixed = join(tmp, `${NAME}.tgz`)
  copyFileSync(versioned, fixed)
  console.log('\n打包完成：')
  console.log(`  ${versioned}  (${statSync(versioned).size} 字节)`)
  console.log(`  ${fixed}  (${statSync(fixed).size} 字节)`)

  let exists = true
  try {
    execSync(`gh release view "${tag}" --repo "${REPO}"`, { cwd: ROOT, stdio: 'ignore' })
  } catch {
    exists = false
  }

  if (exists) {
    console.log(`\nRelease ${tag} 已存在，补传附件。`)
  } else {
    console.log(`\nRelease ${tag} 不存在，创建。`)
    run(`gh release create "${tag}" --repo "${REPO}" --title "${tag}" --generate-notes "${versioned}"`)
  }
  // 固定名那份每次都要在：latest URL 认的就是它。
  run(`gh release upload "${tag}" --repo "${REPO}" --clobber "${fixed}"`)

  const listed = JSON.parse(capture(`gh release view "${tag}" --repo "${REPO}" --json assets`))
  console.log(`\nRelease ${tag} 的附件：`)
  for (const asset of listed.assets) console.log(`  ${asset.name}  ${asset.size}  ${asset.state}`)
  console.log('\n✓ 完成。固定名附件的永久地址（市场里的安装命令就用它）：')
  console.log(`  https://github.com/${REPO}/releases/latest/download/${NAME}.tgz`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
