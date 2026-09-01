<script setup lang="ts">
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
  readonly collapsed: boolean
  readonly title: string
  readonly collapseLabel: string
  readonly expandLabel: string
}>()

const emit = defineEmits<{
  select: [route: AppRouteId]
  toggle: []
}>()
</script>

<template>
  <aside class="sidebar" :data-collapsed="collapsed" aria-label="Launcher navigation">
    <div class="sidebar-heading">
      <p class="nav-group-label">{{ collapsed ? '' : title }}</p>
      <button
        class="sidebar-toggle"
        type="button"
        :aria-label="collapsed ? expandLabel : collapseLabel"
        @click="emit('toggle')"
      >
        <span aria-hidden="true">{{ collapsed ? '›' : '‹' }}</span>
      </button>
    </div>
    <nav class="nav-list" aria-label="Application">
      <button
        v-for="item in items"
        :key="item.id"
        class="nav-item"
        :aria-current="activeRoute === item.id ? 'page' : undefined"
        :data-active="activeRoute === item.id"
        :data-testid="`nav-${item.id}`"
        type="button"
        @click="emit('select', item.id)"
      >
        <RouteIcon :icon="item.icon" />
        <span class="nav-item-label">{{ item.label }}</span>
      </button>
    </nav>
  </aside>
</template>
