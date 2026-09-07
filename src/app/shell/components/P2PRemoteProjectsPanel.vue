<script setup lang="ts">
import { computed, onMounted } from 'vue'
import {
  p2pConnections as connections,
  p2pManagement as management,
  p2pRemoteProjects as projects
} from '@/app/domains/remote-connections'
import { REMOTE_PAGE_SIZE } from '@/app/domains/remote-connections/p2pRemoteProjects'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import type { MessageKey } from '@/app/shared/i18n/i18n'
import type { P2PRemoteEntryView } from '@/shared/p2p-management'

const props = defineProps<{ serviceId: string; pairId: string }>()
const t = useTranslator()
const state = projects.state(props.serviceId, props.pairId)
const pending = computed(() => management.busy(props.serviceId))
/** Browsing requires a live connection; a pair alone is not enough. */
const connected = computed(() => connections.isReady(props.serviceId, props.pairId))
const selectedRoot = computed(() =>
  state.roots?.find((root) => root.rootId === state.selectedRootId)
)
const page = computed(() => Math.floor(state.offset / REMOTE_PAGE_SIZE) + 1)
const hasPrev = computed(() => state.offset > 0)
const hasNext = computed(() => state.offset + REMOTE_PAGE_SIZE < state.total)

const failureLabels: Record<string, MessageKey> = {
  'p2p.remote_path_forbidden': 'p2p.remote.failedForbidden',
  'p2p.remote_path_missing': 'p2p.remote.failedMissing',
  'p2p.remote_root_unauthorized': 'p2p.remote.failedUnauthorized',
  'p2p.remote_reference_invalid': 'p2p.remote.failedUnauthorized'
}
const failureMessage = computed<MessageKey | undefined>(() =>
  state.loadFailed ? (failureLabels[state.loadFailed] ?? 'p2p.remote.failedOther') : undefined
)

onMounted(() => {
  if (connected.value) void projects.readRoots(props.serviceId, props.pairId)
})

function entryKind(entry: P2PRemoteEntryView): string {
  return entry.isProject ? t('p2p.remote.project') : ''
}
</script>

<template>
  <section class="p2p-remote" :aria-label="t('p2p.remote.title')" data-testid="p2p-remote-projects">
    <div class="remote-section-heading">
      <div>
        <h4>{{ t('p2p.remote.title') }}</h4>
        <p>{{ t('p2p.remote.description') }}</p>
      </div>
      <button
        type="button"
        class="prototype-button"
        :disabled="pending || !connected"
        data-testid="p2p-remote-read-roots"
        @click="projects.readRoots(serviceId, pairId)"
      >
        {{ t('p2p.remote.readRoots') }}
      </button>
    </div>

    <!-- The scope of authorized roots must not be mistaken for sandboxing DSH. -->
    <p class="remote-form-hint" data-testid="p2p-remote-approval-notice">
      {{ t('p2p.remote.approvalNotice') }}
    </p>

    <p v-if="!connected">{{ t('p2p.remote.notConnected') }}</p>
    <template v-else>
      <p v-if="failureMessage" role="alert" class="remote-error">
        {{ t(failureMessage) }} <code>{{ state.loadFailed }}</code>
      </p>

      <p v-if="state.roots === undefined">{{ t('p2p.remote.rootsUnknown') }}</p>
      <p v-else-if="state.roots.length === 0">{{ t('p2p.remote.rootsEmpty') }}</p>
      <template v-else>
        <fieldset :disabled="pending" class="p2p-remote-roots">
          <legend>{{ t('p2p.remote.selectRoot') }}</legend>
          <ul>
            <li v-for="root in state.roots" :key="root.rootId">
              <button
                type="button"
                class="prototype-button"
                :aria-pressed="root.rootId === state.selectedRootId"
                :data-testid="`p2p-remote-root-${root.rootId}`"
                @click="projects.selectRoot(serviceId, pairId, root.rootId)"
              >
                {{ root.name }}
              </button>
              <dl>
                <dt>{{ t('p2p.remote.rootPath') }}</dt>
                <dd>
                  <code>{{ root.path }}</code>
                </dd>
              </dl>
            </li>
          </ul>
          <p class="remote-form-hint">{{ t('p2p.remote.rootPathHint') }}</p>
        </fieldset>
        <p v-if="!selectedRoot" class="remote-form-hint">
          {{ t('p2p.remote.selectRootRequired') }}
        </p>
      </template>

      <template v-if="selectedRoot">
        <!-- Breadcrumb trail, so the user can walk back without a path. -->
        <nav class="p2p-remote-trail" :aria-label="selectedRoot.name">
          <button
            type="button"
            class="prototype-button"
            :disabled="pending || state.trail.length === 0"
            @click="projects.ascend(serviceId, pairId, 0)"
          >
            {{ t('p2p.remote.backToRoot') }}
          </button>
          <button
            v-for="(crumb, index) in state.trail"
            :key="crumb.ref"
            type="button"
            class="prototype-button"
            :disabled="pending || index === state.trail.length - 1"
            @click="projects.ascend(serviceId, pairId, index + 1)"
          >
            {{ crumb.name }}
          </button>
        </nav>

        <p v-if="state.entries === undefined && !failureMessage">
          {{ t('p2p.remote.entriesUnknown') }}
        </p>
        <p v-else-if="state.entries && state.entries.length === 0">
          {{ t('p2p.remote.entriesEmpty') }}
        </p>
        <ul v-else-if="state.entries" class="p2p-remote-entries">
          <li v-for="entry in state.entries" :key="entry.ref">
            <span>{{ entry.name }}</span>
            <span v-if="entry.isProject" class="p2p-remote-badge">{{ entryKind(entry) }}</span>
            <button
              type="button"
              class="prototype-button"
              :disabled="pending"
              @click="projects.enter(serviceId, pairId, entry)"
            >
              {{ t('p2p.remote.enter') }}
            </button>
            <button
              v-if="entry.isProject"
              type="button"
              class="prototype-button prototype-button--primary"
              :disabled="pending"
              :data-testid="`p2p-remote-choose-${entry.ref}`"
              @click="projects.choose(serviceId, pairId, entry)"
            >
              {{ t('p2p.remote.choose') }}
            </button>
          </li>
        </ul>

        <div v-if="state.total > REMOTE_PAGE_SIZE" class="p2p-remote-paging">
          <button
            type="button"
            class="prototype-button"
            :disabled="pending || !hasPrev"
            @click="projects.page(serviceId, pairId, state.offset - REMOTE_PAGE_SIZE)"
          >
            {{ t('p2p.remote.prevPage') }}
          </button>
          <span data-testid="p2p-remote-page">
            {{ t('p2p.remote.page') }} {{ page }} · {{ t('p2p.remote.pageTotal') }}
            {{ state.total }}
          </span>
          <button
            type="button"
            class="prototype-button"
            :disabled="pending || !hasNext"
            @click="projects.page(serviceId, pairId, state.offset + REMOTE_PAGE_SIZE)"
          >
            {{ t('p2p.remote.nextPage') }}
          </button>
        </div>
      </template>

      <div v-if="state.chosen" class="p2p-remote-chosen" role="status">
        <dl>
          <dt>{{ t('p2p.remote.chosen') }}</dt>
          <dd data-testid="p2p-remote-chosen">{{ state.chosen.name }}</dd>
        </dl>
        <button
          type="button"
          class="prototype-button"
          @click="projects.clearChoice(serviceId, pairId)"
        >
          {{ t('p2p.remote.clearChoice') }}
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.p2p-remote {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}
.p2p-remote fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.p2p-remote ul {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.p2p-remote-entries li,
.p2p-remote-roots li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.p2p-remote dl {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
  gap: var(--space-2);
  margin: 0;
}
.p2p-remote dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.p2p-remote-trail,
.p2p-remote-paging {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.p2p-remote-badge {
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 0.85em;
}
.p2p-remote-chosen {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface-muted);
}
</style>
