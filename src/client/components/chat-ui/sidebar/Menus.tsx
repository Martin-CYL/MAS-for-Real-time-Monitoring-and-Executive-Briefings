import { SHOW_DEVELOPER_UI } from "../../../config/productFeatures"
import { t } from "../../../i18n/translate"
import { useLocale } from "../../../i18n/useTranslation"
import type { ReactNode } from "react"
import { Archive, Code, Copy, EyeOff, FolderOpen, Github, Pencil, PencilOff, Pin, PinOff, RotateCcw, Split, SquarePen, Trash2, UserRoundPlus } from "lucide-react"
import { getRepoUrlLabel } from "../../../../shared/git-url"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../../ui/context-menu"
import { useOpenedOnce } from "../../../hooks/useOpenedOnce"

/**
 * "Open on GitHub" (or GitLab, or whatever host the remote names), sitting with
 * the other Open-in items.
 *
 * Renders nothing without a URL — a project with no `origin`, or one whose
 * remote is a bare path, has no page to open, and a permanently disabled row in
 * every menu would cost more than it explains.
 *
 * Opens in *this* browser rather than through `system.openExternal`: that
 * command opens things on the machine the project lives on, which is the wrong
 * screen the moment that machine isn't the one you're sitting at.
 */
export function OpenRepoMenuItemDeveloper({ repoUrl }: { repoUrl?: string }) {
  useLocale()
  if (!repoUrl) return null

  return (
    <ContextMenuItem
      onSelect={(event) => {
        event.preventDefault()
        window.open(repoUrl, "_blank", "noopener,noreferrer")
      }}
    >
      <Github className="h-3.5 w-3.5" />
      <span className="text-xs font-medium">{t("Open on") + " "}{getRepoUrlLabel(repoUrl)}</span>
    </ContextMenuItem>
  )
}

export function ProjectSectionMenu({
  editorLabel,
  repoUrl,
  onNewChat,
  newChatDisabled = false,
  onRename,
  onCopyPath,
  onShowArchived,
  onOpenInFinder,
  onOpenInEditor,
  onHide,
  pinned,
  onTogglePin,
  children,
}: {
  /** With `onTogglePin`, adds Pin / Unpin: the Channels view pins projects. */
  pinned?: boolean
  onTogglePin?: () => void
  editorLabel: string
  /** The project's forge page; absent when it has no browsable origin. */
  repoUrl?: string
  onNewChat: () => void
  newChatDisabled?: boolean
  onRename: () => void
  onCopyPath: () => void
  onShowArchived: () => void
  onOpenInFinder: () => void
  onOpenInEditor: () => void
  onHide: () => void
  children: ReactNode
}) {
  useLocale()
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="[&_svg]:size-3.5">
        <ContextMenuItem onSelect={onNewChat} disabled={newChatDisabled}>
          <SquarePen />
          <span>{t("New Chat")}</span>
        </ContextMenuItem>
        {onTogglePin ? (
          <ContextMenuItem onSelect={onTogglePin}>
            {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            <span className="text-xs font-medium">{pinned ? t("Unpin") : t("Pin")}</span>
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          onSelect={onRename}
        >
          <Pencil className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("Rename")}</span>
        </ContextMenuItem>
        {SHOW_DEVELOPER_UI && (<ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onCopyPath()
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("Copy Path")}</span>
        </ContextMenuItem>)}
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onShowArchived()
          }}
        >
          <Archive className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("Show Archived")}</span>
        </ContextMenuItem>
        {SHOW_DEVELOPER_UI && (<ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onOpenInFinder()
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("Show in Finder")}</span>
        </ContextMenuItem>)}
        {SHOW_DEVELOPER_UI && (<ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onOpenInEditor()
          }}
        >
          <Code className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("Open in") + " "}{editorLabel}</span>
        </ContextMenuItem>)}
        <OpenRepoMenuItem repoUrl={repoUrl} />
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onHide()
          }}
        >
          <EyeOff className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("Hide")}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function ChatRowMenu({
  canFork,
  archived,
  pinned,
  onTogglePin,
  editorLabel,
  repoUrl,
  onNewChat,
  onRename,
  onShare,
  onCopyPath,
  onOpenInFinder,
  onOpenInEditor,
  onFork,
  onArchive,
  onRestore,
  onClearDraft,
  onDelete,
  leadingItems,
  children,
}: {
  pinned?: boolean
  onTogglePin?: () => void
  canFork?: boolean
  /** Archived chats swap the Archive item for a leading Restore item. */
  archived?: boolean
  editorLabel: string
  /** The project's forge page; absent when it has no browsable origin. */
  repoUrl?: string
  /** Starts a fresh chat in this chat's project. */
  onNewChat: () => void
  onRename: () => void
  onShare: () => void
  onCopyPath: () => void
  onOpenInFinder: () => void
  onOpenInEditor: () => void
  onFork: () => void
  onArchive: () => void
  onRestore?: () => void
  /**
   * Throws away the chat's unsent draft. Absent when there is no draft, which
   * is most rows — a section that only ever appears when there's something to
   * clear beats a permanently greyed-out item in every menu.
   */
  onClearDraft?: () => void
  onDelete: () => void
  /**
   * Items for where the chat is being shown, ahead of the chat's own and set
   * off from them: a tab's Close items. They act on the place, not the chat.
   */
  leadingItems?: ReactNode
  children: ReactNode
}) {
  useLocale()
  // There is one of these per sidebar row and the menu below is a dozen items
  // with icons, rebuilt on every render of the row that owns it. Nothing is
  // built until the menu has actually been opened once — see `useOpenedOnce`.
  const [menuOpened, handleMenuOpenChange] = useOpenedOnce()

  return (
    <ContextMenu onOpenChange={handleMenuOpenChange}>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      {!menuOpened ? null : (
        <ContextMenuContent>
          {leadingItems ? (
            <>
              {leadingItems}
              <ContextMenuSeparator />
            </>
          ) : null}
          {onTogglePin ? (
            <ContextMenuItem onSelect={onTogglePin}>
              {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              <span className="text-xs font-medium">{pinned ? t("Unpin") : t("Pin")}</span>
            </ContextMenuItem>
          ) : null}
          {/* Draft leads: its own section, for something only this chat has and
              only while it has it — so when it's there, it's what you opened the
              menu for. */}
          {onClearDraft ? (
            <>
              <ContextMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  onClearDraft()
                }}
              >
                <PencilOff className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">{t("Clear Draft")}</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null}

          {archived && onRestore ? (
            <>
              <ContextMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  onRestore()
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">{t("Restore")}</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null}

          {/* Chat actions */}
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onRename()
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Rename")}</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onShare()
            }}
          >
            <UserRoundPlus className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Share")}</span>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canFork}
            onSelect={(event) => {
              event.preventDefault()
              if (!canFork) return
              onFork()
            }}
          >
            <Split className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Fork")}</span>
          </ContextMenuItem>

          <ContextMenuSeparator />

          {/* Project actions */}
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onNewChat()
            }}
          >
            <SquarePen className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("New Chat")}</span>
          </ContextMenuItem>
          {SHOW_DEVELOPER_UI && (<ContextMenuItem
            onSelect={(event) => {
              event.stopPropagation()
              onCopyPath()
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Copy Path")}</span>
          </ContextMenuItem>)}
          {SHOW_DEVELOPER_UI && (<ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onOpenInFinder()
            }}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Open in Finder")}</span>
          </ContextMenuItem>)}
          {SHOW_DEVELOPER_UI && (<ContextMenuItem
            onSelect={(event) => {
              event.stopPropagation()
              onOpenInEditor()
            }}
          >
            <Code className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Open in") + " "}{editorLabel}</span>
          </ContextMenuItem>)}
          <OpenRepoMenuItem repoUrl={repoUrl} />

          <ContextMenuSeparator />

          {/* Chat lifecycle */}
          {!archived ? (
            <ContextMenuItem
              onSelect={(event) => {
                event.preventDefault()
                onArchive()
              }}
            >
              <Archive className="h-3.5 w-3.5" />
              <span className="text-xs font-medium">{t("Archive Chat")}</span>
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onDelete()
            }}
            className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Delete Chat")}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  )
}

/** Developer surface retained for internal maintenance only. */
export function OpenRepoMenuItem(...args: Parameters<typeof OpenRepoMenuItemDeveloper>) {
  return SHOW_DEVELOPER_UI ? <OpenRepoMenuItemDeveloper {...args[0]} /> : null
}
