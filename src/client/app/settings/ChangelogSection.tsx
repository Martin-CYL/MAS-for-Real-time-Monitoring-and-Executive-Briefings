import { APP_VERSION } from "../../../shared/branding"
import { CHANGELOG } from "../../../shared/changelog"
import { t } from "../../i18n/translate"
import { useLocale } from "../../i18n/useTranslation"

/** Read-only release notes bundled with the deployed application. */
export function ChangelogSection() {
  const locale = useLocale()
  return (
    <section aria-label={t("Changelog")} className="space-y-6">
      <p className="px-1 text-sm text-muted-foreground">
        {t("Current version")}: <span className="font-medium text-foreground">v{APP_VERSION}</span>
      </p>
      <div className="space-y-4">
        {CHANGELOG.map((release) => (
          <article key={release.version} className="rounded-xl border border-border bg-card p-5 sm:p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
              <h2 className="text-base font-semibold text-foreground">
                v{release.version} · {release.title[locale]}
              </h2>
              <time dateTime={release.date} className="text-xs tabular-nums text-muted-foreground">
                {new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${release.date}T00:00:00Z`))}
              </time>
            </div>
            <ul className="mt-4 list-disc space-y-3 pl-5 text-sm leading-relaxed text-muted-foreground">
              {release.changes.map((change) => (
                <li key={change.title.en}>
                  <span className="font-medium text-foreground">{change.title[locale]}</span>
                  {locale === "zh-CN" ? "：" : ": "}{change.description[locale]}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  )
}
