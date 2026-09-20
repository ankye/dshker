<script setup lang="ts">
import type { SidebarState } from '../useLauncherShell'

defineProps<{
  readonly protocolLabel: string
  readonly protocolVersion: string
  readonly scopeLabel: string
  readonly scopeValue: string
  readonly operationLabel?: string
  /**
   * Filled fraction (0–1) when the operation reports real step progress.
   *
   * Undefined keeps the indeterminate slide. A determinate fill is the only
   * progress presentation that still moves when the OS reduces motion.
   */
  readonly operationProgress?: number
  /**
   * The coordinator session for the selected service.
   *
   * Shown here because network reach decides whether any remote workbench can
   * be opened, which is not a fact that belongs to one route. `unknown` keeps an
   * unread session distinct from a confirmed offline state.
   */
  readonly networkLabel: string
  readonly networkValue: string
  readonly networkState: 'online' | 'offline' | 'unknown'
  /**
   * Shell chrome moved off the sidebar's floating rail and into this bar, so the
   * route plane and the Run guest are never overlaid by Launcher controls. The
   * bar already spans every route, which makes it the one home both controls can
   * share without a hidden-state clearance offset.
   */
  readonly sidebarState: SidebarState
  readonly collapseLabel: string
  readonly hideLabel: string
  readonly expandLabel: string
  readonly consoleLabel: string
  readonly consoleUnreadLabel: string
  readonly consoleOpen: boolean
  readonly consoleUnread: boolean
}>()

const emit = defineEmits<{
  progressToggle: []
  advanceSidebar: []
  toggleConsole: []
}>()
</script>

<template>
  <footer class="statusbar" :data-busy="operationLabel !== undefined">
    <!--
      The control group leads the bar so the read-only protocol, scope, and
      network facts stay on the trailing side. It is outside the busy branch
      below: a running operation must not take the sidebar or console control
      away from the user.
    -->
    <div class="statusbar-controls">
      <button
        class="statusbar-control statusbar-sidebar-toggle"
        type="button"
        :aria-label="
          sidebarState === 'expanded'
            ? collapseLabel
            : sidebarState === 'collapsed'
              ? hideLabel
              : expandLabel
        "
        :title="
          sidebarState === 'expanded'
            ? collapseLabel
            : sidebarState === 'collapsed'
              ? hideLabel
              : expandLabel
        "
        @click="emit('advanceSidebar')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <template v-if="sidebarState === 'expanded'">
            <rect x="3.5" y="4" width="17" height="16" rx="2" />
            <path d="M9 4v16m6 5-3-3 3-3" />
          </template>
          <template v-else-if="sidebarState === 'collapsed'">
            <rect x="3.5" y="4" width="17" height="16" rx="2" />
            <path d="m11 9-3 3 3 3" />
          </template>
          <path v-else d="m9 5 7 7-7 7" />
        </svg>
      </button>
      <button
        class="statusbar-control statusbar-console-toggle"
        type="button"
        :aria-expanded="consoleOpen"
        :aria-label="consoleUnread ? `${consoleLabel} · ${consoleUnreadLabel}` : consoleLabel"
        :title="consoleUnread ? `${consoleLabel} · ${consoleUnreadLabel}` : consoleLabel"
        @click="emit('toggleConsole')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="m5 7 4 4-4 4" />
          <path d="M12 17h7" />
        </svg>
        <span v-if="consoleUnread" class="statusbar-console-badge" aria-hidden="true" />
      </button>
    </div>
    <!--
      The busy strip is also the console tail's second entry point: it already
      narrates the running operation, so activating it reveals the live output.
      It is a real button with a live text region inside, never both on one
      element.
    -->
    <button
      v-if="operationLabel"
      class="statusbar-progress"
      type="button"
      :aria-label="operationLabel"
      @click="emit('progressToggle')"
    >
      <span class="statusbar-progress-track" aria-hidden="true">
        <span
          class="statusbar-progress-bar"
          :data-determinate="operationProgress !== undefined"
          :style="
            operationProgress === undefined
              ? undefined
              : { width: `${Math.round(Math.min(1, Math.max(0, operationProgress)) * 100)}%` }
          "
        />
      </span>
      <span class="statusbar-progress-text" role="status" aria-live="polite">{{
        operationLabel
      }}</span>
    </button>
    <template v-else>
      <span>{{ protocolLabel }} · {{ protocolVersion }}</span>
      <span>{{ scopeLabel }} · {{ scopeValue }}</span>
      <span class="statusbar-network" :data-state="networkState" role="status">
        {{ networkLabel }} · {{ networkValue }}
      </span>
    </template>
  </footer>
</template>
