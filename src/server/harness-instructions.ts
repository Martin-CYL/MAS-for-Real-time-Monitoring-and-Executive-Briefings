import { buildNexAttributionInstructions } from "./attribution"
import { NEX_CHAT_LINK_INSTRUCTIONS } from "../shared/chat-links"
import { NEX_VISUALIZATION_CONTRACT, NEX_VISUALIZATION_ROUTING, NEX_VISUALIZATION_SKILL_INSTRUCTIONS } from "./visualization-instructions"

/**
 * How to use the chat tools in `nex-orchestration-tools.ts`. The tool
 * descriptions say what each one does; this says which to reach for, which
 * the descriptions cannot do one tool at a time.
 */
export const NEX_ORCHESTRATION_INSTRUCTIONS = [
  "# Nex chats",
  "",
  "The `nex` tools let you do what the user can do in Nex: start chats, message them, read them, stop them, and schedule messages. Tool names may carry a prefix such as `mcp__nex__`.",
  "",
  "- A sub-chat is a chat you start with `create_chat`. It runs on its own, on any provider and model, with only the message you give it: it does not see this conversation. Use one for work that is independent of yours or that should run in parallel. For small same-model help, your own subagent tool is cheaper.",
  "- Sub-chats are asynchronous. `create_chat` returns at once, and the result arrives later as a message in this chat, which wakes you if your turn has ended. So you can start several, finish your turn, and be called back.",
  "- A sub-chat reports when its turn ends. If it handed work off in turn, the report says it is not its last word, and another follows when that work comes back. Read the first as progress, not as the result.",
  "- Call `wait_for_chats` only when your next step needs the answer. A wait that times out does not stop the chat; wait again, read it with `read_chat`, or carry on and let the result come as a message.",
  "- Pass `subchat: false` to `create_chat` only when the user asks for a separate chat of their own. It reports nothing back.",
  "- `fork_chat` copies a conversation, context included. `create_chat` starts empty.",
  "- `set_schedule` sends a message later or on a repeat, into this chat by default. Use it to check on something in a while instead of sleeping.",
  "- `send_message` to a chat you did not start gets nothing back when that chat finishes. When you need its result, pass `adopt: true`: the chat becomes your sub-chat and its reply arrives here as a message. An adopted chat is still the user's, so it stays in their sidebar.",
  "- Stopping this chat stops the sub-chats it started, not ones it adopted. Stop one yourself with `cancel_chat` when it is no longer needed.",
].join("\n")

export const NEX_VISUALIZATION_INSTRUCTIONS = [
  "# Nex visualizations",
  "",
  NEX_VISUALIZATION_ROUTING,
  NEX_VISUALIZATION_SKILL_INSTRUCTIONS,
  NEX_VISUALIZATION_CONTRACT,
].join("\n")

/**
 * Everything Nex tells a harness that holds for the whole session. It goes
 * in the system prompt where the provider has an append hook (claude, pi,
 * codex), so it is cached there instead of being re-sent in every user turn.
 * Only notices that change turn to turn (skills, concurrent agents, steer)
 * belong on the user-text path. See attribution.ts for the per-provider hooks.
 *
 * `tools: false` is for a harness that is not handed the Nex tools, which
 * must not be told to call them.
 */
export function buildNexSystemInstructions(agentId: string, options?: { tools?: boolean }): string {
  return [
    buildNexAttributionInstructions(agentId),
    NEX_CHAT_LINK_INSTRUCTIONS,
    ...(options?.tools === false ? [] : [NEX_ORCHESTRATION_INSTRUCTIONS, NEX_VISUALIZATION_INSTRUCTIONS]),
  ].join("\n\n")
}

/** Wrapped for the providers that have no system-prompt append hook (cursor, grok). */
export function buildNexSystemMessage(agentId: string, options?: { tools?: boolean }): string {
  return `<system-message>${buildNexSystemInstructions(agentId, options)}</system-message>`
}
