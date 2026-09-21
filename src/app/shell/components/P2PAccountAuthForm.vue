<script setup lang="ts">
import { computed, ref } from 'vue'
import { P2P_ACCOUNT_PASSWORD_MIN } from '@/shared/p2p-management'
import { useTranslator } from '@/app/shared/i18n/useLocale'

/**
 * The credential forms, owned by the component that holds the secrets.
 *
 * Signing in shows one form at a time; the other is one link away. The drafts live
 * here rather than in the panel so a password field is destroyed, not merely
 * cleared, when the form goes away — the panel used to keep them and had to
 * remember to wipe them on unmount and on every account change. The account name
 * is the panel's, because it is worth keeping: the domain holds it across a tab
 * switch, so returning to the form does not ask for it again.
 */
const props = defineProps<{
  serviceId?: string
  username: string
  busy: boolean
  uncertain: boolean
  disabled?: boolean
}>()
const emit = defineEmits<{
  login: [username: string, password: string]
  register: [email: string, password: string]
  'update:username': [value: string]
}>()
const t = useTranslator()

const password = ref('')
/** Registration drafts stay local, including the email: sharing one draft with the
 * login form let typing in one silently rewrite the other. */
const registerEmail = ref('')
const registerPassword = ref('')
const registerConfirm = ref('')
const mode = ref<'login' | 'register'>('login')

/** Optional confirmation must match before a register submit is allowed. */
const registerMismatch = computed(
  () => registerConfirm.value !== '' && registerConfirm.value !== registerPassword.value
)
/**
 * The coordinator refuses a short password with p2p.invalid_user_credentials.
 * Checking it here turns that refusal into an inline requirement, and the server
 * stays authoritative: this only avoids a round trip that must fail.
 */
const registerTooShort = computed(
  () => registerPassword.value !== '' && registerPassword.value.length < P2P_ACCOUNT_PASSWORD_MIN
)
const registerBlocked = computed(
  () =>
    registerMismatch.value ||
    registerTooShort.value ||
    registerPassword.value.length < P2P_ACCOUNT_PASSWORD_MIN
)
const fieldsDisabled = computed(() => props.disabled === true || props.busy || props.uncertain)

function submitLogin(): void {
  const supplied = password.value
  password.value = ''
  emit('login', props.username, supplied)
}
function submitRegister(): void {
  if (registerBlocked.value) return
  const supplied = registerPassword.value
  const email = registerEmail.value
  registerPassword.value = ''
  registerConfirm.value = ''
  emit('register', email, supplied)
}
/** Switching forms discards only the secrets typed into the abandoned one. */
function switchMode(next: 'login' | 'register'): void {
  mode.value = next
  password.value = ''
  registerPassword.value = ''
  registerConfirm.value = ''
}
</script>

<template>
  <form v-if="mode === 'login'" data-testid="p2p-login-form" @submit.prevent="submitLogin">
    <fieldset :disabled="fieldsDisabled" class="p2p-account-fields p2p-account-fields--stacked">
      <legend>{{ t('p2p.account.login') }}</legend>
      <label
        ><span>{{ t('p2p.account.email') }}</span
        ><input
          :id="serviceId ? `p2p-login-email-${serviceId}` : undefined"
          :value="username"
          type="email"
          required
          autocomplete="username"
          spellcheck="false"
          @input="emit('update:username', ($event.target as HTMLInputElement).value)"
      /></label>
      <label
        ><span>{{ t('p2p.account.password') }}</span
        ><input v-model="password" type="password" required autocomplete="current-password"
      /></label>
      <button type="submit" class="prototype-button prototype-button--primary">
        {{ t('p2p.account.login') }}
      </button>
    </fieldset>
    <p>{{ t('p2p.account.passwordHint') }}</p>
    <p class="p2p-account-switch">
      <span>{{ t('p2p.account.noAccount') }}</span>
      <button
        type="button"
        class="p2p-account-switch-link"
        data-testid="p2p-account-switch-register"
        @click="switchMode('register')"
      >
        {{ t('p2p.account.register') }}
      </button>
    </p>
  </form>
  <form v-else data-testid="p2p-register-form" @submit.prevent="submitRegister">
    <fieldset :disabled="fieldsDisabled" class="p2p-account-fields p2p-account-fields--stacked">
      <legend>{{ t('p2p.account.register') }}</legend>
      <label
        ><span>{{ t('p2p.account.email') }}</span
        ><input
          :id="serviceId ? `p2p-register-email-${serviceId}` : undefined"
          v-model="registerEmail"
          type="email"
          required
          autocomplete="email"
          spellcheck="false"
          data-testid="p2p-register-email"
      /></label>
      <label
        ><span>{{ t('p2p.account.password') }}</span
        ><input
          v-model="registerPassword"
          type="password"
          required
          autocomplete="new-password"
          :minlength="P2P_ACCOUNT_PASSWORD_MIN"
          :aria-describedby="serviceId ? `p2p-password-rule-${serviceId}` : undefined"
          data-testid="p2p-register-password"
      /></label>
      <p :id="serviceId ? `p2p-password-rule-${serviceId}` : undefined" class="p2p-account-rule">
        {{ t('p2p.account.passwordRule') }}
      </p>
      <p
        v-if="registerTooShort"
        class="remote-error"
        role="alert"
        data-testid="p2p-register-too-short"
      >
        {{ t('p2p.account.passwordTooShort') }}
      </p>
      <label
        ><span>{{ t('p2p.account.confirmPassword') }}</span
        ><input
          v-model="registerConfirm"
          type="password"
          autocomplete="new-password"
          data-testid="p2p-register-confirm"
      /></label>
      <button
        type="submit"
        class="prototype-button prototype-button--primary"
        :disabled="registerBlocked"
      >
        {{ t('p2p.account.register') }}
      </button>
    </fieldset>
    <p>{{ t('p2p.account.registerHint') }}</p>
    <p class="p2p-account-switch">
      <span>{{ t('p2p.account.haveAccount') }}</span>
      <button
        type="button"
        class="p2p-account-switch-link"
        data-testid="p2p-account-switch-login"
        @click="switchMode('login')"
      >
        {{ t('p2p.account.login') }}
      </button>
    </p>
  </form>
</template>

<style scoped>
/* The forms own their look: a component's scoped styles do not reach into it, so
 * the stacked field layout, the password rule and the switch line live here. */
.p2p-account-fields {
  display: grid;
  gap: 0.5rem;
  border: 0;
  margin: 0;
  padding: 0;
}
.p2p-account-fields label {
  display: grid;
  gap: 0.25rem;
  font-size: 0.8125rem;
}
.p2p-account-fields--stacked {
  display: grid;
  gap: 0.5rem;
}
.p2p-account-fields--stacked label {
  grid-template-columns: 1fr;
}
.p2p-account-fields--stacked button {
  justify-self: start;
}
.p2p-account-fields input {
  font: inherit;
  color: inherit;
  background: var(--surface-sunken, #0f141b);
  border: 1px solid var(--border-muted, #2a3542);
  border-radius: 0.375rem;
  padding: 0.4rem 0.55rem;
}
.p2p-account-rule {
  margin: 0;
  font-size: 0.75rem;
  opacity: 0.75;
}
.p2p-account-switch {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0.75rem 0 0;
  font-size: 0.8125rem;
}
.p2p-account-switch-link {
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
  padding: 0;
}
.p2p-account-switch-link:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
</style>
