<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useLauncherHarness, usePluginCatalog } from '../domains/launcher-harness'
import { ManagedWorkspacesPanel } from '../domains/managed-workspaces'
import { APPLICATION_ROUTES } from '../shared/navigation/routes'
import ControllerPanel from './components/ControllerPanel.vue'
import UsagePanel from './components/UsagePanel.vue'
import LaunchPanel from './components/LaunchPanel.vue'
import RouteStage from './components/RouteStage.vue'
import RuntimeTabsPanel from './components/RuntimeTabsPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ShellSidebar, { type NavigationItem } from './components/ShellSidebar.vue'
import ShellStatusbar from './components/ShellStatusbar.vue'
import ShellToast from './components/ShellToast.vue'
import VersionManagementPanel from './components/VersionManagementPanel.vue'
import VersionStageActions from './components/VersionStageActions.vue'
import { startLocale } from '../shared/i18n/useLocale'
import { startTheme } from '../shared/theme/useTheme'
import { useLauncherShell } from './useLauncherShell'

// Applies the persisted theme on the first frame of any route and keeps a
// `system` selection following the OS while the window stays open.
startTheme()
// Publishes the persisted language to the document element.
startLocale()

const shell = useLauncherShell()
const harness = useLauncherHarness()
const pluginCatalog = usePluginCatalog()

const statusbarOperationLabel = computed(() => {
  const operation = harness.activeOperation.value
  if (operation === undefined || operation === 'refresh') return undefined
  switch (operation) {
    case 'switch':
      return shell.t('status.operation.switch')
    case 'update':
      return shell.t('status.operation.update')
    case 'start':
      return shell.t('status.operation.start')
    case 'stop':
      return shell.t('status.operation.stop')
    case 'installPlugin':
      return shell.t('status.operation.installPlugin')
    case 'uninstallPlugin':
      return shell.t('status.operation.uninstallPlugin')
  }
})

const TOAST_ERROR_MESSAGE_KEYS: Readonly<Record<string, Parameters<typeof shell.t>[0]>> = {
  bridge: 'toast.error.bridge',
  'managed.harness_launch_failed': 'toast.error.harnessLaunchFailed',
  'managed.harness_launch_in_progress': 'toast.error.harnessLaunchInProgress',
  'managed.harness_busy_running': 'toast.error.harnessBusyRunning',
  'managed.harness_worktree_invalid': 'toast.error.harnessWorktreeInvalid',
  'managed.harness_input_invalid': 'toast.error.harnessInputInvalid',
  'managed.harness_plugin_operation_failed': 'toast.error.harnessPluginOperationFailed',
  'managed.git_operation_failed': 'toast.error.gitOperationFailed'
}

/** Consequence and next step per code; the raw code stays available separately. */
const TOAST_ERROR_DETAIL_KEYS: Readonly<Record<string, Parameters<typeof shell.t>[0]>> = {
  bridge: 'toast.error.detail.bridge',
  'managed.harness_launch_failed': 'toast.error.detail.harnessLaunchFailed',
  'managed.harness_launch_in_progress': 'toast.error.detail.harnessLaunchInProgress',
  'managed.harness_busy_running': 'toast.error.detail.harnessBusyRunning',
  'managed.harness_worktree_invalid': 'toast.error.detail.harnessWorktreeInvalid',
  'managed.harness_input_invalid': 'toast.error.detail.harnessInputInvalid',
  'managed.harness_plugin_operation_failed': 'toast.error.detail.harnessPluginOperationFailed',
  'managed.git_operation_failed': 'toast.error.detail.gitOperationFailed'
}

const TOAST_VISIBLE_MILLISECONDS = 8_000
const toast = ref<Readonly<{ title: string; detail: string; code: string }>>()
let toastTimer: ReturnType<typeof setTimeout> | undefined

function dismissToast(): void {
  toast.value = undefined
  if (toastTimer !== undefined) clearTimeout(toastTimer)
}

watch(
  () => [harness.error.value, pluginCatalog.error.value] as const,
  ([harnessError, catalogError]) => {
    const code = harnessError ?? catalogError
    if (code === undefined) return
    const messageKey = TOAST_ERROR_MESSAGE_KEYS[code] ?? 'toast.error.title'
    const detailKey = TOAST_ERROR_DETAIL_KEYS[code] ?? 'toast.error.detail.unknown'
    toast.value = { title: shell.t(messageKey), detail: shell.t(detailKey), code }
    if (toastTimer !== undefined) clearTimeout(toastTimer)
    toastTimer = setTimeout(dismissToast, TOAST_VISIBLE_MILLISECONDS)
  }
)

// Launching moves the user to the console, because the outcome of a launch —
// especially a failure — is only visible in that output. Watching the attempt
// counter rather than the launch state means a start that fails immediately
// still navigates, and a process that stops later does not.
watch(
  () => harness.launchAttempts.value,
  (attempts, previous) => {
    if (attempts > (previous ?? 0)) shell.selectRoute('controller')
  }
)

onUnmounted(() => {
  if (toastTimer !== undefined) clearTimeout(toastTimer)
})

const applicationItems = computed<readonly NavigationItem[]>(() =>
  APPLICATION_ROUTES.map((route) => ({
    id: route.id,
    label: shell.t(route.labelKey),
    icon: route.icon
  }))
)
const statusKind = computed(() => shell.bootstrap.value.kind)
const protocolVersion = computed(() =>
  shell.bootstrap.value.kind === 'ready'
    ? String(shell.bootstrap.value.info.apiVersion)
    : 'unavailable'
)
</script>

<template>
  <div class="app-shell">
    <div class="shell-body" :data-sidebar-collapsed="shell.sidebarCollapsed.value">
      <ShellSidebar
        :title="shell.t('app.title')"
        :items="applicationItems"
        :active-route="shell.activeRoute.value"
        :collapsed="shell.sidebarCollapsed.value"
        :collapse-label="shell.t('nav.collapse')"
        :expand-label="shell.t('nav.expand')"
        @select="shell.selectRoute"
        @toggle="shell.toggleSidebar"
      />

      <main class="workbench-stage">
        <RouteStage
          v-if="shell.activeRoute.value === 'launch'"
          :title="shell.t('launch.title')"
          :description="shell.t('launch.description')"
          :status="shell.bootstrapStatus.value"
          :status-kind="statusKind"
        >
          <LaunchPanel @navigate="shell.selectRoute" />
        </RouteStage>

        <RouteStage
          v-else-if="shell.activeRoute.value === 'advanced'"
          :title="shell.t('advanced.title')"
          :description="shell.t('advanced.description')"
          :status="shell.bootstrapStatus.value"
          :status-kind="statusKind"
        >
          <ManagedWorkspacesPanel :show-installations="false" />
        </RouteStage>

        <RouteStage
          v-else-if="shell.activeRoute.value === 'versions'"
          :title="shell.t('versions.title')"
          :description="shell.t('versions.description')"
          :status="shell.bootstrapStatus.value"
          :status-kind="statusKind"
        >
          <template #actions>
            <VersionStageActions />
          </template>
          <VersionManagementPanel />
        </RouteStage>

        <RouteStage
          v-else-if="shell.activeRoute.value === 'controller'"
          :title="shell.t('controller.title')"
          :description="shell.t('controller.description')"
          :status="shell.bootstrapStatus.value"
          :status-kind="statusKind"
        >
          <ControllerPanel @navigate="shell.selectRoute" />
        </RouteStage>

        <RouteStage
          v-else-if="shell.activeRoute.value === 'usage'"
          :title="shell.t('usage.title')"
          :description="shell.t('usage.description')"
          :status="shell.bootstrapStatus.value"
          :status-kind="statusKind"
        >
          <UsagePanel />
        </RouteStage>

        <RouteStage
          v-else-if="shell.activeRoute.value === 'settings'"
          :title="shell.t('settings.title')"
          :description="shell.t('settings.description')"
          :status="shell.bootstrapStatus.value"
          :status-kind="statusKind"
        >
          <SettingsPanel />
        </RouteStage>

        <!-- The run route is a plain browser surface: it carries its own tab
             strip and address bar, so no stage title competes for its height. -->
        <section v-else class="runtime-route">
          <RuntimeTabsPanel @navigate="shell.selectRoute" />
        </section>
        <ShellToast
          v-if="toast"
          :title="toast.title"
          :detail="toast.detail"
          :code="toast.code"
          :code-label="shell.t('toast.error.code')"
          :dismiss-label="shell.t('toast.dismiss')"
          @dismiss="dismissToast"
        />
      </main>
    </div>

    <ShellStatusbar
      :protocol-label="shell.t('footer.protocol')"
      :protocol-version="protocolVersion"
      :scope-label="shell.t('footer.scope')"
      :scope-value="shell.t('footer.scopeValue')"
      :operation-label="statusbarOperationLabel"
    />
  </div>
</template>
