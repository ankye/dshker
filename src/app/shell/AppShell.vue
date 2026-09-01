<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useLauncherHarness, usePluginCatalog } from '../domains/launcher-harness'
import { ManagedWorkspacesPanel } from '../domains/managed-workspaces'
import { APPLICATION_ROUTES } from '../shared/navigation/routes'
import ControllerPanel from './components/ControllerPanel.vue'
import LaunchPanel from './components/LaunchPanel.vue'
import RouteStage from './components/RouteStage.vue'
import RuntimeTabsPanel from './components/RuntimeTabsPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ShellSidebar, { type NavigationItem } from './components/ShellSidebar.vue'
import ShellStatusbar from './components/ShellStatusbar.vue'
import ShellToast from './components/ShellToast.vue'
import ShellTopbar from './components/ShellTopbar.vue'
import VersionManagementPanel from './components/VersionManagementPanel.vue'
import VersionStageActions from './components/VersionStageActions.vue'
import { useLauncherShell } from './useLauncherShell'

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
  'managed.git_operation_failed': 'toast.error.gitOperationFailed'
}

const TOAST_VISIBLE_MILLISECONDS = 8_000
const toast = ref<Readonly<{ title: string; detail: string }>>()
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
    toast.value = { title: shell.t(messageKey), detail: code }
    if (toastTimer !== undefined) clearTimeout(toastTimer)
    toastTimer = setTimeout(dismissToast, TOAST_VISIBLE_MILLISECONDS)
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
    <ShellTopbar
      :kicker="shell.t('app.kicker')"
      :title="shell.t('app.title')"
      :subtitle="shell.t('app.subtitle')"
      :status="shell.bootstrapStatus.value"
      :status-kind="statusKind"
    />

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
        >
          <LaunchPanel />
        </RouteStage>

        <RouteStage
          v-else-if="shell.activeRoute.value === 'advanced'"
          :title="shell.t('advanced.title')"
          :description="shell.t('advanced.description')"
        >
          <ManagedWorkspacesPanel :show-installations="false" />
        </RouteStage>

        <RouteStage
          v-else-if="shell.activeRoute.value === 'versions'"
          :title="shell.t('versions.title')"
          :description="shell.t('versions.description')"
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
        >
          <ControllerPanel />
        </RouteStage>

        <RouteStage
          v-else-if="shell.activeRoute.value === 'settings'"
          :title="shell.t('settings.title')"
          :description="shell.t('settings.description')"
        >
          <SettingsPanel />
        </RouteStage>

        <RouteStage
          v-else
          :title="shell.t('runtime.title')"
          :description="shell.t('runtime.description')"
        >
          <RuntimeTabsPanel />
        </RouteStage>
      </main>
    </div>

    <ShellStatusbar
      :protocol-label="shell.t('footer.protocol')"
      :protocol-version="protocolVersion"
      :scope-label="shell.t('footer.scope')"
      :scope-value="shell.t('footer.scopeValue')"
      :operation-label="statusbarOperationLabel"
    />

    <ShellToast
      v-if="toast"
      :title="toast.title"
      :detail="toast.detail"
      :dismiss-label="shell.t('toast.dismiss')"
      @dismiss="dismissToast"
    />
  </div>
</template>
