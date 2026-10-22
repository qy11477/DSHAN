import { KernelUpdater } from './kernel-updater.js'
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const inject = ['webServer', 'connection']

const RUNTIME = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = 'https://registry.npmmirror.com'
const NAME_OK = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const MAX_BYTES = 20 * 1024 * 1024

// npm 自带的 tar，不新增依赖（runtime 里只有 npm，没有 pnpm）。
const npmRequire = createRequire(join(RUNTIME, 'node_modules/npm/package.json'))
const tar = npmRequire('./node_modules/tar')

function profileDir() {
  const home = process.env.DSH_HOME
  if (!home) throw new Error('DSH_HOME 未设置')
  return join(home, 'profiles', 'web')
}

function tarballUrl(spec) {
  if (/^https:\/\//i.test(spec)) return spec
  const at = spec.lastIndexOf('@')
  const name = at > 0 ? spec.slice(0, at) : spec
  const version = at > 0 ? spec.slice(at + 1) : 'latest'
  if (!NAME_OK.test(name)) throw new Error('包名不合法')
  const tail = name.split('/').pop()
  return `${REGISTRY}/${name.replace('/', '%2F')}/-/${tail}-${version}.tgz`
}

async function download(url, file) {
  if (!/^https:\/\//i.test(url)) throw new Error('只允许 https 下载地址')
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
  const size = Number(response.headers.get('content-length') ?? 0)
  if (size > MAX_BYTES) throw new Error('包超过 20MB，拒绝安装')
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file))
}

async function writeProfile(profile) {
  const file = join(profileDir(), 'package.json')
  await copyFile(file, `${file}.bak`)
  await writeFile(`${file}.tmp`, JSON.stringify(profile, null, 2) + '\n')
  await rename(`${file}.tmp`, file)
}

export async function listPlugins() {
  const profile = JSON.parse(await readFile(join(profileDir(), 'package.json'), 'utf8'))
  return { dependencies: profile.dependencies ?? {}, bundles: profile.dsh?.profile?.bundles ?? [] }
}

export async function installPlugin(spec) {
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('缺少插件地址或包名')
  const home = process.env.DSH_HOME
  const stage = join(home, 'plugin-stage', String(Date.now()))
  const tgz = join(stage, 'download.tgz')
  await mkdir(stage, { recursive: true })
  try {
    await download(tarballUrl(spec.trim()), tgz)
    await tar.x({ file: tgz, cwd: stage, strip: 1, filter: (entry) => !entry.includes('..') })
    let root = stage
    try { await readFile(join(root, 'package.json')) } catch {
      const only = (await readdir(stage, { withFileTypes: true })).find((entry) => entry.isDirectory())
      if (!only) throw new Error('压缩包里没有 package.json')
      root = join(stage, only.name)
    }
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    if (!pkg.name || !NAME_OK.test(pkg.name)) throw new Error('包名不合法，拒绝安装')
    if (pkg.name.startsWith('@deepseek-ai/')) throw new Error('拒绝覆盖官方包')

    const target = join(RUNTIME, 'node_modules', pkg.name)
    await rm(target, { recursive: true, force: true })
    await mkdir(dirname(target), { recursive: true })
    await cp(root, target, { recursive: true })

    const profile = JSON.parse(await readFile(join(profileDir(), 'package.json'), 'utf8'))
    const version = typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0'
    profile.dependencies = { ...(profile.dependencies ?? {}), [pkg.name]: version }
    const bundles = new Set(profile.dsh?.profile?.bundles ?? [])
    if (pkg.dsh?.bundle?.patch) bundles.add(pkg.name)
    profile.dsh = {
      ...(profile.dsh ?? {}),
      profile: { ...(profile.dsh?.profile ?? {}), bundles: [...bundles] },
    }
    await writeProfile(profile)
    return { installed: `${pkg.name}@${version}`, restart: '重启 App 后生效' }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

export async function removePlugin(name) {
  if (typeof name !== 'string' || !NAME_OK.test(name)) throw new Error('包名不合法')
  if (name.startsWith('@deepseek-ai/')) throw new Error('不能卸载官方包')
  const profile = JSON.parse(await readFile(join(profileDir(), 'package.json'), 'utf8'))
  if (profile.dependencies) delete profile.dependencies[name]
  if (profile.dsh?.profile) {
    profile.dsh.profile.bundles = (profile.dsh.profile.bundles ?? []).filter((entry) => entry !== name)
  }
  await writeProfile(profile)
  await rm(join(RUNTIME, 'node_modules', name), { recursive: true, force: true })
  return { removed: name, restart: '重启 App 后生效' }
}

export function apply(ctx) {
  const updater = new KernelUpdater()
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/android/kernel-update',
    async handler(req, res) {
      if (!ctx.connection.authorizeIndex(req, res)) return
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      try {
        await updater.initialized
        let result
        if (req.method === 'GET') result = updater.snapshot()
        else if (req.method === 'POST') {
          if (req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end(JSON.stringify({ error: '请求来源无效' })); return }
          let body = ''
          for await (const chunk of req) { body += chunk.toString(); if (body.length > 2048) throw new Error('请求内容过长') }
          const { action } = JSON.parse(body)
          if (!['check', 'start', 'cancel', 'restart'].includes(action)) throw new Error('未知更新操作')
          result = await updater[action]()
        } else { res.writeHead(405); res.end(JSON.stringify({ error: '请求方法无效' })); return }
        res.end(JSON.stringify(result))
      } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message ?? '更新操作失败' })) }
    },
  }), 'Kernel update endpoint')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/android/plugins',
    async handler(req, res) {
      if (!ctx.connection.authorizeIndex(req, res)) return
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      try {
        if (req.method === 'GET') {
          res.end(JSON.stringify(await listPlugins()))
          return
        }
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }); res.end(JSON.stringify({ error: '请求方法无效' })); return }
        if (req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end(JSON.stringify({ error: '请求来源无效' })); return }
        let body = ''
        for await (const chunk of req) { body += chunk.toString(); if (body.length > 4096) throw new Error('请求内容过长') }
        const { action, spec, name } = JSON.parse(body)
        const result = action === 'install' ? await installPlugin(spec)
          : action === 'remove' ? await removePlugin(name)
            : (() => { throw new Error('未知插件操作') })()
        res.end(JSON.stringify(result))
      } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message ?? '插件操作失败' })) }
    },
  }), 'Plugin install endpoint')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/android/settings',
    async handler(req, res) {
      if (!ctx.connection.authorizeIndex(req, res)) return
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      try {
        let request = { method: 'androidSettings' }
        if (req.method === 'POST') {
          if (req.headers.origin !== `http://${req.headers.host}`) {
            res.writeHead(403)
            res.end(JSON.stringify({ error: '请求来源无效' }))
            return
          }
          let body = ''
          for await (const chunk of req) {
            body += chunk.toString()
            if (body.length > 2048) throw new Error('请求内容过长')
          }
          const input = JSON.parse(body)
          if (!['updateAndroidSettings', 'requestShizuku', 'requestAdbPairing', 'requestRoot', 'openStorageSettings', 'openOverlaySettings', 'createVirtualDisplay', 'closeVirtualDisplay', 'openDisplaySettings'].includes(input.method)) throw new Error('未知设置操作')
          request = { method: input.method }
          for (const key of ['controlEnabled', 'shellEnabled', 'rootEnabled', 'virtualDisplayAllowed']) {
            if (input[key] !== undefined) {
              if (typeof input[key] !== 'boolean') throw new Error('开关值无效')
              request[key] = input[key]
            }
          }
        } else if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET, POST' })
          res.end(JSON.stringify({ error: '请求方法无效' }))
          return
        }
        const response = await fetch('http://127.0.0.1:3981/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-bridge-token': process.env.DSH_ANDROID_BRIDGE_TOKEN },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(10000),
        })
        const result = await response.json()
        res.writeHead(response.ok ? 200 : 400)
        res.end(JSON.stringify(result))
      } catch (error) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: error.message ?? '设置操作失败' }))
      }
    },
  }), 'Android settings HTTP endpoint')
}
