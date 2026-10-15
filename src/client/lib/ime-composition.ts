/** Let the input method own its keys, including Safari's commit keydown. */
export function isImeKey(event: Pick<KeyboardEvent, "isComposing" | "keyCode">, composing: boolean): boolean {
  return composing || event.isComposing || event.keyCode === 229
}
