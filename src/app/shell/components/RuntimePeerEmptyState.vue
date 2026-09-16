<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { p2pConnections as connections } from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import { refusalKeyForCode } from '@/app/shared/i18n/i18n.refusals'
import type { RuntimeTabStatus } from '../runtimeBrowserState'
import EmptyState from './EmptyState.vue'
import P2PRunActions from './P2PRunActions.vue'

/**
 * What a peer tab says while it has no workbench to show.
 *
 * A paired computer is not an SSH remote, so the SSH copy ("retry this computer's
 * SSH tunnel") was wrong on both counts: there is no tunnel, and the reason is
 * usually a stage the user can act on. A failure names the category — this computer
 * is not set up, the coordinator cannot be reached, the peer is offline, the two
 * networks cannot reach each other, the workbench did not start, or the
 * authorization is gone — instead of leaving the user with a red dot.
 */
const props = defineProps<{
  status: RuntimeTabStatus | undefined
  connectionId: string | undefined
}>()
const emit = defineEmits<{ edit: [] }>()
const t = useTranslator()

const failureCode = computed(() =>
  props.status?.kind === 'failed' ? props.status.code : undefined
)
const title = computed(() =>
  failureCode.value === undefined
    ? t('runtime.peerUnavailable')
    : t('runtime.peerUnavailable.failed')
)
const description = computed(() =>
  failureCode.value === undefined
    ? t('runtime.peerUnavailable.description')
    : t(refusalKeyForCode(failureCode.value))
)

/**
 * Reads the connection stages on arrival.
 *
 * The Run page is where the connect action lives, and the stages it acts on were
 * only ever read on the Remote connections page. A refused attempt therefore left
 * this page holding an unresolved outcome that blocked every later attempt, with
 * no way to recover short of visiting another page: reading here is what resolves
 * it, because a read is always allowed.
 */
onMounted(() => void connections.read())
</script>

<template>
  <EmptyState icon="plug" fill :title="title" :description="description">
    <!-- A failure says which side is the problem, and keeps the code on screen:
         a refusal the user cannot read is a refusal they cannot report. -->
    <p v-if="failureCode" class="peer-failure-code" data-testid="peer-failure-code">
      {{ t('runtime.peerUnavailable.code') }} <code>{{ failureCode }}</code>
    </p>
    <template #actions>
      <P2PRunActions v-if="connectionId" :connection-id="connectionId" @edit="emit('edit')" />
    </template>
  </EmptyState>
</template>
