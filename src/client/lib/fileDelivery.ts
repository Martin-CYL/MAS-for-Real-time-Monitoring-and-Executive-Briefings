import { fileDownloadUrl } from "../../shared/file-delivery"

export function downloadFile(url: string, name: string) {
  const anchor = document.createElement("a")
  anchor.href = fileDownloadUrl(url)
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}
