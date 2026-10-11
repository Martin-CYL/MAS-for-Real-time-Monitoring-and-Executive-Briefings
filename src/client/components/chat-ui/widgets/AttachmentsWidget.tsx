import { t } from "../../../i18n/translate"
import { useLocale } from "../../../i18n/useTranslation"
import { ArrowUpRight, FileText, Film, Paperclip } from "lucide-react"
import { useState } from "react"
import { cn } from "../../../lib/utils"
import { WidgetList, WidgetRow, WidgetTile, WidgetTileGrid } from "./parts"
import { WidgetCard } from "./WidgetCard"
import { openViewer, viewerAttachmentFromDisplay } from "../../../stores/viewerStore"
import type { WidgetAttachment } from "./derive"

// Opens in the viewer, the same full-size surface as a diff or a chart.
function openInViewer(attachment: WidgetAttachment) {
  openViewer({ kind: "attachment", attachment: viewerAttachmentFromDisplay(attachment) })
}

/** Fades in once decoded, over the tile's muted placeholder, instead of popping. */
function AttachmentThumbnail({ url, name }: { url: string; name: string }) {
  useLocale()
  const [loaded, setLoaded] = useState(false)
  return (
    <img
      src={url}
      alt={name}
      loading="lazy"
      onLoad={() => setLoaded(true)}
      // A cached image can finish before the load listener is attached.
      ref={(img) => {
        if (img?.complete && img.naturalWidth > 0) setLoaded(true)
      }}
      className={cn("size-full object-cover transition-opacity duration-200 ease-snappy", loaded ? "opacity-100" : "opacity-0")}
    />
  )
}

/**
 * Files the agent sent this chat (send_attachments, generate_images), newest
 * first. Images show as a thumbnail grid; everything else as rows below them.
 * Either opens in a new tab.
 */
export function AttachmentsWidget({ attachments }: { attachments: WidgetAttachment[] }) {
  useLocale()
  const images = attachments.filter((attachment) => attachment.kind === "image")
  const others = attachments.filter((attachment) => attachment.kind !== "image")
  return (
    <WidgetCard icon={<Paperclip />} title={t("Attachments")} count={attachments.length}>
      {/* Scrolls inside a cap: a chat that generated dozens of images would
          otherwise push every widget below it off screen. No overscroll
          containment, so a wheel that reaches the end carries on into the
          column instead of stalling in the middle of it. */}
      <WidgetList className="max-h-[40vh] overflow-y-auto">
        {images.length > 0 ? (
          // As many columns as fit, then every column grows to share the
          // leftover, so rows always reach both edges and thumbnails stay
          // about 96–128px however wide the sidebar is.
          <WidgetTileGrid>
            {images.map((image) => (
              <WidgetTile key={image.key} tooltip={image.name} onActivate={() => openInViewer(image)}>
                <AttachmentThumbnail url={image.url} name={image.name} />
              </WidgetTile>
            ))}
          </WidgetTileGrid>
        ) : null}
        {others.map((attachment) => (
          <WidgetRow
            key={attachment.key}
            icon={attachment.kind === "video" ? <Film /> : <FileText />}
            title={attachment.name}
            tooltip={attachment.name}
            meta={<ArrowUpRight className="size-3.5" />}
            onActivate={() => openInViewer(attachment)}
          />
        ))}
      </WidgetList>
    </WidgetCard>
  )
}
