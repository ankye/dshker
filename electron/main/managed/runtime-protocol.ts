import { ManagedHarnessRuntimeError } from './runtime-errors'

/** The maximum complete JSON IPC frame accepted from a managed DSH child. */
export const MANAGED_HARNESS_RUNTIME_MAX_FRAME_BYTES = 1_048_576

/** Shared portable identifier expression for the launcher-owned runtime protocol. */
export const MANAGED_HARNESS_RUNTIME_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

/** Shared full lowercase Git SHA-1 expression for the launcher-owned runtime protocol. */
export const MANAGED_HARNESS_RUNTIME_EXACT_COMMIT = /^[0-9a-f]{40}$/u

const SHA256 = /^[0-9a-f]{64}$/u
const CREDENTIAL_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Mutable bounded byte counters retained by the process supervisor. */
export interface RuntimeMutableDiagnostics {
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
  receivedFrameCount: number
  lastFrameType: string | undefined
  exitCode: number | undefined
  exitSignal: string | undefined
}

/** Shared generation binding carried by every private IPC frame. */
export interface RuntimeFrameBase {
  readonly version: 1
  readonly generationId: string
  readonly descriptorIdentity: string
}

interface RuntimeHelloFrame extends RuntimeFrameBase {
  readonly type: 'child/hello'
  readonly harnessRevision: string
  readonly profile: 'desktop'
  readonly credentialGenerationId: string
}

interface RuntimeReadyFrame extends RuntimeFrameBase {
  readonly type: 'child/ready'
}

interface RuntimeCredentialRequestFrame extends RuntimeFrameBase {
  readonly type: 'child/credential-request'
  readonly requestId: string
  readonly reference: string
  readonly operation: 'resolve' | 'describe'
}

interface RuntimeShutdownCompleteFrame extends RuntimeFrameBase {
  readonly type: 'child/shutdown-complete'
  readonly requestId: string
}

interface RuntimeDiagnosticFrame extends RuntimeFrameBase {
  readonly type: 'bridge/diagnostic'
  readonly level: 'info' | 'warn' | 'error'
  readonly diagnostic: Readonly<{ code: string; message: string }>
}

/** Parsed frame types permitted from the paired DSH desktop child. */
export type RuntimeChildFrame =
  | RuntimeHelloFrame
  | RuntimeReadyFrame
  | RuntimeCredentialRequestFrame
  | RuntimeShutdownCompleteFrame
  | RuntimeDiagnosticFrame

interface RuntimeLauncherAckFrame extends RuntimeFrameBase {
  readonly type: 'launcher/ack'
  readonly harnessRevision: string
  readonly profile: 'desktop'
  readonly credentialGenerationId: string
}

interface RuntimeLauncherCredentialErrorFrame extends RuntimeFrameBase {
  readonly type: 'launcher/credential-error'
  readonly requestId: string
  readonly error: Readonly<{ code: string; message: string }>
}

/** The normal shutdown request sent by the launcher after readiness. */
export interface RuntimeLauncherShutdownFrame extends RuntimeFrameBase {
  readonly type: 'launcher/shutdown'
  readonly requestId: string
}

/** Frames the launcher is permitted to send over the private Node IPC channel. */
export type RuntimeLauncherFrame =
  | RuntimeLauncherAckFrame
  | RuntimeLauncherCredentialErrorFrame
  | RuntimeLauncherShutdownFrame

/** Parses one complete child IPC frame and rejects unknown, malformed, or oversized values. */
export function parseRuntimeChildFrame(value: unknown): RuntimeChildFrame {
  assertFrameByteLength(value)
  if (!isPlainRecord(value)) {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Managed Harness IPC frame must be a plain object.'
    )
  }
  const type = value.type
  if (typeof type !== 'string') {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Managed Harness IPC frame omits its type.'
    )
  }
  switch (type) {
    case 'child/hello':
      assertExactFields(
        value,
        [
          'version',
          'type',
          'generationId',
          'descriptorIdentity',
          'harnessRevision',
          'profile',
          'credentialGenerationId'
        ],
        type
      )
      return Object.freeze({
        type,
        ...parseFrameBase(value, type),
        harnessRevision: requiredExactCommit(value.harnessRevision, 'harnessRevision', type),
        profile: requiredDesktopProfile(value.profile, type),
        credentialGenerationId: requiredOpaqueId(
          value.credentialGenerationId,
          'credentialGenerationId',
          type
        )
      })
    case 'child/ready':
      assertExactFields(value, ['version', 'type', 'generationId', 'descriptorIdentity'], type)
      return Object.freeze({ type, ...parseFrameBase(value, type) })
    case 'child/credential-request': {
      assertExactFields(
        value,
        [
          'version',
          'type',
          'generationId',
          'descriptorIdentity',
          'requestId',
          'reference',
          'operation'
        ],
        type
      )
      const operation = value.operation
      if (operation !== 'resolve' && operation !== 'describe') {
        throw new ManagedHarnessRuntimeError(
          'runtime.protocol_invalid',
          'Managed Harness credential request operation is invalid.'
        )
      }
      const reference = requiredString(value.reference, 'reference', type, 128)
      if (!CREDENTIAL_REFERENCE.test(reference)) {
        throw new ManagedHarnessRuntimeError(
          'runtime.protocol_invalid',
          'Managed Harness credential request reference is invalid.'
        )
      }
      return Object.freeze({
        type,
        ...parseFrameBase(value, type),
        requestId: requiredOpaqueId(value.requestId, 'requestId', type),
        reference,
        operation
      })
    }
    case 'child/shutdown-complete':
      assertExactFields(
        value,
        ['version', 'type', 'generationId', 'descriptorIdentity', 'requestId'],
        type
      )
      return Object.freeze({
        type,
        ...parseFrameBase(value, type),
        requestId: requiredOpaqueId(value.requestId, 'requestId', type)
      })
    case 'bridge/diagnostic':
      assertExactFields(
        value,
        ['version', 'type', 'generationId', 'descriptorIdentity', 'level', 'diagnostic'],
        type
      )
      return Object.freeze({
        type,
        ...parseFrameBase(value, type),
        level: requiredDiagnosticLevel(value.level, type),
        diagnostic: parseSafeError(value.diagnostic, type)
      })
    default:
      throw new ManagedHarnessRuntimeError(
        'runtime.protocol_invalid',
        'Managed Harness child sent an unsupported IPC frame type.'
      )
  }
}

/** Validates a launcher-owned IPC frame before it can be sent to the child process. */
export function assertRuntimeLauncherFrame(frame: RuntimeLauncherFrame): void {
  assertFrameByteLength(frame)
  switch (frame.type) {
    case 'launcher/ack':
      parseRuntimeLauncherAck(frame)
      return
    case 'launcher/credential-error':
      parseRuntimeLauncherCredentialError(frame)
      return
    case 'launcher/shutdown':
      parseRuntimeLauncherShutdown(frame)
      return
  }
}

/** Records bounded standard-output/error byte evidence without retaining child output content. */
export function appendRuntimeOutput(
  diagnostics: RuntimeMutableDiagnostics,
  channel: 'stdout' | 'stderr',
  chunk: unknown,
  maximumOutputBytes: number
): void {
  const bytes =
    typeof chunk === 'string'
      ? Buffer.byteLength(chunk, 'utf8')
      : Buffer.isBuffer(chunk)
        ? chunk.byteLength
        : 0
  const byteKey = channel === 'stdout' ? 'stdoutBytes' : 'stderrBytes'
  const truncationKey = channel === 'stdout' ? 'stdoutTruncated' : 'stderrTruncated'
  if (bytes <= 0) return
  const remaining = maximumOutputBytes - diagnostics[byteKey]
  if (remaining <= 0 || bytes > remaining) {
    diagnostics[byteKey] = maximumOutputBytes
    diagnostics[truncationKey] = true
    return
  }
  diagnostics[byteKey] += bytes
}

function parseRuntimeLauncherAck(value: unknown): void {
  if (!isPlainRecord(value)) {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Launcher acknowledgement is invalid.'
    )
  }
  assertExactFields(
    value,
    [
      'version',
      'type',
      'generationId',
      'descriptorIdentity',
      'harnessRevision',
      'profile',
      'credentialGenerationId'
    ],
    'launcher/ack'
  )
  if (value.type !== 'launcher/ack') {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Launcher acknowledgement type is invalid.'
    )
  }
  parseFrameBase(value, 'launcher/ack')
  requiredExactCommit(value.harnessRevision, 'harnessRevision', 'launcher/ack')
  requiredDesktopProfile(value.profile, 'launcher/ack')
  requiredOpaqueId(value.credentialGenerationId, 'credentialGenerationId', 'launcher/ack')
}

function parseRuntimeLauncherCredentialError(value: unknown): void {
  if (!isPlainRecord(value)) {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Launcher credential response is invalid.'
    )
  }
  assertExactFields(
    value,
    ['version', 'type', 'generationId', 'descriptorIdentity', 'requestId', 'error'],
    'launcher/credential-error'
  )
  if (value.type !== 'launcher/credential-error') {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Launcher credential response type is invalid.'
    )
  }
  parseFrameBase(value, 'launcher/credential-error')
  requiredOpaqueId(value.requestId, 'requestId', 'launcher/credential-error')
  parseSafeError(value.error, 'launcher/credential-error')
}

function parseRuntimeLauncherShutdown(value: unknown): void {
  if (!isPlainRecord(value)) {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Launcher shutdown frame is invalid.'
    )
  }
  assertExactFields(
    value,
    ['version', 'type', 'generationId', 'descriptorIdentity', 'requestId'],
    'launcher/shutdown'
  )
  if (value.type !== 'launcher/shutdown') {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Launcher shutdown frame type is invalid.'
    )
  }
  parseFrameBase(value, 'launcher/shutdown')
  requiredOpaqueId(value.requestId, 'requestId', 'launcher/shutdown')
}

function parseFrameBase(value: Record<string, unknown>, type: string): RuntimeFrameBase {
  if (value.version !== 1) {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Managed Harness IPC frame version is unsupported.'
    )
  }
  const descriptorIdentity = requiredString(
    value.descriptorIdentity,
    'descriptorIdentity',
    type,
    64
  )
  if (!SHA256.test(descriptorIdentity)) {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Managed Harness IPC frame descriptor identity is invalid.'
    )
  }
  return Object.freeze({
    version: 1,
    generationId: requiredOpaqueId(value.generationId, 'generationId', type),
    descriptorIdentity
  })
}

function parseSafeError(value: unknown, type: string): Readonly<{ code: string; message: string }> {
  if (!isPlainRecord(value)) {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Managed Harness IPC error record is invalid.'
    )
  }
  assertExactFields(value, ['code', 'message'], type)
  const code = requiredString(value.code, 'error.code', type, 64)
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(code)) {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Managed Harness IPC error code is invalid.'
    )
  }
  return Object.freeze({ code, message: requiredString(value.message, 'error.message', type, 512) })
}

function requiredDiagnosticLevel(value: unknown, type: string): 'info' | 'warn' | 'error' {
  if (value === 'info' || value === 'warn' || value === 'error') return value
  throw new ManagedHarnessRuntimeError(
    'runtime.protocol_invalid',
    `Managed Harness ${type} IPC frame level is invalid.`
  )
}

function requiredDesktopProfile(value: unknown, type: string): 'desktop' {
  if (value !== 'desktop') {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      `Managed Harness ${type} IPC frame profile is invalid.`
    )
  }
  return 'desktop'
}

function requiredExactCommit(value: unknown, key: string, type: string): string {
  const commit = requiredString(value, key, type, 40)
  if (!MANAGED_HARNESS_RUNTIME_EXACT_COMMIT.test(commit)) {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      `Managed Harness ${type} IPC frame ${key} is invalid.`
    )
  }
  return commit
}

function requiredOpaqueId(value: unknown, key: string, type: string): string {
  const id = requiredString(value, key, type, 128)
  if (!MANAGED_HARNESS_RUNTIME_OPAQUE_ID.test(id)) {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      `Managed Harness ${type} IPC frame ${key} is invalid.`
    )
  }
  return id
}

function requiredString(value: unknown, key: string, type: string, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    value.includes('\u0000')
  ) {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      `Managed Harness ${type} IPC frame ${key} is invalid.`
    )
  }
  return value
}

function assertExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  type: string
): void {
  const accepted = new Set(fields)
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) {
      throw new ManagedHarnessRuntimeError(
        'runtime.protocol_invalid',
        `Managed Harness ${type} IPC frame has an unknown field.`
      )
    }
  }
  for (const key of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new ManagedHarnessRuntimeError(
        'runtime.protocol_invalid',
        `Managed Harness ${type} IPC frame omits a required field.`
      )
    }
  }
}

function assertFrameByteLength(value: unknown): void {
  let serialized: string | undefined
  try {
    const candidate = JSON.stringify(value)
    if (typeof candidate === 'string') serialized = candidate
  } catch {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Managed Harness IPC frame is not JSON serializable.'
    )
  }
  if (serialized === undefined) {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Managed Harness IPC frame is not JSON serializable.'
    )
  }
  if (Buffer.byteLength(serialized, 'utf8') > MANAGED_HARNESS_RUNTIME_MAX_FRAME_BYTES) {
    throw new ManagedHarnessRuntimeError(
      'runtime.protocol_invalid',
      'Managed Harness IPC frame exceeds the fixed byte limit.'
    )
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}
