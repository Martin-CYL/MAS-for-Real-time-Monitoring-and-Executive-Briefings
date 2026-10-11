import { describe, expect, test } from "bun:test"
import {
  getDataDir,
  getDataDirDisplay,
  getDataRootName,
  getKeybindingsFilePath,
  getKeybindingsFilePathDisplay,
  getRuntimeProfile,
} from "./branding"

describe("runtime profile helpers", () => {
  test("defaults to the prod profile when unset", () => {
    expect(getRuntimeProfile({})).toBe("prod")
    expect(getDataRootName({})).toBe(".nex")
    expect(getDataDir("/tmp/home", {})).toBe("/tmp/home/.nex/data")
    expect(getDataDirDisplay({})).toBe("~/.nex/data")
    expect(getKeybindingsFilePath("/tmp/home", {})).toBe("/tmp/home/.nex/keybindings.json")
    expect(getKeybindingsFilePathDisplay({})).toBe("~/.nex/keybindings.json")
  })

  test("switches to dev paths for the dev profile", () => {
    const env = { NEX_RUNTIME_PROFILE: "dev" }

    expect(getRuntimeProfile(env)).toBe("dev")
    expect(getDataRootName(env)).toBe(".nex-dev")
    expect(getDataDir("/tmp/home", env)).toBe("/tmp/home/.nex-dev/data")
    expect(getDataDirDisplay(env)).toBe("~/.nex-dev/data")
    expect(getKeybindingsFilePath("/tmp/home", env)).toBe("/tmp/home/.nex-dev/keybindings.json")
    expect(getKeybindingsFilePathDisplay(env)).toBe("~/.nex-dev/keybindings.json")
  })
})
