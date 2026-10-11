import { useLocaleStore } from "../stores/localeStore"
import { t } from "./translate"

export function useLocale() { return useLocaleStore((state) => state.locale) }
export function useTranslation() {
  const locale = useLocale()
  return { t, locale, setLocale: useLocaleStore.getState().setLocale }
}
