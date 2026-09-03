<script setup lang="ts">
import launcherLogo from '../../../../resources/dsh-launcher-logo-launcher.png'
import type { SidebarState } from '../useLauncherShell'
import type { AppRouteId, NavIconId } from '../../shared/navigation/routes'
import RouteIcon from './RouteIcon.vue'

export interface NavigationItem {
  readonly id: AppRouteId
  readonly label: string
  readonly icon: NavIconId
}

defineProps<{
  readonly items: readonly NavigationItem[]
  readonly activeRoute: AppRouteId
  readonly state: SidebarState
  readonly title: string
  readonly collapseLabel: string
  readonly hideLabel: string
  readonly expandLabel: string
}>()

const emit = defineEmits<{
  select: [route: AppRouteId]
  advance: []
}>()
</script>

<template>
  <div class="sidebar-region" :data-state="state">
    <aside
      v-if="state !== 'hidden'"
      class="sidebar"
      :data-collapsed="state === 'collapsed'"
      aria-label="Launcher navigation"
    >
      <div class="sidebar-main">
        <div class="sidebar-heading">
          <!--
            The product identity lives here rather than in a full-width bar, so the
            whole area right of the navigation belongs to the active route.
          -->
          <p class="sidebar-brand" :title="title">
            <span class="sidebar-brand-mark" aria-hidden="true">
              <img :src="launcherLogo" alt="" />
            </span>
            <span v-if="state === 'expanded'" class="sidebar-brand-text">{{ title }}</span>
          </p>
        </div>
        <nav class="nav-list" aria-label="Application">
          <button
            v-for="item in items"
            :key="item.id"
            class="nav-item"
            :aria-current="activeRoute === item.id ? 'page' : undefined"
            :aria-label="state === 'collapsed' ? item.label : undefined"
            :data-active="activeRoute === item.id"
            :data-testid="`nav-${item.id}`"
            :title="state === 'collapsed' ? item.label : undefined"
            type="button"
            @click="emit('select', item.id)"
          >
            <RouteIcon :icon="item.icon" />
            <span class="nav-item-label">{{ item.label }}</span>
          </button>
        </nav>
      </div>
    </aside>
    <button
      class="sidebar-toggle"
      type="button"
      :aria-label="
        state === 'expanded' ? collapseLabel : state === 'collapsed' ? hideLabel : expandLabel
      "
      :title="
        state === 'expanded' ? collapseLabel : state === 'collapsed' ? hideLabel : expandLabel
      "
      @click="emit('advance')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <template v-if="state === 'expanded'">
          <rect x="3.5" y="4" width="17" height="16" rx="2" />
          <path d="M9 4v16m6 5-3-3 3-3" />
        </template>
        <template v-else-if="state === 'collapsed'">
          <rect x="3.5" y="4" width="17" height="16" rx="2" />
          <path d="m11 9-3 3 3 3" />
        </template>
        <path v-else d="m9 5 7 7-7 7" />
      </svg>
    </button>
  </div>
</template>
