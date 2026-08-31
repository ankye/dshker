<script setup lang="ts" generic="TValue extends string | undefined">
/**
 * Themed single-select listbox used in place of the native HTML select element.
 *
 * The workspace design gate forbids that native element because its popup
 * cannot carry the application's dark operational palette. This control keeps
 * the ARIA listbox contract explicit: roving `aria-activedescendant`, Home/End,
 * arrow traversal, Enter/Space commit, and Escape dismissal.
 */
import { computed, nextTick, ref, watch } from 'vue'

/** One selectable row; `value` is the committed payload, `label` is display copy. */
export interface ThemedListboxOption<TOptionValue extends string | undefined> {
  readonly value: TOptionValue
  readonly label: string
  readonly disabled?: boolean
}

const props = defineProps<{
  modelValue: TValue
  options: readonly ThemedListboxOption<TValue>[]
  label: string
  disabled?: boolean
  testId?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [TValue] }>()

const expanded = ref(false)
const activeIndex = ref(-1)
const triggerRef = ref<HTMLButtonElement>()
const listRef = ref<HTMLUListElement>()
const instance = Math.random().toString(36).slice(2, 10)

const selectedIndex = computed(() =>
  props.options.findIndex((option) => option.value === props.modelValue)
)
const selectedLabel = computed(() => props.options[selectedIndex.value]?.label ?? '')
const activeOptionId = computed(() =>
  activeIndex.value < 0 ? undefined : `listbox-${instance}-option-${String(activeIndex.value)}`
)

function optionId(index: number): string {
  return `listbox-${instance}-option-${String(index)}`
}

/** Skips disabled rows so keyboard traversal never rests on an unusable option. */
function nextEnabledIndex(from: number, step: number): number {
  const total = props.options.length
  if (total === 0) return -1
  let index = from
  for (let visited = 0; visited < total; visited += 1) {
    index = (index + step + total) % total
    if (props.options[index]?.disabled !== true) return index
  }
  return -1
}

async function open(): Promise<void> {
  if (props.disabled === true || props.options.length === 0) return
  expanded.value = true
  activeIndex.value =
    props.options[selectedIndex.value]?.disabled === false || selectedIndex.value >= 0
      ? selectedIndex.value
      : nextEnabledIndex(-1, 1)
  await nextTick()
  listRef.value?.focus()
}

function close(returnFocus: boolean): void {
  expanded.value = false
  activeIndex.value = -1
  if (returnFocus) triggerRef.value?.focus()
}

function commit(index: number): void {
  const option = props.options[index]
  if (option === undefined || option.disabled === true) return
  emit('update:modelValue', option.value)
  close(true)
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return
  event.preventDefault()
  void open()
}

function onListKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      activeIndex.value = nextEnabledIndex(activeIndex.value, 1)
      return
    case 'ArrowUp':
      event.preventDefault()
      activeIndex.value = nextEnabledIndex(activeIndex.value, -1)
      return
    case 'Home':
      event.preventDefault()
      activeIndex.value = nextEnabledIndex(-1, 1)
      return
    case 'End':
      event.preventDefault()
      activeIndex.value = nextEnabledIndex(0, -1)
      return
    case 'Enter':
    case ' ':
      event.preventDefault()
      commit(activeIndex.value)
      return
    case 'Escape':
      event.preventDefault()
      close(true)
      return
    case 'Tab':
      close(false)
      return
    default:
  }
}

// A shrinking option list must not leave the popup pointing at a removed row.
watch(
  () => props.options.length,
  (length) => {
    if (length === 0) close(false)
  }
)
</script>

<template>
  <div class="themed-listbox" :data-expanded="expanded">
    <button
      ref="triggerRef"
      class="themed-listbox-trigger"
      type="button"
      role="combobox"
      :aria-controls="`listbox-${instance}`"
      :aria-expanded="expanded"
      :aria-label="props.label"
      :disabled="props.disabled === true || props.options.length === 0"
      :data-testid="props.testId"
      aria-haspopup="listbox"
      @click="expanded ? close(true) : open()"
      @keydown="onTriggerKeydown"
    >
      <span class="themed-listbox-value">{{ selectedLabel }}</span>
      <span aria-hidden="true" class="themed-listbox-caret">▾</span>
    </button>
    <ul
      v-if="expanded"
      :id="`listbox-${instance}`"
      ref="listRef"
      class="themed-listbox-popup"
      role="listbox"
      tabindex="-1"
      :aria-label="props.label"
      :aria-activedescendant="activeOptionId"
      @keydown="onListKeydown"
      @focusout="expanded = false"
    >
      <li
        v-for="(option, index) in props.options"
        :id="optionId(index)"
        :key="option.label"
        class="themed-listbox-option"
        role="option"
        :aria-selected="index === selectedIndex"
        :aria-disabled="option.disabled === true"
        :data-active="index === activeIndex"
        @click="commit(index)"
        @mousemove="activeIndex = index"
      >
        {{ option.label }}
      </li>
    </ul>
  </div>
</template>
