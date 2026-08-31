import nodePath from 'node:path'
import { ManagedRootError } from './errors'
import {
  MANAGED_ROOT_KINDS,
  type ManagedRootRegistration,
  type ManagedWorkspaceBinding,
  type WorkspaceRootNamespace
} from './model'

/** Path spelling rules used for persisted-path validation and platform fixtures. */
export type ManagedPathStyle = 'posix' | 'win32'

type PathApi = typeof nodePath.posix

const OPAQUE_ID = /^[a-z][a-z0-9_-]{2,127}$/

/** Chooses one explicit path spelling; callers never infer another platform's syntax. */
export function pathApiFor(style: ManagedPathStyle): PathApi {
  return style === 'win32' ? nodePath.win32 : nodePath.posix
}

/** Validates an opaque identifier persisted by the launcher. */
export function assertOpaqueId(value: unknown, subject: string): asserts value is string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new ManagedRootError('managed.invalid_record', `${subject} must be an opaque identifier.`)
  }
}

/** Validates one portable relative namespace shared by macOS and Windows. */
export function assertWorkspaceNamespace(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\\')
  ) {
    throw new ManagedRootError('managed.namespace_invalid', 'Workspace namespace is not portable.')
  }

  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ManagedRootError('managed.namespace_invalid', 'Workspace namespace escapes its root.')
  }

  if (segments.some((segment) => /[\u0000-\u001f<>:"|?*]/.test(segment))) {
    throw new ManagedRootError(
      'managed.namespace_invalid',
      'Workspace namespace contains an unsafe segment.'
    )
  }
}

/** Validates a canonical root path without reading ambient homes or default paths. */
export function assertCanonicalRootPath(
  value: unknown,
  style: ManagedPathStyle
): asserts value is string {
  const pathApi = pathApiFor(style)
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw new ManagedRootError('managed.root_path_invalid', 'Managed root path is invalid.')
  }

  if (!pathApi.isAbsolute(value) || pathApi.normalize(value) !== value) {
    throw new ManagedRootError(
      'managed.root_path_invalid',
      'Managed root path must be canonical and absolute.'
    )
  }

  if (pathApi.parse(value).root === value) {
    throw new ManagedRootError('managed.root_path_invalid', 'A filesystem root cannot be managed.')
  }
}

/** Rejects a path that names any `.dsh` directory instead of a Launcher-owned directory. */
export function assertOutsideHarnessRuntimeHome(value: string, style: ManagedPathStyle): void {
  const pathApi = pathApiFor(style)
  const normalizedDshSegment = style === 'win32' ? '.dsh'.toLocaleLowerCase('en-US') : '.dsh'
  const segments = pathApi.normalize(value).split(pathApi.sep)
  if (
    segments.some((segment) =>
      style === 'win32'
        ? segment.toLocaleLowerCase('en-US') === normalizedDshSegment
        : segment === normalizedDshSegment
    )
  ) {
    throw new ManagedRootError(
      'managed.dsh_runtime_overlap',
      'Launcher-owned paths must remain outside Harness `.dsh` runtime directories.'
    )
  }
}

/** Rejects a Launcher path that overlaps the inherited Harness runtime home. */
export function assertOutsideNativeDshHome(
  value: string,
  nativeDshHomePath: string,
  style: ManagedPathStyle
): void {
  assertCanonicalRootPath(nativeDshHomePath, style)
  if (pathsOverlap(value, nativeDshHomePath, style)) {
    throw new ManagedRootError(
      'managed.dsh_runtime_overlap',
      'Launcher-owned paths must remain disjoint from the existing Harness runtime directory.'
    )
  }
}

/** Verifies the one-to-one four-root registry layout before any dependent operation. */
export function assertManagedRootLayout(
  roots: readonly ManagedRootRegistration[],
  style: ManagedPathStyle,
  nativeDshHomePath: string
): void {
  if (roots.length !== MANAGED_ROOT_KINDS.length) {
    throw new ManagedRootError('managed.invalid_record', 'Exactly four managed roots are required.')
  }

  const kinds = new Set<string>()
  const ids = new Set<string>()
  for (const root of roots) {
    assertOpaqueId(root.rootId, 'Root id')
    assertCanonicalRootPath(root.canonicalPath, style)
    assertOutsideHarnessRuntimeHome(root.canonicalPath, style)
    assertOutsideNativeDshHome(root.canonicalPath, nativeDshHomePath, style)
    if (!MANAGED_ROOT_KINDS.includes(root.kind)) {
      throw new ManagedRootError('managed.invalid_record', 'Managed root kind is invalid.')
    }
    if (kinds.has(root.kind) || ids.has(root.rootId)) {
      throw new ManagedRootError(
        'managed.invalid_record',
        'Managed roots must have unique ids and kinds.'
      )
    }
    kinds.add(root.kind)
    ids.add(root.rootId)
  }

  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      if (pathsOverlap(roots[leftIndex].canonicalPath, roots[rightIndex].canonicalPath, style)) {
        throw new ManagedRootError('managed.root_overlap', 'Managed roots must not overlap.', {
          left: roots[leftIndex].rootId,
          right: roots[rightIndex].rootId
        })
      }
    }
  }
}

/** Verifies a workspace references every registered root exactly once with safe namespaces. */
export function assertWorkspaceBinding(
  workspace: ManagedWorkspaceBinding,
  roots: readonly ManagedRootRegistration[],
  style: ManagedPathStyle,
  nativeDshHomePath: string
): void {
  assertOpaqueId(workspace.workspaceId, 'Workspace id')
  assertWorkspaceDisplayName(workspace.displayName)
  assertOpaqueId(workspace.workingDirectoryCapabilityId, 'Working-directory capability id')
  assertCanonicalRootPath(workspace.workingDirectoryCanonicalPath, style)
  assertOutsideHarnessRuntimeHome(workspace.workingDirectoryCanonicalPath, style)
  assertOutsideNativeDshHome(workspace.workingDirectoryCanonicalPath, nativeDshHomePath, style)
  if (
    roots.some((root) =>
      pathsOverlap(root.canonicalPath, workspace.workingDirectoryCanonicalPath, style)
    )
  ) {
    throw new ManagedRootError(
      'managed.working_directory_invalid',
      'Workspace working directory must remain outside every managed root.'
    )
  }
  if (workspace.rootNamespaces.length !== roots.length) {
    throw new ManagedRootError('managed.invalid_record', 'Workspace must bind every managed root.')
  }

  const expectedRootIds = new Set(roots.map((root) => root.rootId))
  const boundRootIds = new Set<string>()
  for (const binding of workspace.rootNamespaces) {
    assertWorkspaceRootNamespace(binding, expectedRootIds, boundRootIds)
  }
}

/** Rejects nested namespace ownership between workspaces sharing one root. */
export function assertWorkspaceNamespacesDoNotOverlap(
  workspaces: readonly ManagedWorkspaceBinding[]
): void {
  const seenWorkspaceIds = new Set<string>()
  const namespacesByRoot = new Map<string, WorkspaceRootNamespace[]>()

  for (const workspace of workspaces) {
    if (seenWorkspaceIds.has(workspace.workspaceId)) {
      throw new ManagedRootError('managed.invalid_record', 'Workspace ids must be unique.')
    }
    seenWorkspaceIds.add(workspace.workspaceId)
    for (const binding of workspace.rootNamespaces) {
      const entries = namespacesByRoot.get(binding.rootId) ?? []
      for (const entry of entries) {
        if (namespaceOverlaps(entry.namespace, binding.namespace)) {
          throw new ManagedRootError(
            'managed.namespace_overlap',
            'Workspace namespaces must not overlap.',
            {
              rootId: binding.rootId,
              left: entry.namespace,
              right: binding.namespace
            }
          )
        }
      }
      entries.push(binding)
      namespacesByRoot.set(binding.rootId, entries)
    }
  }
}

/** Rejects duplicate or overlapping user working-directory ownership. */
export function assertWorkspaceWorkingDirectoriesDoNotOverlap(
  workspaces: readonly ManagedWorkspaceBinding[],
  style: ManagedPathStyle
): void {
  const seenDisplayNames = new Set<string>()
  for (let leftIndex = 0; leftIndex < workspaces.length; leftIndex += 1) {
    const left = workspaces[leftIndex]
    const displayNameKey = left.displayName.normalize('NFKC').toLocaleLowerCase('en-US')
    if (seenDisplayNames.has(displayNameKey)) {
      throw new ManagedRootError(
        'managed.workspace_exists',
        'Workspace display names must be unique.'
      )
    }
    seenDisplayNames.add(displayNameKey)
    for (const right of workspaces.slice(leftIndex + 1)) {
      if (
        pathsOverlap(left.workingDirectoryCanonicalPath, right.workingDirectoryCanonicalPath, style)
      ) {
        throw new ManagedRootError(
          'managed.working_directory_invalid',
          'Workspace working directories must not overlap.'
        )
      }
    }
  }
}

/** Validates a user-facing workspace label without treating it as a filesystem namespace. */
export function assertWorkspaceDisplayName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 160 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ManagedRootError('managed.invalid_record', 'Workspace display name is invalid.')
  }
}

/** Resolves a validated namespace below one root without accepting arbitrary child paths. */
export function resolveWorkspaceNamespace(
  root: ManagedRootRegistration,
  namespace: string,
  style: ManagedPathStyle
): string {
  assertWorkspaceNamespace(namespace)
  const pathApi = pathApiFor(style)
  const target = pathApi.resolve(root.canonicalPath, ...namespace.split('/'))
  if (!isStrictlyInside(root.canonicalPath, target, style)) {
    throw new ManagedRootError(
      'managed.namespace_invalid',
      'Workspace namespace escapes its registered root.'
    )
  }
  return target
}

function assertWorkspaceRootNamespace(
  binding: WorkspaceRootNamespace,
  expectedRootIds: ReadonlySet<string>,
  boundRootIds: Set<string>
): void {
  assertOpaqueId(binding.rootId, 'Workspace root id')
  assertWorkspaceNamespace(binding.namespace)
  if (!expectedRootIds.has(binding.rootId) || boundRootIds.has(binding.rootId)) {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Workspace root bindings must be unique and registered.'
    )
  }
  boundRootIds.add(binding.rootId)
}

function pathsOverlap(left: string, right: string, style: ManagedPathStyle): boolean {
  return isSameOrAncestor(left, right, style) || isSameOrAncestor(right, left, style)
}

function isStrictlyInside(parent: string, child: string, style: ManagedPathStyle): boolean {
  return parent !== child && isSameOrAncestor(parent, child, style)
}

function isSameOrAncestor(parent: string, child: string, style: ManagedPathStyle): boolean {
  const pathApi = pathApiFor(style)
  const normalizedParent = normalizeForComparison(parent, style)
  const normalizedChild = normalizeForComparison(child, style)
  if (normalizedParent === normalizedChild) return true
  const relative = pathApi.relative(normalizedParent, normalizedChild)
  return relative !== '' && !relative.startsWith('..') && !pathApi.isAbsolute(relative)
}

function normalizeForComparison(value: string, style: ManagedPathStyle): string {
  return style === 'win32' ? value.toLocaleLowerCase('en-US') : value
}

function namespaceOverlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}
