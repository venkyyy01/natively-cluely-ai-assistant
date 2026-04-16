type ExitFunction = (code: number) => void

type ExitAfterCriticalFailureOptions = {
  exit?: ExitFunction
  scheduleTimeout?: typeof setTimeout
  clearScheduledTimeout?: typeof clearTimeout
  timeoutMs?: number
  standardExitCode?: number
  fallbackExitCode?: number
}

export function exitAfterCriticalFailure(
  logAttempt: Promise<unknown>,
  options: ExitAfterCriticalFailureOptions = {},
): Promise<void> {
  const {
    exit = (code: number) => process.exit(code),
    scheduleTimeout = setTimeout,
    clearScheduledTimeout = clearTimeout,
    timeoutMs = 3000,
    standardExitCode = 1,
    fallbackExitCode = 2,
  } = options

  let settled = false
  const timer = scheduleTimeout(() => {
    if (settled) {
      return
    }

    settled = true
    exit(fallbackExitCode)
  }, timeoutMs)
  ;(timer as { unref?: () => void }).unref?.()

  return logAttempt
    .catch((): void => undefined)
    .finally(() => {
      if (settled) {
        return
      }

      settled = true
      clearScheduledTimeout(timer)
      exit(standardExitCode)
    })
    .then((): void => undefined)
}
