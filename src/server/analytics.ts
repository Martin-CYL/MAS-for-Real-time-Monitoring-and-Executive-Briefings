/** No telemetry is collected or transmitted by Nex. */
export interface AnalyticsReporter {
  track: (eventName: string, properties?: Record<string, unknown>) => void
  trackLaunch: (options: unknown) => void
}
export const NoopAnalyticsReporter: AnalyticsReporter = {
  track: () => {}, trackLaunch: () => {},
}
