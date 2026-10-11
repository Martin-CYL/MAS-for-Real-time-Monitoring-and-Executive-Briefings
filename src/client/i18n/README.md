# Nex interface languages

The browser defaults to `zh-CN`, and `nex.locale` persists `zh-CN` or `en`.
The General settings language selector updates Zustand and `<html lang>` without
remounting the application. Storage events synchronise other tabs. Blocked browser
storage does not prevent in-memory switching.

## Adding interface copy

- Use `t("English source text")` with a matching entry in `en.ts` and `zh-CN.ts`.
  Source strings are stable message IDs; change both catalogues together.
- React components displaying translated copy subscribe with `useLocale()`.
- Module-level option/registry labels use getters, so they read the current locale.
  Preserve property descriptors when copying them; object spread evaluates getters.
- Memoised translated display data must include the locale in its dependencies.
- Translate complete sentences. Pass dynamic names/counts through parameters:
  `t("Open {0}", { 0: fileName })`. Do not concatenate English plural suffixes
  outside the translated message.
- Dates and numbers use `getLocale()` / the helpers in `formatters.ts`.
- Do not translate user messages, generated answers, file contents, tool payloads,
  user titles, internal identifiers, model IDs, prompts or requests to the backend.
- Known application errors may be translated at their display boundary. Unknown
  provider errors remain verbatim so their diagnostics are not lost.

The interface language does not choose the model's response language. Browser
permission dialogs and third-party release notes also keep their original language.
Notifications already displayed by the operating system are not resent on a
language change; new notifications use the current preference.

## Verification

`bun run check` builds/typechecks all app targets. `bun test src/client` covers the
client regression suite. Existing English fixtures are selected by the test-only
preload; `locale.test.tsx` explicitly exercises both languages and the Chinese
default. In a browser verify live switching, reload persistence, two-tab sync,
settings controls, an unsent draft, and responsive layout.
