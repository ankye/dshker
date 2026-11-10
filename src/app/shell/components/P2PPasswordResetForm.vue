<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { P2P_ACCOUNT_PASSWORD_MAX, P2P_ACCOUNT_PASSWORD_MIN } from '@/shared/p2p-management'
import { useTranslator } from '@/app/shared/i18n/useLocale'

const props = defineProps<{
  serviceId?: string
  username: string
  disabled: boolean
}>()
const emit = defineEmits<{
  submit: [email: string, code: string, password: string]
}>()
const t = useTranslator()
const email = ref(props.username)
const code = ref('')
const password = ref('')
const confirmation = ref('')
const tooShort = computed(() => Array.from(password.value).length < P2P_ACCOUNT_PASSWORD_MIN)
const tooLong = computed(
  () => new TextEncoder().encode(password.value).length > P2P_ACCOUNT_PASSWORD_MAX
)
const mismatch = computed(() => confirmation.value !== '' && confirmation.value !== password.value)
const blocked = computed(
  () =>
    props.disabled ||
    !/^[a-f0-9]{64}$/.test(code.value) ||
    tooShort.value ||
    tooLong.value ||
    confirmation.value === '' ||
    mismatch.value
)

function clearSecrets(): void {
  code.value = ''
  password.value = ''
  confirmation.value = ''
}
function submit(): void {
  if (blocked.value) return
  const suppliedCode = code.value
  const suppliedPassword = password.value
  clearSecrets()
  emit('submit', email.value, suppliedCode, suppliedPassword)
}
watch(() => props.serviceId, clearSecrets)
onBeforeUnmount(clearSecrets)
</script>

<template>
  <form data-testid="p2p-password-reset-form" @submit.prevent="submit">
    <p>{{ t('p2p.account.resetHint') }}</p>
    <fieldset :disabled="disabled" class="p2p-reset-fields">
      <legend>{{ t('p2p.account.resetPassword') }}</legend>
      <label>
        <span>{{ t('p2p.account.email') }}</span>
        <input
          v-model="email"
          type="email"
          required
          autocomplete="username"
          spellcheck="false"
          data-testid="p2p-reset-email"
        />
      </label>
      <label>
        <span>{{ t('p2p.account.resetCode') }}</span>
        <input
          v-model="code"
          type="password"
          required
          autocomplete="off"
          spellcheck="false"
          pattern="[a-f0-9]{64}"
          data-testid="p2p-reset-code"
        />
      </label>
      <label>
        <span>{{ t('p2p.account.newPassword') }}</span>
        <input
          v-model="password"
          type="password"
          required
          autocomplete="new-password"
          data-testid="p2p-reset-password"
        />
      </label>
      <p class="p2p-reset-rule">{{ t('p2p.account.passwordRule') }}</p>
      <p v-if="password !== '' && tooShort" class="remote-error" role="alert">
        {{ t('p2p.account.passwordTooShort') }}
      </p>
      <p v-if="tooLong" class="remote-error" role="alert">
        {{ t('p2p.account.passwordTooLong') }}
      </p>
      <label>
        <span>{{ t('p2p.account.resetConfirm') }}</span>
        <input
          v-model="confirmation"
          type="password"
          required
          autocomplete="new-password"
          data-testid="p2p-reset-confirm"
        />
      </label>
      <p v-if="mismatch" class="remote-error" role="alert">
        {{ t('p2p.account.resetMismatch') }}
      </p>
      <button
        type="submit"
        class="prototype-button prototype-button--primary"
        :disabled="blocked"
        data-testid="p2p-reset-submit"
      >
        {{ t('p2p.account.resetPassword') }}
      </button>
    </fieldset>
  </form>
</template>

<style scoped>
.p2p-reset-fields {
  display: grid;
  gap: 0.5rem;
  border: 0;
  margin: 0;
  padding: 0;
}
.p2p-reset-fields label {
  display: grid;
  gap: 0.25rem;
  font-size: 0.8125rem;
}
.p2p-reset-fields input {
  font: inherit;
  color: inherit;
  background: var(--surface-sunken, #0f141b);
  border: 1px solid var(--border-muted, #2a3542);
  border-radius: 0.375rem;
  padding: 0.4rem 0.55rem;
}
.p2p-reset-fields button {
  justify-self: start;
}
.p2p-reset-rule {
  margin: 0;
  font-size: 0.75rem;
  opacity: 0.75;
}
</style>
