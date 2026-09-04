<script setup lang="ts">
import { computed } from 'vue'
import type { LauncherUpdateErrorCode } from '@/shared/contracts'
import type { MessageKey } from '@/app/shared/i18n/i18n'
import { locale, useTranslator } from '@/app/shared/i18n/useLocale'
import { useLauncherUpdates } from '../useLauncherUpdates'

const t = useTranslator()
const updates = useLauncherUpdates()
const updateState = updates.state
const updateError = updates.error
const isChecking = computed(
  () => updates.checking.value || updates.state.value?.kind === 'checking'
)

const FAILURE_MESSAGE_KEYS: Readonly<Record<LauncherUpdateErrorCode, MessageKey>> = {
  'launcher.update_invalid_request': 'settings.update.error.invalidRequest',
  'launcher.update_network_failed': 'settings.update.error.network',
  'launcher.update_http_failed': 'settings.update.error.http',
  'launcher.update_response_invalid': 'settings.update.error.response',
  'launcher.update_release_unsupported': 'settings.update.error.release',
  'launcher.update_release_url_invalid': 'settings.update.error.release',
  'launcher.update_platform_unsupported': 'settings.update.error.platform',
  'launcher.update_asset_missing': 'settings.update.error.asset',
  'launcher.update_asset_ambiguous': 'settings.update.error.asset',
  'launcher.update_asset_url_invalid': 'settings.update.error.asset',
  'launcher.update_not_available': 'settings.update.error.notAvailable',
  'launcher.update_open_failed': 'settings.update.error.open'
}

const failureMessage = computed(() => {
  const current = updateState.value
  return current?.kind === 'failed' ? t(FAILURE_MESSAGE_KEYS[current.code]) : undefined
})

const checkedAt = computed(() => {
  const current = updateState.value
  if (
    current?.kind !== 'up-to-date' &&
    current?.kind !== 'update-available' &&
    current?.kind !== 'failed'
  ) {
    return undefined
  }
  if (current.checkedAt === undefined) return undefined
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(current.checkedAt))
})

const statusLabel = computed(() => {
  const current = updateState.value
  if (current === undefined) {
    return updateError.value
      ? t('settings.update.status.failed')
      : t('settings.update.status.loading')
  }
  switch (current.kind) {
    case 'idle':
      return t('settings.update.status.idle')
    case 'checking':
      return t('settings.update.status.checking')
    case 'up-to-date':
      return t('settings.update.status.current')
    case 'update-available':
      return t('settings.update.status.available')
    case 'failed':
      return t('settings.update.status.failed')
  }
})
</script>

<template>
  <section
    class="settings-section settings-update-section"
    aria-labelledby="launcher-update-title"
    data-testid="settings-launcher-update"
  >
    <header class="settings-section-header">
      <div class="settings-section-title">
        <h3 id="launcher-update-title">{{ t('settings.update.title') }}</h3>
        <p>{{ t('settings.update.description') }}</p>
      </div>
      <span
        class="settings-section-meta settings-update-status-badge"
        :data-kind="updateState?.kind ?? (updateError ? 'failed' : 'loading')"
        role="status"
        aria-live="polite"
      >
        {{ statusLabel }}
      </span>
    </header>

    <div class="settings-section-body settings-update-body">
      <div v-if="updateState" class="settings-update-version-line">
        <span>{{ t('settings.update.currentVersion') }}</span>
        <strong>{{ updateState.currentVersion }}</strong>
        <template
          v-if="updateState.kind === 'up-to-date' || updateState.kind === 'update-available'"
        >
          <span class="settings-update-arrow" aria-hidden="true">→</span>
          <span>{{ t('settings.update.latestVersion') }}</span>
          <strong>{{ updateState.latestVersion }}</strong>
        </template>
      </div>

      <p v-if="updateState?.kind === 'idle'" class="settings-update-message">
        {{ t('settings.update.idle') }}
      </p>
      <p
        v-else-if="updateState?.kind === 'checking'"
        class="settings-update-message"
        role="status"
        aria-live="polite"
      >
        {{ t('settings.update.checking') }}
      </p>
      <p
        v-else-if="updateState?.kind === 'up-to-date'"
        class="settings-update-message settings-update-message--success"
      >
        {{ t('settings.update.upToDate') }}
      </p>
      <div v-else-if="updateState?.kind === 'update-available'" class="settings-update-available">
        <p class="settings-update-message settings-update-message--available">
          {{ t('settings.update.available') }}
        </p>
        <dl class="settings-update-asset">
          <div>
            <dt>{{ t('settings.update.asset') }}</dt>
            <dd>
              <code>{{ updateState.assetName }}</code>
            </dd>
          </div>
        </dl>
        <p class="settings-update-install-hint">{{ t('settings.update.installHint') }}</p>
      </div>
      <div v-else-if="updateState?.kind === 'failed'" class="settings-update-failure" role="alert">
        <p>{{ failureMessage }}</p>
        <p class="settings-update-code">
          <span>{{ t('settings.update.errorCode') }}</span>
          <code>{{ updateState.code }}</code>
        </p>
      </div>
      <p v-else-if="!updateState && !updateError" class="settings-update-message" role="status">
        {{ t('settings.update.loading') }}
      </p>

      <p v-if="checkedAt" class="settings-update-checked-at">
        <span>{{ t('settings.update.checkedAt') }}</span>
        <time
          :datetime="updateState && 'checkedAt' in updateState ? updateState.checkedAt : undefined"
        >
          {{ checkedAt }}
        </time>
      </p>

      <div v-if="updateError" class="settings-update-failure" role="alert">
        <p>{{ t('settings.update.operationFailed') }}</p>
        <p class="settings-update-code">
          <span>{{ t('settings.update.errorCode') }}</span>
          <code>{{ updateError }}</code>
        </p>
      </div>

      <footer class="settings-section-actions settings-update-actions">
        <button
          class="prototype-button prototype-button--secondary"
          type="button"
          :disabled="isChecking"
          :aria-busy="isChecking"
          data-testid="settings-check-update"
          @click="updates.check"
        >
          {{
            isChecking
              ? t('settings.update.checkingAction')
              : updateState?.kind === 'failed'
                ? t('settings.update.retry')
                : t('settings.update.check')
          }}
        </button>
        <button
          v-if="updateState?.kind === 'update-available'"
          class="prototype-button prototype-button--primary"
          type="button"
          :disabled="updates.openingDownload.value"
          :aria-busy="updates.openingDownload.value"
          data-testid="settings-download-update"
          @click="updates.openInstallerDownload"
        >
          {{
            updates.openingDownload.value
              ? t('settings.update.openingDownload')
              : t('settings.update.download')
          }}
        </button>
      </footer>
    </div>
  </section>
</template>
