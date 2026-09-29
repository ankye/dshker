<script setup lang="ts">
import type { SidebarState } from '../useLauncherShell'

defineProps<{
  readonly launcherVersionLabel: string
  readonly launcherVersion: string
  readonly dshVersionLabel: string
  readonly dshVersion: string
  readonly dshVersionTitle: string
  readonly runtimeLabel: string
  readonly runtimeValue: string
  readonly runtimeState: 'running' | 'starting' | 'stopped' | 'failed' | 'unknown'
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
  readonly menuLabel: string
  readonly consoleLabel: string
  readonly consoleControlLabel: string
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
      The control group leads the bar. Version and live-state facts stay visible
      at the trailing edge even while an operation is in progress; progress uses
      only the space between those two stable groups.
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
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          data-icon="menu"
          aria-hidden="true"
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
        <span class="statusbar-control-label" aria-hidden="true">{{ menuLabel }}</span>
      </button>
      <button
        class="statusbar-control statusbar-console-toggle"
        type="button"
        :aria-expanded="consoleOpen"
        :aria-label="consoleUnread ? `${consoleLabel} · ${consoleUnreadLabel}` : consoleLabel"
        :title="consoleUnread ? `${consoleLabel} · ${consoleUnreadLabel}` : consoleLabel"
        @click="emit('toggleConsole')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          data-icon="command-line"
          aria-hidden="true"
        >
          <path d="m5 7 4 4-4 4" />
          <path d="M12 17h7" />
        </svg>
        <span class="statusbar-control-label" aria-hidden="true">{{ consoleControlLabel }}</span>
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
    <div class="statusbar-facts">
      <span
        class="statusbar-fact"
        :aria-label="`${launcherVersionLabel}: ${launcherVersion}`"
        :title="`${launcherVersionLabel}: ${launcherVersion}`"
      >
        <span class="statusbar-fact-label">{{ launcherVersionLabel }}</span>
        <span class="statusbar-fact-value">{{ launcherVersion }}</span>
      </span>
      <span
        class="statusbar-fact"
        :aria-label="`${dshVersionLabel}: ${dshVersionTitle}`"
        :title="`${dshVersionLabel}: ${dshVersionTitle}`"
      >
        <span class="statusbar-fact-label">{{ dshVersionLabel }}</span>
        <span class="statusbar-fact-value">{{ dshVersion }}</span>
      </span>
      <span
        class="statusbar-fact"
        :data-state="runtimeState"
        role="status"
        :aria-label="`${runtimeLabel}: ${runtimeValue}`"
        :title="`${runtimeLabel}: ${runtimeValue}`"
      >
        <span class="statusbar-fact-label">{{ runtimeLabel }}</span>
        <span class="statusbar-fact-value">{{ runtimeValue }}</span>
      </span>
      <span
        class="statusbar-fact statusbar-network"
        :data-state="networkState"
        role="status"
        :aria-label="`${networkLabel}: ${networkValue}`"
        :title="`${networkLabel}: ${networkValue}`"
      >
        <span class="statusbar-fact-label">{{ networkLabel }}</span>
        <span class="statusbar-fact-value">{{ networkValue }}</span>
      </span>
    </div>
  </footer>
</template>
