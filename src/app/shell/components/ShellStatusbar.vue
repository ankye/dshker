<script setup lang="ts">
defineProps<{
  readonly protocolLabel: string
  readonly protocolVersion: string
  readonly scopeLabel: string
  readonly scopeValue: string
}>()
</script>

<template>
  <footer class="statusbar">
    <span>{{ protocolLabel }} · {{ protocolVersion }}</span>
    <span>{{ scopeLabel }} · {{ scopeValue }}</span>
  </footer>
</template>
