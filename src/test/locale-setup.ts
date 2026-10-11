import { beforeEach } from "bun:test"
import { useLocaleStore } from "../client/stores/localeStore"

// Existing UI fixtures assert English labels. Production still defaults to zh-CN;
// locale tests opt into both languages explicitly.
beforeEach(() => useLocaleStore.setState({ locale: "en" }))
