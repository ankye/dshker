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
}>()

const emit = defineEmits<{
  select: [route: AppRouteId]
}>()
</script>

<template>
  <div class="sidebar-region">
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
    <!--
      No floating control rail lives here: the sidebar state control and the
      console tail control both belong to the status bar, so a hidden sidebar
      leaves the route plane and the Run guest's own footer completely free.
    -->
  </div>
</template>
