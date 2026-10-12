import { test, expect } from "bun:test"
import { fileDeliveryKind, fileDownloadUrl, projectFileUrl } from "./file-delivery"

test("delivery policy distinguishes documents, safe previews and source files", () => {
  for (const name of ["a.HTML", "a.svg", "a.docx", "a.pptx", "a.xlsx", "a.zip"]) expect(fileDeliveryKind(name)).toBe("download")
  expect(fileDeliveryKind("报告.PDF")).toBe("pdf")
  expect(fileDeliveryKind("图片.png")).toBe("image")
  for (const name of ["a.csv", "a.ts", "a.txt", "a.md", "Dockerfile"]) expect(fileDeliveryKind(name)).toBe("text")
  expect(projectFileUrl("p", "文件 100% #.pdf")).toBe("/api/projects/p/files/" + encodeURIComponent("文件 100% #.pdf") + "/content")
  expect(fileDownloadUrl("/api/chats/c/media/f.pdf?v=1")).toBe("/api/chats/c/media/f.pdf?v=1&download=1")
  expect(fileDownloadUrl("https://example.com/file?signature=abc")).toBe("https://example.com/file?signature=abc")
})
