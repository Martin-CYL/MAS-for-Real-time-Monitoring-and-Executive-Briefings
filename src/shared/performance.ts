export const CLIENT_PERFORMANCE_METRICS = [
  "socket_message_bytes", "socket_parse_ms", "socket_messages", "socket_pending_commands",
  "socket_subscriptions", "socket_queued_commands", "transcript_hydrate_ms", "transcript_entries",
  "chat_server_ready_ms", "chat_cache_ready_ms", "chat_display_ms", "dom_nodes", "browser_heap_bytes",
  "long_task_ms", "visible",
] as const
export type ClientPerformanceMetric = typeof CLIENT_PERFORMANCE_METRICS[number]
