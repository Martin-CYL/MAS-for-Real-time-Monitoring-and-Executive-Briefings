import process from "node:process"

process.env.NEX_RUNTIME_PROFILE = "dev"

await import("../src/server/cli")
