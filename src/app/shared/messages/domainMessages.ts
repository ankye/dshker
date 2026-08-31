export type DomainMessageKind = 'event' | 'command'

export interface DomainMessage<TPayload = unknown> {
  id: string
  kind: DomainMessageKind
  name: string
  source: string
  target?: string
  payload: TPayload
  createdAtMs: number
}

export function createDomainMessage<TPayload>(
  input: Omit<DomainMessage<TPayload>, 'id' | 'createdAtMs'>,
  options: { id?: string; nowMs?: number } = {}
): DomainMessage<TPayload> {
  const now = options.nowMs ?? Date.now()
  return {
    ...input,
    id: options.id || `${input.source}:${input.name}:${now}`,
    createdAtMs: now
  }
}

export function createDomainEvent<TPayload>(
  input: Omit<DomainMessage<TPayload>, 'id' | 'kind' | 'createdAtMs' | 'target'>,
  options: { id?: string; nowMs?: number } = {}
): DomainMessage<TPayload> {
  return createDomainMessage({ ...input, kind: 'event' }, options)
}

export function createDomainCommand<TPayload>(
  input: Omit<DomainMessage<TPayload>, 'id' | 'kind' | 'createdAtMs'>,
  options: { id?: string; nowMs?: number } = {}
): DomainMessage<TPayload> {
  return createDomainMessage({ ...input, kind: 'command' }, options)
}
