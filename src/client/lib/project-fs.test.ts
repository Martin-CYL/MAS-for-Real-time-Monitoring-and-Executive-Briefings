import { describe, expect, test } from "bun:test"
import type { FsDirEntry } from "../../shared/types"
import {
  abbreviateHomePath,
  classifyBrowserInput,
  filterDirEntries,
  isValidNewProjectName,
  joinDirPath,
  parseRepoRef,
  parseRepoRefFromUrl,
  pathBasename,
  resolveCloneDestination,
} from "./project-fs"

describe("classifyBrowserInput", () => {
  test("detects git repos (URLs and owner/repo shorthand)", () => {
    expect(classifyBrowserInput("https://github.com/jakemor/novax")).toBe("repo")
    expect(classifyBrowserInput("git@github.com:jakemor/novax.git")).toBe("repo")
    expect(classifyBrowserInput("jakemor/novax")).toBe("repo")
  })

  test("detects path jumps, which win over repo shorthand", () => {
    expect(classifyBrowserInput("/Users/jake/Projects")).toBe("path")
    expect(classifyBrowserInput("~")).toBe("path")
    expect(classifyBrowserInput("~/Projects")).toBe("path")
    expect(classifyBrowserInput("C:\\Projects")).toBe("path")
    expect(classifyBrowserInput("  /var/tmp  ")).toBe("path")
  })

  test("treats everything else as a filter", () => {
    expect(classifyBrowserInput("")).toBe("filter")
    expect(classifyBrowserInput("novax")).toBe("filter")
    expect(classifyBrowserInput(".config")).toBe("filter")
  })
})

describe("resolveCloneDestination", () => {
  const repo = parseRepoRef("jakemor/novax")!

  test("clones to a repo-named folder inside the new-projects directory", () => {
    expect(resolveCloneDestination("~/Novax", repo)).toEqual({
      localPath: "~/Novax/novax",
      fallbackPath: "~/Novax/jakemor-novax",
      title: "novax",
    })
  })

  test("falls back to owner-repo when the repo name is taken", () => {
    const dest = resolveCloneDestination("/home/jake/Projects", repo)
    expect(dest.fallbackPath).toBe("/home/jake/Projects/jakemor-novax")
  })
})

describe("filterDirEntries", () => {
  const entries: FsDirEntry[] = [
    { name: ".git", kind: "dir" },
    { name: ".config", kind: "dir" },
    { name: "Projects", kind: "dir" },
    { name: "novax", kind: "dir" },
    { name: "README.md", kind: "file" },
  ]

  test("hides dotfiles by default", () => {
    expect(filterDirEntries(entries, "").map((entry) => entry.name)).toEqual([
      "Projects",
      "novax",
      "README.md",
    ])
  })

  test("matches case-insensitively", () => {
    expect(filterDirEntries(entries, "NOV").map((entry) => entry.name)).toEqual(["novax"])
    expect(filterDirEntries(entries, "read").map((entry) => entry.name)).toEqual(["README.md"])
  })

  test("shows dotfiles when the filter starts with a dot", () => {
    expect(filterDirEntries(entries, ".c").map((entry) => entry.name)).toEqual([".config"])
    expect(filterDirEntries(entries, ".").map((entry) => entry.name)).toEqual([".git", ".config"])
  })
})

describe("abbreviateHomePath", () => {
  test("abbreviates the home directory to ~", () => {
    expect(abbreviateHomePath("/Users/jake", "/Users/jake")).toBe("~")
    expect(abbreviateHomePath("/Users/jake/Projects", "/Users/jake")).toBe("~/Projects")
  })

  test("leaves non-home paths alone", () => {
    expect(abbreviateHomePath("/var/tmp", "/Users/jake")).toBe("/var/tmp")
    expect(abbreviateHomePath("/Users/jakester", "/Users/jake")).toBe("/Users/jakester")
  })
})

describe("parseRepoRef", () => {
  test("parses full URLs", () => {
    expect(parseRepoRef("https://github.com/jakemor/novax")).toEqual({
      host: "github.com",
      owner: "jakemor",
      repo: "novax",
      cloneUrl: "https://github.com/jakemor/novax.git",
    })
    expect(parseRepoRef("git@gitlab.com:acme/widgets.git")?.host).toBe("gitlab.com")
  })

  test("parses owner/repo shorthand as GitHub", () => {
    expect(parseRepoRef("jakemor/novax")).toEqual({
      host: "github.com",
      owner: "jakemor",
      repo: "novax",
      cloneUrl: "https://github.com/jakemor/novax.git",
    })
    expect(parseRepoRef("jakemor/novax.git")?.repo).toBe("novax")
  })

  test("rejects non-repo input", () => {
    expect(parseRepoRef("")).toBeNull()
    expect(parseRepoRef("novax")).toBeNull()
    expect(parseRepoRef("a/b/c")).toBeNull()
    expect(parseRepoRef("https://example.com/owner/repo")).toBeNull()
  })
})

describe("parseRepoRefFromUrl", () => {
  test("parses full URLs (https and ssh)", () => {
    expect(parseRepoRefFromUrl("https://github.com/jakemor/novax")).toEqual({
      host: "github.com",
      owner: "jakemor",
      repo: "novax",
      cloneUrl: "https://github.com/jakemor/novax.git",
    })
    expect(parseRepoRefFromUrl("git@github.com:jakemor/novax.git")?.repo).toBe("novax")
  })

  test("parses scheme-less host URLs — the host makes them unambiguous", () => {
    expect(parseRepoRefFromUrl("github.com/jakemor/novax")).toEqual({
      host: "github.com",
      owner: "jakemor",
      repo: "novax",
      cloneUrl: "https://github.com/jakemor/novax.git",
    })
    expect(parseRepoRefFromUrl("gitlab.com/acme/widgets")?.host).toBe("gitlab.com")
    expect(parseRepoRefFromUrl("www.github.com/jakemor/novax")?.repo).toBe("novax")
  })

  test("rejects owner/repo shorthand — the root palette must not misfire on slashes", () => {
    expect(parseRepoRefFromUrl("jakemor/novax")).toBeNull()
    expect(parseRepoRefFromUrl("src/components")).toBeNull()
    expect(parseRepoRefFromUrl("novax")).toBeNull()
    expect(parseRepoRefFromUrl("")).toBeNull()
    expect(parseRepoRefFromUrl("example.com/owner/repo")).toBeNull()
  })
})

describe("isValidNewProjectName", () => {
  test("accepts ordinary names", () => {
    expect(isValidNewProjectName("todo-list")).toBe(true)
    expect(isValidNewProjectName("  my app  ")).toBe(true)
  })

  test("rejects empty and separator-containing names", () => {
    expect(isValidNewProjectName("")).toBe(false)
    expect(isValidNewProjectName("   ")).toBe(false)
    expect(isValidNewProjectName("a/b")).toBe(false)
    expect(isValidNewProjectName("a\\b")).toBe(false)
  })
})

describe("pathBasename", () => {
  test("returns the last path segment", () => {
    expect(pathBasename("~/Novax/my-project")).toBe("my-project")
    expect(pathBasename("/var/tmp/app/")).toBe("app")
    expect(pathBasename("C:\\Projects\\demo")).toBe("demo")
  })

  test("returns empty for root-ish paths", () => {
    expect(pathBasename("~/")).toBe("")
    expect(pathBasename("~")).toBe("")
    expect(pathBasename("")).toBe("")
    expect(pathBasename("/")).toBe("")
  })
})

describe("joinDirPath", () => {
  test("joins posix paths", () => {
    expect(joinDirPath("/Users/jake", "Projects")).toBe("/Users/jake/Projects")
    expect(joinDirPath("/", "usr")).toBe("/usr")
  })

  test("joins windows paths", () => {
    expect(joinDirPath("C:\\Users\\jake", "Projects")).toBe("C:\\Users\\jake\\Projects")
  })
})
