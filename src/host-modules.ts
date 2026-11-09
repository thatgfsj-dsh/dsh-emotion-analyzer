/**
 * Host module resolution（DSH 0.2.2-rc.1 适配）。
 *
 * 背景：第三方插件以 `link:` 装进 profile 时，Node 从插件真实路径解析
 * `@deepseek-ai/dsh-session`，会命中插件自己的 `node_modules` 副本（npm 为
 * `peerDependencies` 自动安装的那份）。而 `appendPluginRecord()` 内部通过
 * `session.#appendRecord()` 做品牌检查，跨副本调用会抛
 * `TypeError: Receiver must be an instance of class Session`。
 *
 * 因此：优先从**运行中的 dsh 安装**解析宿主那一份（`process.argv[1]` 就是 dsh
 * bin），失败再回退插件本地副本（开发 / 单测环境）。解析结果缓存一次。
 *
 * 只读函数（`pluginRecordOf`）不涉及品牌检查，宿主/本地副本都能用；但为了
 * 语义一致，这里仍只导出宿主模块，由调用方决定回退。
 */
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** 本插件需要宿主 session 模块提供的两个函数。 */
export interface HostSessionModule {
  appendPluginRecord: (
    session: unknown,
    type: `plugin:${string}`,
    data: Record<string, unknown>,
  ) => unknown
  pluginRecordOf: (event: unknown) => { type: string; data: unknown } | undefined
}

/** 解析宿主模块时用到的最小日志面。 */
export interface HostModuleLogger {
  debug?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
}

/** 必须与宿主共享实例的包名。 */
export const HOST_SESSION_PACKAGE = '@deepseek-ai/dsh-session'

/**
 * 可能承载宿主 session 模块的文件 URL，最优候选在前。
 *
 * 1. 运行中的 dsh 安装：`realpath(process.argv[1])` 指向 dsh 的 `lib/bin.js`，
 *    从那里 `createRequire` 解析，得到宿主 `node_modules` 里的那一份。
 * 2. 插件本地副本：开发 / 单测环境（没有 dsh bin 锚点）的兜底。
 *
 * @param argv1 - 可注入的 `process.argv[1]`（测试用）。
 * @returns 去重后的文件 URL 列表；一个都解析不到时为空数组。
 */
export function hostSessionModuleCandidates(
  argv1: string | undefined = process.argv[1],
): string[] {
  const candidates: string[] = []
  const push = (url: string | undefined): void => {
    if (url !== undefined && url.length > 0 && !candidates.includes(url)) candidates.push(url)
  }

  // 1) 运行中的 dsh 安装（唯一能保证与宿主共享实例的来源）。
  try {
    if (argv1 !== undefined && argv1.length > 0) {
      const bin = realpathSync(argv1)
      const require = createRequire(bin)
      push(pathToFileURL(require.resolve(HOST_SESSION_PACKAGE)).href)
    }
  } catch {
    // 不是从可解析的 dsh bin 启动（例如单测 / 直接 node 运行）。
  }

  // 2) 插件本地副本：仅作为开发/测试兜底，跨实例调用会失败。
  try {
    push(import.meta.resolve(HOST_SESSION_PACKAGE))
  } catch {
    // 本地也没有安装；保持空列表，由调用方降级。
  }

  return candidates
}

/** 判断一个动态 import 结果是否是可用的 session 模块命名空间。 */
function isHostSessionModule(value: unknown): value is HostSessionModule {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['appendPluginRecord'] === 'function' &&
    typeof record['pluginRecordOf'] === 'function'
  )
}

let cached: Promise<HostSessionModule | undefined> | undefined

/**
 * 解析并加载宿主 session 模块（只加载一次并缓存）。
 *
 * @param logger - 可选的诊断日志。
 * @param argv1 - 可注入的 `process.argv[1]`（测试用；调用方通常省略）。
 * @returns 可用的模块；全部候选失败时为 `undefined`。
 */
export function loadHostSessionModule(
  logger?: HostModuleLogger,
  argv1?: string,
): Promise<HostSessionModule | undefined> {
  cached ??= (async (): Promise<HostSessionModule | undefined> => {
    for (const url of hostSessionModuleCandidates(argv1)) {
      try {
        const namespace: unknown = await import(url)
        if (isHostSessionModule(namespace)) {
          logger?.debug?.(`[emotion-analyzer] host session module: ${url}`)
          return namespace
        }
        logger?.warn?.(`[emotion-analyzer] host session module has unexpected exports: ${url}`)
      } catch (error) {
        logger?.warn?.(`[emotion-analyzer] host session module failed to load: ${url}`, error)
      }
    }
    logger?.warn?.(
      '[emotion-analyzer] host session module not found; plugin records will fall back to the local copy',
    )
    return undefined
  })()
  return cached
}

/** 测试钩子：丢弃已缓存的宿主模块（含在途 Promise）。 */
export function resetHostSessionModuleCache(): void {
  cached = undefined
}
