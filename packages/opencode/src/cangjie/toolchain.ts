import fs from "fs/promises"
import os from "os"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { which } from "@/util/which"

export interface LocatedCangjieTool {
  bin: string
  root?: string
  home?: string
  envsetup?: string
  runtimeDir?: string
  env: Record<string, string>
  source: "path" | "env" | "default"
}

function unique(items: Array<string | undefined>) {
  return [...new Set(items.filter((item): item is string => !!item))]
}

function versionKey(value: string) {
  return (value.match(/\d+/g) ?? []).map((item) => Number(item))
}

function compareVersionPath(a: string, b: string) {
  const left = versionKey(a)
  const right = versionKey(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0)
    if (diff !== 0) return diff
  }
  return b.localeCompare(a)
}

async function defaultRoots() {
  const roots = [path.join(os.homedir(), ".local/cangjie")]
  const sdkRoot = path.join(os.homedir(), ".cangjie-sdk")
  const entries = await fs.readdir(sdkRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isDirectory()) roots.push(path.join(sdkRoot, entry.name, "cangjie"))
  }
  return roots.sort(compareVersionPath)
}

function inferRootFromBin(bin: string) {
  const normalized = path.normalize(bin)
  for (const marker of [
    path.join("build-tools", "tools", "bin"),
    path.join("build-tools", "bin"),
    path.join("tools", "bin"),
    "bin",
  ]) {
    const suffix = path.sep + marker + path.sep
    const index = normalized.lastIndexOf(suffix)
    if (index > 0) return normalized.slice(0, index)
  }
  return undefined
}

function inferHomeFromBin(bin: string) {
  const normalized = path.normalize(bin)
  for (const marker of [path.join("build-tools", "tools", "bin"), path.join("build-tools", "bin")]) {
    const suffix = path.sep + marker + path.sep
    const index = normalized.lastIndexOf(suffix)
    if (index > 0) return path.join(normalized.slice(0, index), "build-tools")
  }
  for (const marker of [path.join("tools", "bin"), "bin"]) {
    const suffix = path.sep + marker + path.sep
    const index = normalized.lastIndexOf(suffix)
    if (index > 0) return normalized.slice(0, index)
  }
  return undefined
}

function candidateNames(name: string) {
  if (process.platform === "win32" && !name.endsWith(".exe")) return [name, `${name}.exe`]
  return [name]
}

function candidatesUnderRoot(root: string, name: string) {
  const rels = [
    path.join("build-tools", "tools", "bin"),
    path.join("build-tools", "bin"),
    path.join("tools", "bin"),
    "bin",
  ]
  return rels.flatMap((rel) => candidateNames(name).map((tool) => path.join(root, rel, tool)))
}

function runtimeTarget() {
  const arch = os.arch() === "arm64" ? "aarch64" : "x86_64"
  if (process.platform === "darwin") return `darwin_${arch}_cjnative`
  if (process.platform === "linux") return `linux_${arch}_cjnative`
  if (process.platform === "win32") return "windows_x86_64_cjnative"
  return undefined
}

function runtimeDir(home: string | undefined) {
  const target = runtimeTarget()
  if (!home || !target) return undefined
  return path.join(home, "runtime", "lib", target)
}

function stringifyEnv(base: NodeJS.ProcessEnv) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") env[key] = value
  }
  return env
}

function buildEnv(home: string | undefined, bin: string, base: NodeJS.ProcessEnv = process.env) {
  const env = stringifyEnv(base)
  const pathEntries = [path.dirname(bin)]
  if (home) {
    pathEntries.push(path.join(home, "tools", "bin"), path.join(home, "bin"))
    env.CANGJIE_HOME = home
  }
  env.PATH = unique([...pathEntries, env.PATH, env.Path]).join(path.delimiter)

  const runtime = runtimeDir(home)
  if (runtime) {
    const nativeLibs = [runtime, home && path.join(home, "tools", "lib")]
    if (process.platform === "darwin") {
      env.DYLD_LIBRARY_PATH = unique([...nativeLibs, env.DYLD_LIBRARY_PATH]).join(path.delimiter)
    } else if (process.platform === "linux") {
      env.LD_LIBRARY_PATH = unique([...nativeLibs, env.LD_LIBRARY_PATH]).join(path.delimiter)
    } else if (process.platform === "win32") {
      env.PATH = unique([...nativeLibs, env.PATH]).join(path.delimiter)
    }
  }
  return env
}

async function resolveHome(root: string | undefined, bin: string) {
  const candidates = unique([inferHomeFromBin(bin), root && path.join(root, "build-tools"), root])
  for (const candidate of candidates) {
    if (
      (await Filesystem.exists(path.join(candidate, "modules"))) ||
      (await Filesystem.exists(path.join(candidate, "envsetup.sh")))
    ) {
      return candidate
    }
  }
  return candidates[0]
}

async function locate(bin: string, source: LocatedCangjieTool["source"], root = inferRootFromBin(bin)) {
  const home = await resolveHome(root, bin)
  const envsetup = home ? path.join(home, "envsetup.sh") : undefined
  const resolvedEnvsetup = envsetup && (await Filesystem.exists(envsetup)) ? envsetup : undefined
  const resolvedRuntimeDir = runtimeDir(home)
  return {
    bin,
    root,
    home,
    envsetup: resolvedEnvsetup,
    runtimeDir: resolvedRuntimeDir,
    env: buildEnv(home, bin),
    source,
  }
}

export async function findCangjieTool(name: string): Promise<LocatedCangjieTool | undefined> {
  for (const candidateName of candidateNames(name)) {
    const match = which(candidateName)
    if (match) {
      return locate(match, "path")
    }
  }

  const envRoots = unique([process.env.CANGJIE_HOME, process.env.CANGJIE_SDK_HOME])
  for (const root of envRoots) {
    for (const candidate of candidatesUnderRoot(root, name)) {
      if (await Filesystem.exists(candidate)) {
        return locate(candidate, "env", root)
      }
    }
  }

  for (const root of await defaultRoots()) {
    for (const candidate of candidatesUnderRoot(root, name)) {
      if (await Filesystem.exists(candidate)) {
        return locate(candidate, "default", root)
      }
    }
  }

  return undefined
}
