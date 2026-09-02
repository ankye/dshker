<script setup lang="ts">
import { computed, watch } from 'vue'
import type { ManagedWorkspaceView } from '@/shared/contracts'
import { ThemedListbox, type ThemedListboxOption } from '@/app/shared/controls'
import { type MessageKey } from '@/app/shared/i18n/i18n'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import {
  MANAGED_EXECUTABLE_KINDS,
  type ManagedExecutableKind,
  type ManagedRevisionKind
} from '../installations'
import { useManagedInstallations } from '../state/useManagedInstallations'

const props = defineProps<{
  readonly workspaces: readonly ManagedWorkspaceView[]
}>()

const t = useTranslator()
const manager = useManagedInstallations()

const EXECUTABLE_LABEL_KEYS: Record<ManagedExecutableKind, MessageKey> = {
  git: 'managed.installations.executable.git.label',
  node: 'managed.installations.executable.node.label',
  pnpm: 'managed.installations.executable.pnpm.label'
}

const EXECUTABLE_DESCRIPTION_KEYS: Record<ManagedExecutableKind, MessageKey> = {
  git: 'managed.installations.executable.git.description',
  node: 'managed.installations.executable.node.description',
  pnpm: 'managed.installations.executable.pnpm.description'
}

const selectedWorkspace = computed(() =>
  props.workspaces.find((workspace) => workspace.workspaceId === manager.selectedWorkspaceId.value)
)

const operationLabel = computed(() => {
  const operation = manager.activeOperation.value
  if (!operation) return undefined
  switch (operation.kind) {
    case 'load':
      return t('managed.installations.operation.loading')
    case 'select-executable':
      return t('managed.installations.operation.selectExecutable')
    case 'register-toolchain':
      return t('managed.installations.operation.registerToolchain')
    case 'install-bundled-seed':
      return t('managed.installations.operation.installBundledSeed')
    case 'clone-harness':
      return t('managed.installations.operation.cloneHarness')
    case 'switch-revision':
      return t('managed.installations.operation.switchRevision')
    case 'start-harness':
      return t('managed.installations.operation.startHarness')
    case 'stop-harness':
      return t('managed.installations.operation.stopHarness')
  }
})

const feedbackText = computed(() => {
  const feedback = manager.feedback.value
  switch (feedback.kind) {
    case 'none':
      return undefined
    case 'cancelled':
      return t('managed.installations.feedback.cancelled')
    case 'error':
      return t('managed.installations.error.description')
    case 'toolchain-registered':
      return t('managed.installations.feedback.toolchainRegistered')
    case 'bundled-seed-installed':
      return t('managed.installations.feedback.bundledSeedInstalled')
    case 'harness-cloned':
      return t('managed.installations.feedback.harnessCloned')
    case 'revision-switched':
      return t('managed.installations.feedback.revisionSwitched')
    case 'harness-started':
      return t('managed.installations.feedback.harnessStarted')
    case 'harness-stopped':
      return t('managed.installations.feedback.harnessStopped')
  }
})

watch(
  () => props.workspaces,
  (workspaces) => {
    if (
      manager.selectedWorkspaceId.value &&
      !workspaces.some((workspace) => workspace.workspaceId === manager.selectedWorkspaceId.value)
    ) {
      manager.selectWorkspace('')
    }
  }
)

function executableSelection(kind: ManagedExecutableKind) {
  return manager.executableSelectionFor(kind)
}

function executableLabel(kind: ManagedExecutableKind): string {
  return t(EXECUTABLE_LABEL_KEYS[kind])
}

function executableDescription(kind: ManagedExecutableKind): string {
  return t(EXECUTABLE_DESCRIPTION_KEYS[kind])
}

function revisionKindLabel(kind: ManagedRevisionKind): string {
  switch (kind) {
    case 'branch':
      return t('managed.installations.revision.branch')
    case 'tag':
      return t('managed.installations.revision.tag')
    case 'commit':
      return t('managed.installations.revision.commit')
  }
}

const workspaceOptions = computed<readonly ThemedListboxOption<string>[]>(() => [
  { value: '', label: t('managed.installations.workspace.placeholder') },
  ...props.workspaces.map((workspace) => ({
    value: workspace.workspaceId,
    label: workspace.displayName
  }))
])

const toolchainOptions = computed<readonly ThemedListboxOption<string>[]>(() => [
  { value: '', label: t('managed.installations.toolchain.placeholder') },
  ...manager.toolchains.value.map((toolchain) => ({
    value: toolchain.toolchainId,
    label:
      `${toolchain.toolchainId} · Git ${toolchain.gitVersion} · ` +
      `Node ${toolchain.nodeVersion} · pnpm ${toolchain.pnpmVersion}`
  }))
])

const revisionKindOptions = computed<
  readonly ThemedListboxOption<ManagedRevisionKind | undefined>[]
>(() => [
  { value: undefined, label: t('managed.installations.revision.kindPlaceholder') },
  { value: 'branch', label: t('managed.installations.revision.branch') },
  { value: 'tag', label: t('managed.installations.revision.tag') },
  { value: 'commit', label: t('managed.installations.revision.commit') }
])

function selectWorkspace(workspaceId: string): void {
  manager.selectWorkspace(workspaceId)
}

function selectInstallation(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  manager.selectInstallation(target.value)
}

function diagnosticCode(value: string): string {
  return value
}

function launchLabel(kind: 'stopped' | 'starting' | 'running' | 'failed'): string {
  switch (kind) {
    case 'stopped':
      return t('managed.installations.launch.stopped')
    case 'starting':
      return t('managed.installations.launch.starting')
    case 'running':
      return t('managed.installations.launch.running')
    case 'failed':
      return t('managed.installations.launch.failed')
  }
}
</script>

<template>
  <section class="managed-installations" :aria-busy="manager.isBusy.value">
    <p v-if="operationLabel" class="managed-installations-operation" role="status">
      {{ operationLabel }}
    </p>

    <section v-if="manager.state.value.kind === 'loading'" class="managed-installations-card">
      <p class="eyebrow">{{ t('managed.installations.kicker') }}</p>
      <h3>{{ t('managed.installations.loading.title') }}</h3>
      <p>{{ t('managed.installations.loading.description') }}</p>
    </section>

    <section
      v-else-if="manager.state.value.kind === 'bridge-unavailable'"
      class="managed-installations-card managed-installations-card--warning"
      role="alert"
    >
      <p class="eyebrow">{{ t('managed.installations.kicker') }}</p>
      <h3>{{ t('managed.installations.bridge.title') }}</h3>
      <p>{{ t('managed.installations.bridge.description') }}</p>
    </section>

    <section
      v-else-if="manager.state.value.kind === 'error'"
      class="managed-installations-card managed-installations-card--warning"
      role="alert"
    >
      <p class="eyebrow">{{ t('managed.diagnosticCode') }}</p>
      <h3>{{ t('managed.installations.error.title') }}</h3>
      <p>{{ t('managed.installations.error.description') }}</p>
      <code>{{ diagnosticCode(manager.state.value.code) }}</code>
    </section>

    <template v-else>
      <header class="managed-installations-header">
        <p class="eyebrow">{{ t('managed.installations.kicker') }}</p>
        <h3>{{ t('managed.installations.title') }}</h3>
        <p>{{ t('managed.installations.description') }}</p>
      </header>

      <section class="managed-installations-card">
        <h4>{{ t('managed.installations.workspace.title') }}</h4>
        <p>{{ t('managed.installations.workspace.description') }}</p>
        <div class="managed-installations-field">
          <span>{{ t('managed.installations.workspace.label') }}</span>
          <ThemedListbox
            :model-value="manager.selectedWorkspaceId.value"
            :options="workspaceOptions"
            :label="t('managed.installations.workspace.label')"
            :disabled="manager.isBusy.value || props.workspaces.length === 0"
            test-id="installation-workspace"
            @update:model-value="selectWorkspace"
          />
        </div>
        <p v-if="props.workspaces.length === 0" class="managed-installations-blocked">
          {{ t('managed.installations.workspace.blocked') }}
        </p>
        <p v-else-if="selectedWorkspace" class="managed-installations-selection">
          {{ selectedWorkspace.workingDirectoryCanonicalPath }}
        </p>
      </section>

      <section class="managed-installations-card">
        <header class="managed-installations-section-header">
          <div>
            <h4>{{ t('managed.installations.toolchain.title') }}</h4>
            <p>{{ t('managed.installations.toolchain.description') }}</p>
          </div>
        </header>

        <div class="managed-installations-field">
          <span>{{ t('managed.installations.toolchain.label') }}</span>
          <ThemedListbox
            v-model="manager.selectedToolchainId.value"
            :options="toolchainOptions"
            :label="t('managed.installations.toolchain.label')"
            :disabled="manager.isBusy.value || manager.toolchains.value.length === 0"
            test-id="installation-toolchain"
          />
        </div>
        <p v-if="manager.toolchains.value.length === 0" class="managed-installations-blocked">
          {{ t('managed.installations.toolchain.none') }}
        </p>

        <div
          class="managed-executable-grid"
          role="list"
          :aria-label="t('managed.installations.toolchain.title')"
        >
          <article
            v-for="kind in MANAGED_EXECUTABLE_KINDS"
            :key="kind"
            class="managed-executable-card"
            role="listitem"
          >
            <h5>{{ executableLabel(kind) }}</h5>
            <p>
              {{
                executableSelection(kind)
                  ? `${t('managed.installations.executable.selected')} ${executableSelection(kind)?.displayName}`
                  : executableDescription(kind)
              }}
            </p>
            <button
              class="managed-secondary-action"
              type="button"
              :disabled="manager.isBusy.value"
              :data-testid="`select-executable-${kind}`"
              @click="manager.selectExecutable(kind)"
            >
              {{
                executableSelection(kind)
                  ? t('managed.installations.executable.change')
                  : t('managed.installations.executable.select')
              }}
            </button>
          </article>
        </div>
        <button
          class="managed-primary-action"
          type="button"
          :disabled="!manager.canRegisterToolchain.value"
          data-testid="register-toolchain"
          @click="manager.registerToolchain"
        >
          {{ t('managed.installations.toolchain.register') }}
        </button>
      </section>

      <form
        class="managed-installations-card"
        data-testid="install-bundled-seed-form"
        @submit.prevent="manager.installBundledSeed"
      >
        <h4>{{ t('managed.installations.bundled.title') }}</h4>
        <p>{{ t('managed.installations.bundled.description') }}</p>
        <p v-if="!manager.selectedWorkspaceId.value" class="managed-installations-blocked">
          {{ t('managed.installations.clone.workspaceRequired') }}
        </p>
        <p v-else-if="!manager.selectedToolchainId.value" class="managed-installations-blocked">
          {{ t('managed.installations.clone.toolchainRequired') }}
        </p>
        <p
          v-else-if="manager.selectedWorkspaceInstallations.value.length > 0"
          class="managed-installations-blocked"
        >
          {{ t('managed.installations.bundled.alreadyInstalled') }}
        </p>
        <button
          class="managed-primary-action"
          type="submit"
          :disabled="!manager.canInstallBundledSeed.value"
          data-testid="install-bundled-seed"
        >
          {{ t('managed.installations.bundled.action') }}
        </button>
      </form>

      <form
        class="managed-installations-card"
        data-testid="clone-harness-form"
        @submit.prevent="manager.cloneHarness"
      >
        <h4>{{ t('managed.installations.clone.title') }}</h4>
        <p>{{ t('managed.installations.clone.description') }}</p>
        <p v-if="!manager.selectedWorkspaceId.value" class="managed-installations-blocked">
          {{ t('managed.installations.clone.workspaceRequired') }}
        </p>
        <p v-else-if="!manager.selectedToolchainId.value" class="managed-installations-blocked">
          {{ t('managed.installations.clone.toolchainRequired') }}
        </p>
        <label class="managed-installations-field">
          <span>{{ t('managed.installations.clone.remoteLabel') }}</span>
          <input
            v-model="manager.remoteUrl.value"
            :disabled="manager.isBusy.value"
            :placeholder="t('managed.installations.clone.remotePlaceholder')"
            autocomplete="off"
            data-testid="clone-remote-url"
            name="clone-remote-url"
            required
          />
        </label>
        <div class="managed-installations-form-grid">
          <div class="managed-installations-field">
            <span>{{ t('managed.installations.revision.kindLabel') }}</span>
            <ThemedListbox
              v-model="manager.cloneRevisionKind.value"
              :options="revisionKindOptions"
              :label="t('managed.installations.revision.kindLabel')"
              :disabled="manager.isBusy.value"
              test-id="clone-revision-kind"
            />
          </div>
          <label class="managed-installations-field">
            <span>{{ t('managed.installations.revision.valueLabel') }}</span>
            <input
              v-model="manager.cloneRevisionValue.value"
              :disabled="manager.isBusy.value"
              :placeholder="t('managed.installations.revision.valuePlaceholder')"
              autocomplete="off"
              data-testid="clone-revision-value"
              name="clone-revision-value"
              required
            />
          </label>
        </div>
        <button
          class="managed-primary-action"
          type="submit"
          :disabled="!manager.canCloneHarness.value"
          data-testid="clone-harness"
        >
          {{ t('managed.installations.clone.action') }}
        </button>
      </form>

      <section class="managed-installations-card">
        <h4>{{ t('managed.installations.installed.title') }}</h4>
        <p>{{ t('managed.installations.installed.description') }}</p>
        <p v-if="!manager.selectedWorkspaceId.value" class="managed-installations-blocked">
          {{ t('managed.installations.installed.workspaceRequired') }}
        </p>
        <p
          v-else-if="manager.selectedWorkspaceInstallations.value.length === 0"
          class="managed-installations-blocked"
        >
          {{ t('managed.installations.installed.empty') }}
        </p>
        <div
          v-else
          class="managed-installation-list"
          role="radiogroup"
          :aria-label="t('managed.installations.installed.title')"
        >
          <label
            v-for="installation in manager.selectedWorkspaceInstallations.value"
            :key="installation.installationId"
            class="managed-installation-card"
            :data-selected="manager.selectedInstallationId.value === installation.installationId"
          >
            <input
              :checked="manager.selectedInstallationId.value === installation.installationId"
              :disabled="manager.isBusy.value"
              :value="installation.installationId"
              name="managed-installation"
              type="radio"
              @change="selectInstallation"
            />
            <span class="managed-installation-card-content">
              <span class="managed-installation-card-heading">
                <strong>
                  {{ revisionKindLabel(installation.requestedRevision.kind) }}:
                  {{ installation.requestedRevision.value }}
                </strong>
                <span class="managed-launch-status" :data-kind="installation.launch.kind">
                  {{ launchLabel(installation.launch.kind) }}
                </span>
              </span>
              <span
                >{{ t('managed.installations.installed.remote') }}
                {{ installation.remoteUrl }}</span
              >
              <span
                >{{ t('managed.installations.installed.commit') }}
                <code>{{ installation.resolvedCommit }}</code></span
              >
              <span
                >{{ t('managed.installations.installed.toolchain') }}
                {{ installation.toolchainId }}</span
              >
              <span v-if="installation.launch.launchId">
                {{ t('managed.installations.installed.launchId') }}
                <code>{{ installation.launch.launchId }}</code>
              </span>
            </span>
          </label>
        </div>

        <form
          v-if="manager.selectedInstallation.value"
          class="managed-switch-form"
          data-testid="switch-revision-form"
          @submit.prevent="manager.switchRevision"
        >
          <h5>{{ t('managed.installations.switch.title') }}</h5>
          <p>{{ t('managed.installations.switch.description') }}</p>
          <div class="managed-installations-form-grid">
            <div class="managed-installations-field">
              <span>{{ t('managed.installations.revision.kindLabel') }}</span>
              <ThemedListbox
                v-model="manager.switchRevisionKind.value"
                :options="revisionKindOptions"
                :label="t('managed.installations.revision.kindLabel')"
                :disabled="manager.isBusy.value"
                test-id="switch-revision-kind"
              />
            </div>
            <label class="managed-installations-field">
              <span>{{ t('managed.installations.revision.valueLabel') }}</span>
              <input
                v-model="manager.switchRevisionValue.value"
                :disabled="manager.isBusy.value"
                :placeholder="t('managed.installations.revision.valuePlaceholder')"
                autocomplete="off"
                data-testid="switch-revision-value"
                name="switch-revision-value"
                required
              />
            </label>
          </div>
          <div class="managed-installation-actions">
            <button
              class="managed-secondary-action"
              type="submit"
              :disabled="!manager.canSwitchRevision.value"
              data-testid="switch-revision"
            >
              {{ t('managed.installations.switch.action') }}
            </button>
            <button
              v-if="manager.selectedInstallation.value.launch.kind === 'running'"
              class="managed-primary-action"
              type="button"
              :disabled="!manager.canStopHarness.value"
              data-testid="stop-harness"
              @click="manager.stopHarness"
            >
              {{ t('managed.installations.stop.action') }}
            </button>
            <button
              v-else
              class="managed-primary-action"
              type="button"
              :disabled="!manager.canStartHarness.value"
              data-testid="start-harness"
              @click="manager.startHarness"
            >
              {{ t('managed.installations.start.action') }}
            </button>
          </div>
          <p
            v-if="manager.selectedInstallation.value.launch.kind === 'starting'"
            class="managed-installations-blocked"
          >
            {{ t('managed.installations.start.inProgress') }}
          </p>
        </form>
      </section>
    </template>

    <p
      v-if="feedbackText"
      class="managed-installations-feedback"
      :class="{
        'managed-installations-feedback--error': manager.feedback.value.kind === 'error',
        'managed-installations-feedback--cancelled': manager.feedback.value.kind === 'cancelled'
      }"
      :role="manager.feedback.value.kind === 'error' ? 'alert' : 'status'"
    >
      {{ feedbackText }}
      <code
        v-if="
          manager.feedback.value.kind === 'error' || manager.feedback.value.kind === 'cancelled'
        "
      >
        {{ diagnosticCode(manager.feedback.value.code) }}
      </code>
    </p>
  </section>
</template>

<style scoped>
.managed-installations {
  display: grid;
  gap: var(--space-4);
}

.managed-installations-header,
.managed-installations-card {
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface-raised);
}

.managed-installations-header h3,
.managed-installations-card h4,
.managed-installations-card h5,
.managed-executable-card h5 {
  margin: 0;
  color: var(--color-text);
  font-size: var(--type-section);
  font-weight: var(--font-weight-semibold);
}

.managed-installations-card h5,
.managed-executable-card h5 {
  font-size: var(--type-body);
}

.managed-installations-header p,
.managed-installations-card > p,
.managed-installations-section-header p,
.managed-executable-card p,
.managed-switch-form p {
  margin: var(--space-2) 0 0;
  color: var(--color-text-muted);
}

.managed-installations-card--warning {
  border-color: color-mix(in srgb, var(--color-warning), var(--color-border) 50%);
}

.managed-installations-card--warning code,
.managed-installations-feedback code {
  display: inline-block;
  margin-top: var(--space-3);
}

.managed-installations-field {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-4);
  color: var(--color-text);
  font-size: var(--type-caption);
  font-weight: var(--font-weight-semibold);
}

.managed-installations-field input,
.managed-installations-field select {
  box-sizing: border-box;
  width: 100%;
  min-height: var(--size-control);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font: inherit;
}

.managed-installations-field input:focus-visible,
.managed-installations-field select:focus-visible,
.managed-installation-card:has(input:focus-visible) {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.managed-installations-field input:disabled,
.managed-installations-field select:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.managed-installations-selection,
.managed-installations-blocked {
  overflow-wrap: anywhere;
}

.managed-installations-selection {
  color: var(--color-success) !important;
  font-family: var(--font-mono);
  font-size: var(--type-caption);
}

.managed-installations-blocked {
  padding: var(--space-3);
  border-left: 2px solid var(--color-warning);
  background: var(--color-surface-muted);
}

.managed-executable-grid,
.managed-installations-form-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.managed-executable-card,
.managed-installation-card {
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
}

.managed-executable-card {
  display: grid;
  gap: var(--space-3);
}

.managed-executable-card p {
  min-height: calc(var(--type-caption) * 2.8);
  margin: 0;
  overflow-wrap: anywhere;
  font-size: var(--type-caption);
}

.managed-installations-card > .managed-primary-action,
.managed-installations-card > .managed-secondary-action {
  margin-top: var(--space-4);
}

.managed-installation-list {
  display: grid;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.managed-installation-card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  cursor: pointer;
}

.managed-installation-card[data-selected='true'] {
  border-color: color-mix(in srgb, var(--color-accent), var(--color-border) 40%);
}

.managed-installation-card input {
  flex: 0 0 auto;
  margin-top: 0.2em;
}

.managed-installation-card-content,
.managed-installation-card-heading {
  display: grid;
  min-width: 0;
  gap: var(--space-2);
}

.managed-installation-card-content > span:not(.managed-installation-card-heading) {
  overflow-wrap: anywhere;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.managed-installation-card-heading {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  color: var(--color-text);
}

.managed-launch-status {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.managed-launch-status[data-kind='running'] {
  border-color: color-mix(in srgb, var(--color-success), var(--color-border) 45%);
  color: var(--color-success);
}

.managed-launch-status[data-kind='starting'] {
  border-color: color-mix(in srgb, var(--color-accent), var(--color-border) 45%);
  color: var(--color-accent);
}

.managed-launch-status[data-kind='failed'] {
  border-color: color-mix(in srgb, var(--color-warning), var(--color-border) 45%);
  color: var(--color-warning);
}

.managed-switch-form {
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
}

.managed-installation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.managed-installations-operation,
.managed-installations-feedback {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
}

.managed-installations-operation {
  color: var(--color-accent);
}

.managed-installations-feedback--error,
.managed-installations-feedback--cancelled {
  border-color: color-mix(in srgb, var(--color-warning), var(--color-border) 50%);
  color: var(--color-warning);
}

@media (max-width: 980px) {
  .managed-executable-grid,
  .managed-installations-form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
