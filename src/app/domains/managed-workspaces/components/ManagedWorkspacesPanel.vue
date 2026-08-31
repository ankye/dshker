<script setup lang="ts">
import { computed } from 'vue'
import type { DesktopApiErrorCode, ManagedRootKind } from '@/shared/contracts'
import { INITIAL_LOCALE, createTranslator } from '@/app/shared/i18n/i18n'
import ManagedInstallationsPanel from './ManagedInstallationsPanel.vue'
import { MANAGED_ROOT_SETUP_ITEMS } from '../contracts'
import { useManagedWorkspaces } from '../state/useManagedWorkspaces'

const props = withDefaults(
  defineProps<{
    readonly showInstallations?: boolean
  }>(),
  { showInstallations: true }
)

const t = createTranslator(INITIAL_LOCALE)
const manager = useManagedWorkspaces()

const operationLabel = computed(() => {
  const operation = manager.activeOperation.value
  if (!operation) return undefined
  switch (operation.kind) {
    case 'load':
      return t('managed.operation.loading')
    case 'select-root':
      return t('managed.operation.selectRoot')
    case 'register-roots':
      return t('managed.operation.registerRoots')
    case 'select-working-directory':
      return t('managed.operation.selectWorkingDirectory')
    case 'create-workspace':
      return t('managed.operation.createWorkspace')
  }
})

const feedbackText = computed(() => {
  const feedback = manager.feedback.value
  switch (feedback.kind) {
    case 'none':
      return undefined
    case 'cancelled':
      return t('managed.feedback.cancelled')
    case 'roots-registered':
      return t('managed.feedback.rootsRegistered')
    case 'workspace-created':
      return t('managed.feedback.workspaceCreated')
    case 'error':
      return t('managed.error.description')
  }
})

function rootSelection(kind: ManagedRootKind) {
  return manager.rootSelectionFor(kind)
}

function errorCode(value: DesktopApiErrorCode): string {
  return value
}
</script>

<template>
  <section class="managed-workspaces" :aria-busy="manager.isBusy.value">
    <p v-if="operationLabel" class="managed-operation" role="status">{{ operationLabel }}</p>

    <section v-if="manager.state.value.kind === 'loading'" class="managed-state-card">
      <p class="eyebrow">{{ t('managed.setup.kicker') }}</p>
      <h3>{{ t('managed.loading.title') }}</h3>
      <p>{{ t('managed.loading.description') }}</p>
    </section>

    <section
      v-else-if="manager.state.value.kind === 'bridge-unavailable'"
      class="managed-state-card"
    >
      <p class="eyebrow">{{ t('managed.setup.kicker') }}</p>
      <h3>{{ t('managed.bridge.title') }}</h3>
      <p>{{ t('managed.bridge.description') }}</p>
    </section>

    <section
      v-else-if="manager.state.value.kind === 'error'"
      class="managed-state-card managed-state-card--warning"
      role="alert"
    >
      <p class="eyebrow">{{ t('managed.diagnosticCode') }}</p>
      <h3>{{ t('managed.error.title') }}</h3>
      <p>{{ t('managed.error.description') }}</p>
      <code>{{ errorCode(manager.state.value.code) }}</code>
    </section>

    <section
      v-else-if="manager.state.value.kind === 'recovery-required'"
      class="managed-state-card managed-state-card--warning"
      role="alert"
    >
      <p class="eyebrow">{{ t('managed.diagnosticCode') }}</p>
      <h3>{{ t('managed.recovery.title') }}</h3>
      <p>{{ t('managed.recovery.description') }}</p>
      <code>{{ errorCode(manager.state.value.code) }}</code>
    </section>

    <section v-else-if="manager.state.value.kind === 'setup-required'" class="managed-setup">
      <header class="managed-section-header">
        <p class="eyebrow">{{ t('managed.setup.kicker') }}</p>
        <h3>{{ t('managed.setup.title') }}</h3>
        <p>{{ t('managed.setup.description') }}</p>
        <p class="managed-diagnostic">
          <span>{{ t('managed.diagnosticCode') }}</span>
          <code>{{ errorCode(manager.state.value.code) }}</code>
        </p>
      </header>

      <div class="managed-root-grid" role="list" :aria-label="t('managed.setup.title')">
        <article
          v-for="item in MANAGED_ROOT_SETUP_ITEMS"
          :key="item.kind"
          class="managed-root-card"
          role="listitem"
        >
          <div class="managed-root-heading">
            <div>
              <h4>{{ t(item.labelKey) }}</h4>
              <p>{{ t(item.descriptionKey) }}</p>
            </div>
            <span class="managed-root-status" :data-selected="Boolean(rootSelection(item.kind))">
              {{
                rootSelection(item.kind)
                  ? t('managed.setup.selectionSelected')
                  : t('managed.setup.selectionNone')
              }}
            </span>
          </div>
          <p v-if="rootSelection(item.kind)" class="managed-selection-name">
            {{ rootSelection(item.kind)?.displayName }}
          </p>
          <button
            class="managed-secondary-action"
            type="button"
            :disabled="manager.isBusy.value"
            :aria-label="`${rootSelection(item.kind) ? t('managed.action.changeDirectory') : t('managed.action.selectDirectory')} ${t(item.labelKey)}`"
            :data-testid="`select-root-${item.kind}`"
            @click="manager.selectRootDirectory(item.kind)"
          >
            {{
              rootSelection(item.kind)
                ? t('managed.action.changeDirectory')
                : t('managed.action.selectDirectory')
            }}
          </button>
        </article>
      </div>

      <p class="managed-setup-requirement">{{ t('managed.setup.requirement') }}</p>
      <p v-if="!manager.canRegisterRoots.value" class="managed-setup-requirement">
        {{ t('managed.setup.missingRoots') }}
      </p>
      <button
        class="managed-primary-action"
        type="button"
        :disabled="!manager.canRegisterRoots.value"
        data-testid="register-roots"
        @click="manager.registerRoots"
      >
        {{ t('managed.setup.registerRoots') }}
      </button>
    </section>

    <section v-else class="managed-ready">
      <header class="managed-section-header">
        <p class="eyebrow">{{ t('managed.ready.rootsTitle') }}</p>
        <h3>{{ t('managed.ready.rootsTitle') }}</h3>
        <p>{{ t('managed.ready.rootsDescription') }}</p>
      </header>

      <div class="managed-registered-roots" role="list" :aria-label="t('managed.ready.rootsTitle')">
        <article
          v-for="root in manager.orderedRoots.value"
          :key="root.rootId"
          class="managed-registered-root"
          role="listitem"
        >
          <p class="managed-registered-root-label">{{ t(root.setupItem.labelKey) }}</p>
          <code class="managed-path">{{ root.canonicalPath }}</code>
          <p class="managed-root-id">
            <span>{{ t('managed.ready.rootId') }}</span> {{ root.rootId }}
          </p>
        </article>
      </div>

      <section class="managed-workspace-section" :aria-labelledby="'managed-workspaces-heading'">
        <header class="managed-section-header">
          <p class="eyebrow">{{ t('managed.ready.workspaceTitle') }}</p>
          <h3 id="managed-workspaces-heading">{{ t('managed.ready.workspaceTitle') }}</h3>
          <p>{{ t('managed.ready.workspaceDescription') }}</p>
        </header>

        <p v-if="manager.workspaces.value.length === 0" class="managed-empty-workspace">
          {{ t('managed.ready.emptyWorkspace') }}
        </p>
        <div
          v-else
          class="managed-workspace-list"
          role="list"
          :aria-label="t('managed.ready.workspaceTitle')"
        >
          <article
            v-for="workspace in manager.workspaces.value"
            :key="workspace.workspaceId"
            class="managed-workspace-card"
            role="listitem"
          >
            <h4>{{ workspace.displayName }}</h4>
            <p class="managed-workspace-id">{{ workspace.workspaceId }}</p>
            <dl>
              <div>
                <dt>{{ t('managed.ready.workingDirectory') }}</dt>
                <dd>
                  <code class="managed-path">{{ workspace.workingDirectoryCanonicalPath }}</code>
                </dd>
              </div>
              <div>
                <dt>{{ t('managed.ready.namespaces') }}</dt>
                <dd>
                  <ul class="managed-namespaces">
                    <li v-for="binding in workspace.rootNamespaces" :key="binding.rootId">
                      <code>{{ binding.rootId }}/{{ binding.namespace }}</code>
                    </li>
                  </ul>
                </dd>
              </div>
            </dl>
          </article>
        </div>

        <form class="managed-create-workspace" @submit.prevent="manager.createWorkspace">
          <h4>{{ t('managed.workspace.createTitle') }}</h4>
          <p>{{ t('managed.workspace.createDescription') }}</p>
          <button
            class="managed-secondary-action"
            type="button"
            :disabled="manager.isBusy.value"
            data-testid="select-working-directory"
            @click="manager.selectWorkingDirectory"
          >
            {{ t('managed.workspace.selectDirectory') }}
          </button>
          <p v-if="manager.workingDirectorySelection.value" class="managed-selection-name">
            {{ t('managed.workspace.selectedDirectory') }}
            {{ manager.workingDirectorySelection.value.displayName }}
          </p>
          <p v-else class="managed-setup-requirement">{{ t('managed.workspace.nameLocked') }}</p>
          <label class="managed-workspace-name-field">
            <span>{{ t('managed.workspace.nameLabel') }}</span>
            <input
              v-model="manager.workspaceDisplayName.value"
              :disabled="!manager.workingDirectorySelection.value || manager.isBusy.value"
              :placeholder="t('managed.workspace.namePlaceholder')"
              autocomplete="off"
              data-testid="workspace-display-name"
              name="workspace-display-name"
              required
            />
          </label>
          <button
            class="managed-primary-action"
            type="submit"
            :disabled="!manager.canCreateWorkspace.value"
            data-testid="create-workspace"
          >
            {{ t('managed.workspace.createAction') }}
          </button>
        </form>
      </section>

      <ManagedInstallationsPanel
        v-if="props.showInstallations"
        :workspaces="manager.workspaces.value"
      />
    </section>

    <p
      v-if="feedbackText"
      class="managed-feedback"
      :class="{
        'managed-feedback--error': manager.feedback.value.kind === 'error',
        'managed-feedback--cancelled': manager.feedback.value.kind === 'cancelled'
      }"
      :role="manager.feedback.value.kind === 'error' ? 'alert' : 'status'"
    >
      {{ feedbackText }}
      <code
        v-if="
          manager.feedback.value.kind === 'error' || manager.feedback.value.kind === 'cancelled'
        "
      >
        {{ errorCode(manager.feedback.value.code) }}
      </code>
    </p>
  </section>
</template>

<style scoped>
.managed-workspaces {
  display: grid;
  gap: var(--space-4);
}

.managed-state-card,
.managed-setup,
.managed-ready,
.managed-create-workspace {
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface-raised);
}

.managed-state-card--warning {
  border-color: color-mix(in srgb, var(--color-warning), var(--color-border) 50%);
}

.managed-state-card h3,
.managed-section-header h3,
.managed-root-card h4,
.managed-workspace-card h4,
.managed-create-workspace h4 {
  margin: 0;
  color: var(--color-text);
  font-size: var(--type-section);
  font-weight: var(--font-weight-semibold);
}

.managed-state-card p,
.managed-section-header p,
.managed-root-card p,
.managed-create-workspace p {
  margin: var(--space-2) 0 0;
  color: var(--color-text-muted);
}

.managed-state-card code,
.managed-feedback code {
  display: inline-block;
  margin-top: var(--space-3);
}

.managed-section-header {
  margin-bottom: var(--space-4);
}

.managed-diagnostic {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--type-caption);
}

.managed-diagnostic span {
  font-family: var(--font-sans);
}

.managed-root-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.managed-root-card,
.managed-registered-root,
.managed-workspace-card {
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
}

.managed-root-heading {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.managed-root-heading > div {
  min-width: 0;
}

.managed-root-status {
  flex: 0 0 auto;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.managed-root-status[data-selected='true'] {
  border-color: color-mix(in srgb, var(--color-success), var(--color-border) 45%);
  color: var(--color-success);
}

.managed-selection-name,
.managed-path,
.managed-workspace-id,
.managed-root-id {
  overflow-wrap: anywhere;
}

.managed-selection-name {
  min-height: var(--size-control);
  padding: var(--space-2) 0;
  color: var(--color-success) !important;
  font-family: var(--font-mono);
  font-size: var(--type-caption);
}

.managed-secondary-action,
.managed-primary-action {
  min-height: var(--size-control);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
  color: var(--color-text);
  cursor: pointer;
}

.managed-primary-action {
  border-color: color-mix(in srgb, var(--color-accent), var(--color-border) 40%);
  background: color-mix(in srgb, var(--color-accent), var(--color-bg) 75%);
}

.managed-secondary-action:hover:not(:disabled),
.managed-primary-action:hover:not(:disabled) {
  border-color: var(--color-accent);
}

.managed-secondary-action:disabled,
.managed-primary-action:disabled,
.managed-workspace-name-field input:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.managed-setup-requirement {
  margin: var(--space-3) 0 0;
  color: var(--color-text-muted);
  font-size: var(--type-ui);
}

.managed-setup .managed-primary-action {
  margin-top: var(--space-4);
}

.managed-registered-roots,
.managed-workspace-list {
  display: grid;
  gap: var(--space-2);
}

.managed-registered-root {
  display: grid;
  grid-template-columns: minmax(9rem, 0.5fr) minmax(0, 2fr);
  gap: var(--space-2) var(--space-4);
  align-items: baseline;
}

.managed-registered-root-label,
.managed-root-id,
.managed-workspace-id {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.managed-root-id {
  grid-column: 2;
}

.managed-root-id span {
  color: var(--color-text-muted);
}

.managed-workspace-section {
  margin-top: var(--space-6);
}

.managed-empty-workspace {
  margin: 0;
  padding: var(--space-4);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius);
  color: var(--color-text-muted);
}

.managed-workspace-card {
  display: grid;
  gap: var(--space-2);
}

.managed-workspace-card dl {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-2) 0 0;
}

.managed-workspace-card dl > div {
  display: grid;
  grid-template-columns: 8rem minmax(0, 1fr);
  gap: var(--space-3);
}

.managed-workspace-card dt {
  color: var(--color-text-muted);
}

.managed-workspace-card dd {
  min-width: 0;
  margin: 0;
}

.managed-namespaces {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.managed-create-workspace {
  display: grid;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.managed-create-workspace > p {
  margin: 0;
}

.managed-create-workspace .managed-selection-name,
.managed-create-workspace .managed-setup-requirement {
  margin: 0;
  padding: 0;
}

.managed-workspace-name-field {
  display: grid;
  gap: var(--space-2);
  color: var(--color-text);
  font-size: var(--type-ui);
  font-weight: var(--font-weight-medium);
}

.managed-workspace-name-field input {
  width: min(100%, 28rem);
  min-height: var(--size-control);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  outline: none;
  background: var(--color-bg);
  color: var(--color-text);
}

.managed-workspace-name-field input:focus-visible {
  border-color: var(--color-accent);
  box-shadow: var(--focus-ring);
}

.managed-create-workspace .managed-primary-action {
  justify-self: start;
}

.managed-feedback,
.managed-operation {
  margin: 0;
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--color-success), var(--color-border) 50%);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--color-success), var(--color-bg) 90%);
  color: var(--color-text);
}

.managed-operation {
  border-color: var(--color-border);
  background: var(--color-surface);
  color: var(--color-text-muted);
}

.managed-feedback--error,
.managed-feedback--cancelled {
  border-color: color-mix(in srgb, var(--color-warning), var(--color-border) 50%);
  background: color-mix(in srgb, var(--color-warning), var(--color-bg) 92%);
}

@media (max-width: 780px) {
  .managed-root-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .managed-registered-root,
  .managed-workspace-card dl > div {
    grid-template-columns: minmax(0, 1fr);
  }

  .managed-root-id {
    grid-column: 1;
  }
}
</style>
