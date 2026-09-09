<script setup lang="ts">
import { computed } from 'vue'
import type { P2PNetworkDeviceView } from '@/shared/p2p-management'
import { useTranslator } from '@/app/shared/i18n/useLocale'

/**
 * Device directory of one network.
 *
 * Presentation only: it reads what the owner already fetched and never triggers
 * its own network access, so the panel that owns the read also owns the timing.
 *
 * Every value here except presence is descriptive and self-declared by each
 * device. An unreported build shows as unknown rather than being hidden, because
 * "this device has not told us" is itself worth seeing.
 */
const props = defineProps<{
  devices: readonly P2PNetworkDeviceView[] | undefined
  maxDevices: number
  failed: boolean
  loading: boolean
  /** Unix seconds; injected so the relative time is testable without fake timers. */
  now: number
}>()

const t = useTranslator()

const rows = computed(() => props.devices ?? [])
/** The local device sorts first, then online before offline, then by name. */
const ordered = computed(() =>
  [...rows.value].sort((left, right) => {
    if (left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1
    if (left.presence !== right.presence) return left.presence === 'online' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
)

/**
 * Relative last-seen, rounded down to the coarsest useful unit.
 *
 * The coordinator persists this at most once a minute, so second-level precision
 * would be a lie. A zero timestamp means the device has never reported at all,
 * which is different from having reported a long time ago.
 */
function lastSeen(device: P2PNetworkDeviceView): string {
  if (device.lastSeen <= 0) return t('p2p.devices.lastSeenNever')
  const seconds = Math.max(0, props.now - device.lastSeen)
  if (seconds < 60) return t('p2p.devices.lastSeenJustNow')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} ${t('p2p.devices.lastSeenMinutesSuffix')}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${t('p2p.devices.lastSeenHoursSuffix')}`
  return `${Math.floor(hours / 24)} ${t('p2p.devices.lastSeenDaysSuffix')}`
}

/** Build line: version first, then platform/architecture when reported. */
function build(device: P2PNetworkDeviceView): string {
  const platform = [device.platform, device.architecture].filter(Boolean).join('/')
  if (!device.version && !platform) return t('p2p.devices.buildUnknown')
  return [device.version, platform].filter(Boolean).join(' · ')
}
</script>

<template>
  <section class="p2p-devices" aria-labelledby="p2p-devices-title" data-testid="p2p-devices">
    <header class="p2p-devices__heading">
      <h3 id="p2p-devices-title">{{ t('p2p.devices.title') }}</h3>
      <p class="p2p-devices__summary" data-testid="p2p-devices-summary">
        {{ rows.length }} {{ t('p2p.devices.summaryUnit') }} · {{ t('p2p.devices.summaryLimit') }}
        {{ maxDevices }}
      </p>
    </header>

    <p v-if="failed" role="alert" class="remote-error" data-testid="p2p-devices-error">
      {{ t('p2p.devices.readFailed') }}
    </p>
    <p v-else-if="loading" role="status" data-testid="p2p-devices-loading">
      {{ t('p2p.devices.loading') }}
    </p>
    <p
      v-else-if="devices !== undefined && rows.length === 0"
      class="p2p-devices__empty"
      data-testid="p2p-devices-empty"
    >
      {{ t('p2p.devices.empty') }}
    </p>

    <ul v-else-if="devices !== undefined" class="p2p-devices__list" data-testid="p2p-devices-list">
      <li v-for="device in ordered" :key="device.deviceId" class="p2p-devices__row">
        <span class="p2p-devices__identity">
          <span
            class="p2p-devices__dot"
            :data-state="device.presence"
            :aria-label="
              t(device.presence === 'online' ? 'p2p.myNetwork.online' : 'p2p.myNetwork.offline')
            "
          />
          <span class="p2p-devices__name">{{ device.name }}</span>
          <span v-if="device.isLocal" class="p2p-devices__badge">
            {{ t('p2p.devices.thisDevice') }}
          </span>
        </span>
        <span class="p2p-devices__meta">{{ lastSeen(device) }}</span>
        <span class="p2p-devices__meta p2p-devices__build">{{ build(device) }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.p2p-devices {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
}
.p2p-devices__heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}
.p2p-devices__heading h3 {
  margin: 0;
  font-size: var(--type-section);
  font-weight: var(--font-weight-semibold);
}
.p2p-devices__summary,
.p2p-devices__empty {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}
.p2p-devices__list {
  display: grid;
  gap: 1px;
  margin: 0;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-border);
  list-style: none;
  overflow: hidden;
}
/* One row per device. The name column flexes; the two meta columns stay put so
   values line up vertically and can be compared down the list. */
.p2p-devices__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 8rem) minmax(0, 12rem);
  align-items: center;
  gap: var(--space-3);
  min-height: var(--size-row);
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface);
}
.p2p-devices__identity {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
/* A marker, not a control: it is below the minimum pointer target on purpose. */
.p2p-devices__dot {
  flex: none;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--color-text-muted);
}
.p2p-devices__dot[data-state='online'] {
  background: var(--color-success);
}
.p2p-devices__name {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--type-row);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.p2p-devices__badge {
  flex: none;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
  font-size: var(--type-label);
  line-height: 1.5rem;
}
.p2p-devices__meta {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.p2p-devices__build {
  font-family: var(--font-mono);
}

/* Below this width the three columns stop being comparable, so the row becomes
   a stacked block instead of squeezing the name to nothing. */
@media (width <= 34rem) {
  .p2p-devices__row {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-1);
  }
}
</style>
