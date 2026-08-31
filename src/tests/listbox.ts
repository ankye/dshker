import type { VueWrapper } from '@vue/test-utils'

/**
 * Drives a `ThemedListbox` the way a user does: open the trigger, then click
 * the option carrying the wanted label.
 *
 * Tests must not reach into the control's internals, because the point of the
 * themed control is that its committed value comes from a real interaction.
 */
export async function selectListboxOption(
  wrapper: VueWrapper,
  testId: string,
  label: string
): Promise<void> {
  const trigger = wrapper.get(`[data-testid="${testId}"]`)
  await trigger.trigger('click')

  const listId = trigger.attributes('aria-controls')
  if (listId === undefined) throw new Error(`listbox ${testId} did not expose aria-controls`)

  const options = wrapper.findAll(`#${listId} [role="option"]`)
  const target = options.find((option) => option.text() === label)
  if (target === undefined) {
    throw new Error(
      `listbox ${testId} has no option labelled ${label}; available: ` +
        options.map((option) => option.text()).join(' | ')
    )
  }
  await target.trigger('click')
}
