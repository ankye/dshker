<script setup lang="ts">
import { computed } from 'vue'
import { ManagedWorkspacesPanel } from '../domains/managed-workspaces'
import { APPLICATION_ROUTES } from '../shared/navigation/routes'
import ControllerPanel from './components/ControllerPanel.vue'
import LaunchPanel from './components/LaunchPanel.vue'
import RouteStage from './components/RouteStage.vue'
import RuntimeTabsPanel from './components/RuntimeTabsPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ShellSidebar, { type NavigationItem } from './components/ShellSidebar.vue'
import ShellStatusbar from './components/ShellStatusbar.vue'
import ShellTopbar from './components/ShellTopbar.vue'
import VersionManagementPanel from './components/VersionManagementPanel.vue'
import { useLauncherShell } from './useLauncherShell'

const shell = useLauncherShell()

const applicationItems = computed<readonly NavigationItem[]>(() =>
  APPLICATION_ROUTES.map((route) => ({
    id: route.id,
    label: shell.t(route.labelKey)
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
    />
  </div>
</template>
