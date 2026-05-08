import fs from "fs/promises"
import os from "os"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { which } from "@opencode-ai/core/util/which"

export interface LocatedCangjieTool {
  bin: string
  root?: string
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

function buildEnv(root: string | undefined, bin: string, base: NodeJS.ProcessEnv = process.env) {
  const currentPath = base.PATH ?? base.Path ?? ""
  const pathEntries = [path.dirname(bin)]
  if (root) {
    pathEntries.push(
      path.join(root, "build-tools", "tools", "bin"),
      path.join(root, "build-tools", "bin"),
      path.join(root, "tools", "bin"),
      path.join(root, "bin"),
    )
  }
  return {
    PATH: unique([...pathEntries, currentPath]).join(path.delimiter),
  }
}

export async function findCangjieTool(name: string): Promise<LocatedCangjieTool | undefined> {
  for (const candidateName of candidateNames(name)) {
    const match = which(candidateName)
    if (match) {
      const root = inferRootFromBin(match)
      return { bin: match, root, env: buildEnv(root, match), source: "path" }
    }
  }

  const envRoots = unique([process.env.CANGJIE_HOME, process.env.CANGJIE_SDK_HOME])
  for (const root of envRoots) {
    for (const candidate of candidatesUnderRoot(root, name)) {
      if (await Filesystem.exists(candidate)) {
        return { bin: candidate, root, env: buildEnv(root, candidate), source: "env" }
      }
    }
  }

  for (const root of await defaultRoots()) {
    for (const candidate of candidatesUnderRoot(root, name)) {
      if (await Filesystem.exists(candidate)) {
        return { bin: candidate, root, env: buildEnv(root, candidate), source: "default" }
      }
    }
  }

  return undefined
}
