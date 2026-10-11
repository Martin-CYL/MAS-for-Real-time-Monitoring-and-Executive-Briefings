import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { mergePathLists, parseShellPathOutput, resolveCommandPath, spawnDetached } from "./process-utils"

let fakeHome: string | null = null

afterEach(() => {
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
  fakeHome = null
})

describe("resolveCommandPath", () => {
  test("finds binaries the login-shell PATH misses in well-known user bin dirs", () => {
    // e.g. the native Claude Code installer's ~/.local/bin, whose PATH line
    // goes to the interactive shell rc that `sh -lc` never reads on macOS.
    fakeHome = mkdtempSync(path.join(tmpdir(), "nex-home-"))
    const binDir = path.join(fakeHome, ".local", "bin")
    mkdirSync(binDir, { recursive: true })
    const binary = path.join(binDir, "nex-fake-cli")
    writeFileSync(binary, "#!/bin/sh\nexit 0\n")
    chmodSync(binary, 0o755)

    expect(resolveCommandPath("nex-fake-cli", fakeHome)).toBe(binary)
    expect(resolveCommandPath("nex-missing-cli", fakeHome)).toBeNull()
  })

  test("login-shell resolution still wins when it succeeds", () => {
    fakeHome = mkdtempSync(path.join(tmpdir(), "nex-home-"))
    expect(resolveCommandPath("sh", fakeHome)).toMatch(/\/sh$/)
  })
})

describe("mergePathLists", () => {
  test("keeps the current order and appends only what the shell adds", () => {
    expect(mergePathLists("/a:/usr/bin:/b", "/home/.local/bin:/usr/bin:/a::/c")).toBe(
      "/a:/usr/bin:/b:/home/.local/bin:/c"
    )
  })

  test("uses the shell PATH when the current one is empty", () => {
    expect(mergePathLists("", "/x:/y")).toBe("/x:/y")
  })
})

describe("parseShellPathOutput", () => {
  test("ignores rc-file noise around the markers", () => {
    const output = "Welcome!\n__NEX_SHELL_PATH__\n/one:/two\n__NEX_SHELL_PATH__\nbye\n"
    expect(parseShellPathOutput(output)).toBe("/one:/two")
  })

  test("returns null when the shell printed nothing usable", () => {
    expect(parseShellPathOutput("")).toBeNull()
    expect(parseShellPathOutput("__NEX_SHELL_PATH__\n\n__NEX_SHELL_PATH__")).toBeNull()
  })
})

describe("spawnDetached", () => {
  test("rejects when the command does not exist", async () => {
    await expect(spawnDetached("definitely-not-a-real-command-nex", [])).rejects.toThrow("Command not found")
  })

  test("resolves when the process starts successfully", async () => {
    await expect(spawnDetached("sh", ["-c", "exit 0"])).resolves.toBeUndefined()
  })
})
