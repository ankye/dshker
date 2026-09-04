<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useLauncherHarness, usePluginCatalog } from '../domains/launcher-harness'
import { APPLICATION_ROUTES } from '../shared/navigation/routes'
import ConsoleDrawer from './components/ConsoleDrawer.vue'
import ControllerPanel from './components/ControllerPanel.vue'
import ControllerPrimaryAction from './components/ControllerPrimaryAction.vue'
import UsagePanel from './components/UsagePanel.vue'
import LaunchPanel from './components/LaunchPanel.vue'
import LaunchPrimaryAction from './components/LaunchPrimaryAction.vue'
import RouteStage from './components/RouteStage.vue'
import RuntimeTabsPanel from './components/RuntimeTabsPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ShellSidebar, { type NavigationItem } from './components/ShellSidebar.vue'
import ShellStatusbar from './components/ShellStatusbar.vue'
import ShellToast from './components/ShellToast.vue'
import VersionManagementPanel from './components/VersionManagementPanel.vue'
import { startLocale } from '../shared/i18n/useLocale'
import { startTheme } from '../shared/theme/useTheme'
import { useConsoleDrawer } from './consoleDrawerState'
import { useLauncherShell } from './useLauncherShell'

// Applies the persisted theme on the first frame of any route and keeps a
// `system` selection following the OS while the window stays open.
startTheme()
// Publishes the persisted language to the document element.
startLocale()

// The console tail is a session surface; startup history is not "unread".
const consoleDrawer = useConsoleDrawer()
onMounted(() => {
  consoleDrawer.markConsoleSeen()
})

const shell = useLauncherShell()
const harness = useLauncherHarness()
const pluginCatalog = usePluginCatalog()

const statusbarBaseLabel = computed(() => {
  const operation = harness.activeOperation.value
  if (operation !== undefined) {
    switch (operation) {
      case 'switch':
        return shell.t('status.operation.switch')
      case 'update':
        return shell.t('status.operation.update')
      case 'start':
        return shell.t('status.operation.start')
      case 'stop':
        return shell.t('status.operation.stop')
      case 'refresh':
        return shell.t('status.operation.refreshVersions')
      case 'installPlugin':
        return shell.t('status.operation.installPlugin')
      case 'installPluginArchive':
        return shell.t('status.operation.installPluginArchive')
      case 'refreshPlugins':
        return shell.t('status.operation.refreshPlugins')
      case 'updatePlugin':
        return shell.t('status.operation.updatePlugin')
      case 'adoptPlugin':
        return shell.t('status.operation.adoptPlugin')
      case 'uninstallPlugin':
        return shell.t('status.operation.uninstallPlugin')
    }
  }
  if (pluginCatalog.loading.value) return shell.t('status.operation.refreshCatalog')
  return undefined
})

/** Filled fraction for the statusbar bar; only step-reporting operations have one. */
const statusbarProgressRatio = computed(() => {
  const progress = harness.operationProgress.value
  if (progress === undefined) return undefined
  return Math.min(1, progress.stepPosition / progress.totalSteps)
})

const statusbarOperationLabel = computed(() => {
  const base = statusbarBaseLabel.value
  const progress = harness.operationProgress.value
  if (base === undefined || progress === undefined) return base
  // Numbers only: the appended position stays meaningful in either language.
  return `${base} · ${shell.t('status.progress.step')} ${progress.stepPosition}/${progress.totalSteps} · ${progress.elapsedSeconds}s`
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

/** The tail's link hands over to the full Console route and collapses itself. */
function openConsoleRoute(): void {
  consoleDrawer.closeConsoleDrawer()
  shell.selectRoute('controller')
}
</script>

<template>
  <div class="app-shell">
    <div class="shell-body" :data-sidebar-state="shell.sidebarState.value">
      <ShellSidebar
        :title="shell.t('app.title')"
        :items="applicationItems"
        :active-route="shell.activeRoute.value"
        :state="shell.sidebarState.value"
        :collapse-label="shell.t('nav.collapse')"
        :hide-label="shell.t('nav.hide')"
        :expand-label="shell.t('nav.expand')"
        :console-label="shell.t('nav.console')"
        :console-unread-label="shell.t('nav.consoleUnread')"
        :console-open="consoleDrawer.open.value"
        :console-unread="consoleDrawer.unread.value"
        @select="shell.selectRoute"
        @advance="shell.advanceSidebar"
        @toggle-console="consoleDrawer.toggleConsoleDrawer"
      />

      <main class="workbench-stage">
        <RouteStage
          v-if="shell.activeRoute.value === 'launch'"
          :title="shell.t('launch.title')"
          :description="shell.t('launch.description')"
          :status="shell.bootstrapStatus.value"
          :status-kind="statusKind"
          :header-visible="false"
          :footer-visible="harness.state.value?.kind === 'ready'"
        >
          <LaunchPanel @navigate="shell.selectRoute" />
          <template #footer>
            <LaunchPrimaryAction />
          </template>
        </RouteStage>

        <RouteStage
          v-else-if="shell.activeRoute.value === 'versions'"
          :title="shell.t('versions.title')"
          :description="shell.t('versions.description')"
          :status="shell.bootstrapStatus.value"
          :status-kind="statusKind"
        >
          <VersionManagementPanel />
        </RouteStage>

        <RouteStage
          v-else-if="shell.activeRoute.value === 'controller'"
          :title="shell.t('controller.title')"
          :description="shell.t('controller.description')"
          :status="shell.bootstrapStatus.value"
          :status-kind="statusKind"
          :footer-visible="harness.state.value?.kind === 'ready'"
        >
          <ControllerPanel @navigate="shell.selectRoute" />
          <template #footer>
            <ControllerPrimaryAction />
          </template>
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
        <ConsoleDrawer @navigate="openConsoleRoute" />
      </main>
    </div>

    <ShellStatusbar
      :protocol-label="shell.t('footer.protocol')"
      :protocol-version="protocolVersion"
      :scope-label="shell.t('footer.scope')"
      :scope-value="shell.t('footer.scopeValue')"
      :operation-label="statusbarOperationLabel"
      :operation-progress="statusbarProgressRatio"
      @progress-toggle="consoleDrawer.toggleConsoleDrawer"
    />
  </div>
</template>
