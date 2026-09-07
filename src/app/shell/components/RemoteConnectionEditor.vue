<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  remoteConnectionEditor as editor,
  useRemoteConnections
} from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'

const remote = useRemoteConnections()
const t = useTranslator()
const firstInput = ref<HTMLInputElement>()
const busy = computed(
  () =>
    editor.original.value !== undefined &&
    remote.pendingActions.value[editor.original.value.connectionId] !== undefined
)

watch(
  () => editor.original.value?.connectionId,
  async () => {
    await nextTick()
    firstInput.value?.focus()
  },
  { immediate: true }
)

function restoreFocus(id: string): void {
  void nextTick(() => document.getElementById(`remote-edit-${id}`)?.focus())
}

function close(): void {
  if (busy.value) return
  const id = editor.original.value?.connectionId
  if (editor.close() && id !== undefined) restoreFocus(id)
}

function discard(): void {
  const id = editor.original.value?.connectionId
  editor.discard()
  if (editor.original.value === undefined && id !== undefined) restoreFocus(id)
}

async function reload(): Promise<void> {
  if (busy.value) return
  if (await remote.refresh()) editor.reload()
}

async function save(): Promise<void> {
  const original = editor.original.value
  const draft = editor.draft.value
  if (original === undefined || draft === undefined || busy.value) return
  const saved = await remote.update({
    ...draft,
    port: Number(draft.port),
    connectionId: original.connectionId,
    expectedConfigRevision: original.configRevision
  })
  if (saved && editor.original.value?.connectionId === original.connectionId) {
    editor.clear()
    restoreFocus(original.connectionId)
  }
}
</script>

<template>
  <section
    v-if="editor.original.value && editor.draft.value"
    class="remote-add-card"
    aria-labelledby="remote-edit-title"
    @keydown.esc.prevent="close"
  >
    <h2 id="remote-edit-title">
      {{ t('remote.edit.title') }} · {{ editor.original.value.displayName }}
    </h2>
    <p>{{ t('remote.edit.hint') }}</p>
    <form class="remote-add-form" data-testid="remote-edit-form" @submit.prevent="save">
      <label
        ><span>{{ t('remote.field.name') }}</span
        ><input
          ref="firstInput"
          v-model="editor.draft.value.displayName"
          type="text"
          required
          maxlength="64"
          :disabled="busy"
      /></label>
      <label
        ><span>{{ t('remote.field.host') }}</span
        ><input v-model="editor.draft.value.host" type="text" required :disabled="busy"
      /></label>
      <label
        ><span>{{ t('remote.field.port') }}</span
        ><input
          v-model="editor.draft.value.port"
          type="number"
          required
          min="1"
          max="65535"
          :disabled="busy"
      /></label>
      <label
        ><span>{{ t('remote.field.user') }}</span
        ><input v-model="editor.draft.value.user" type="text" required :disabled="busy"
      /></label>
      <button class="prototype-button prototype-button--primary" type="submit" :disabled="busy">
        {{ busy ? t('remote.add.saving') : t('remote.edit.save') }}
      </button>
      <button class="prototype-button" type="button" :disabled="busy" @click="close">
        {{ t('remote.edit.cancel') }}
      </button>
    </form>
    <p v-if="remote.error.value === 'remote.config_conflict'" role="alert">
      {{ t('remote.edit.conflict') }}
      <button class="prototype-button" type="button" :disabled="busy" @click="reload">
        {{ t('remote.edit.reload') }}
      </button>
    </p>
    <div
      v-if="editor.discardRequested.value"
      role="alertdialog"
      :aria-label="t('remote.edit.discardQuestion')"
    >
      <p>{{ t('remote.edit.discardQuestion') }}</p>
      <button class="prototype-button" type="button" @click="editor.keep">
        {{ t('remote.edit.keep') }}
      </button>
      <button class="prototype-button prototype-button--danger" type="button" @click="discard">
        {{ t('remote.edit.discard') }}
      </button>
    </div>
  </section>
</template>
