export class AppError extends Error {
  readonly code: string
  readonly userMessage: string
  readonly details?: unknown

  constructor(code: string, userMessage: string, details?: unknown) {
    super(userMessage)
    this.name = 'AppError'
    this.code = code
    this.userMessage = userMessage
    this.details = details
  }
}

export function toAppError(error: unknown, fallbackCode = 'app.unknown_error'): AppError {
  if (error instanceof AppError) return error
  if (error instanceof Error) return new AppError(fallbackCode, error.message)
  return new AppError(fallbackCode, 'An unknown error occurred.', error)
}

export function unwrapResult<T>(
  result:
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string; details?: unknown } }
): T {
  if (result.ok) return result.data
  throw new AppError(result.error.code, result.error.message, result.error.details)
}
