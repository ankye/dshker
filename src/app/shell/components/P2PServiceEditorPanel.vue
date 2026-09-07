<script setup lang="ts">
import { computed } from 'vue'
import {
  p2pManagement as management,
  p2pServiceEditor as editor
} from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import type { MessageKey } from '@/app/shared/i18n/i18n'

/**
 * Editor for the shared configuration of one P2P service.
 *
 * The configuration is shared by every computer paired through this service, so
 * the panel says so before the user changes anything, refuses to save while any
 * of those computers is busy, and keeps the typed input on every failure so
 * nothing has to be retyped.
 */
const t = useTranslator()
const draft = computed(() => editor.draft.value)
const service = computed(() => editor.original.value)
const pending = computed(() => (service.value ? management.busy(service.value.serviceId) : false))

const failureLabels: Record<string, MessageKey> = {
  'p2p.catalog_conflict': 'p2p.serviceEdit.conflict',
  'p2p.service_busy': 'p2p.serviceEdit.busy',
  'p2p.identity_mismatch': 'p2p.serviceEdit.identityMismatch',
  'p2p.service_exists': 'p2p.serviceEdit.duplicate'
}
const lastFailure = computed<MessageKey | undefined>(() => {
  if (editor.conflict.value) return 'p2p.serviceEdit.conflict'
  const code = service.value
    ? management.operations[`updateServiceConfig:${service.value.serviceId}`]?.error
    : undefined
  return code ? (failureLabels[code] ?? 'p2p.serviceEdit.failed') : undefined
})

async function save(): Promise<void> {
  await editor.save()
}
</script>

<template>
  <section
    v-if="service && draft"
    class="p2p-service-editor"
    :aria-label="t('p2p.serviceEdit.title')"
    data-testid="p2p-service-editor"
  >
    <div>
      <h4>{{ t('p2p.serviceEdit.title') }}</h4>
      <!-- The shared blast radius must be stated before anything is changed. -->
      <p class="remote-form-hint">{{ t('p2p.serviceEdit.sharedNotice') }}</p>
    </div>

    <p v-if="editor.resultUnconfirmed.value" role="alert" class="remote-error">
      {{ t('p2p.serviceEdit.unconfirmed') }}
    </p>
    <p v-else-if="lastFailure" role="alert" class="remote-error">{{ t(lastFailure) }}</p>

    <fieldset :disabled="pending">
      <label>
        <span>{{ t('p2p.serviceEdit.displayName') }}</span>
        <input
          v-model="draft.displayName"
          type="text"
          autocomplete="off"
          data-testid="p2p-service-name"
        />
      </label>
      <label>
        <span>{{ t('p2p.serviceEdit.httpsOrigin') }}</span>
        <input
          v-model="draft.httpsOrigin"
          type="text"
          inputmode="url"
          autocomplete="off"
          data-testid="p2p-service-https"
        />
      </label>
      <label>
        <span>{{ t('p2p.serviceEdit.wssUrl') }}</span>
        <input
          v-model="draft.wssUrl"
          type="text"
          inputmode="url"
          autocomplete="off"
          data-testid="p2p-service-wss"
        />
      </label>
      <label>
        <span>{{ t('p2p.serviceEdit.stunAddress') }}</span>
        <input
          v-model="draft.stunAddress"
          type="text"
          autocomplete="off"
          data-testid="p2p-service-stun"
        />
      </label>
    </fieldset>

    <p v-if="editor.dirty.value" class="remote-form-hint">
      {{ t('p2p.serviceEdit.willInvalidateTests') }}
    </p>

    <div class="p2p-service-editor-actions">
      <button
        type="button"
        class="prototype-button prototype-button--primary"
        :disabled="!editor.canSave.value"
        data-testid="p2p-service-save"
        @click="save()"
      >
        {{ t('p2p.serviceEdit.save') }}
      </button>
      <button
        type="button"
        class="prototype-button"
        :disabled="pending"
        data-testid="p2p-service-cancel"
        @click="editor.close()"
      >
        {{ t('p2p.serviceEdit.cancel') }}
      </button>
    </div>

    <!-- Closing a dirty draft asks first, so typed input is never lost silently. -->
    <div
      v-if="editor.discardRequested.value"
      role="alertdialog"
      class="p2p-service-editor-confirm"
      data-testid="p2p-service-discard"
    >
      <p>{{ t('p2p.serviceEdit.discardPrompt') }}</p>
      <button
        type="button"
        class="prototype-button"
        data-testid="p2p-service-discard-keep"
        @click="editor.keep()"
      >
        {{ t('p2p.serviceEdit.keepEditing') }}
      </button>
      <button
        type="button"
        class="prototype-button"
        data-testid="p2p-service-discard-confirm"
        @click="editor.discard()"
      >
        {{ t('p2p.serviceEdit.discard') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.p2p-service-editor {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
}
.p2p-service-editor fieldset {
  display: grid;
  gap: var(--space-2);
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.p2p-service-editor label {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
.p2p-service-editor input {
  min-width: 0;
}
.p2p-service-editor-actions,
.p2p-service-editor-confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.p2p-service-editor-confirm {
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface-muted);
}
</style>
