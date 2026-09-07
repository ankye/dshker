import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import outputSource from '../components/ConsoleOutputText.vue?raw'
import ConsoleOutputText from '../components/ConsoleOutputText.vue'

// Vitest disables CSS imports; read the real sheet so the cascade is exercised.
const routesCss = readFileSync('src/styles/routes.css', 'utf8')

/** Check the authored cascade against both existing stream-colored log containers. */
describe('console text color cascade', () => {
  afterEach(() => {
    document.head.querySelectorAll('[data-console-color-test]').forEach((node) => node.remove())
    document.body.innerHTML = ''
  })

  it.each(['controller-output', 'console-drawer-entries'])(
    'uses green and red text inside %s without changing source-label color',
    (containerClass) => {
      const styleMatch = /<style scoped>([\s\S]+)<\/style>/u.exec(outputSource)
      expect(styleMatch).not.toBeNull()
      const style = document.createElement('style')
      style.dataset.consoleColorTest = 'true'
      style.textContent = `:root { --color-text-muted: #7d8ea3; }\n${routesCss}\n${styleMatch![1]}`
      document.head.append(style)
      const container = document.createElement('ol')
      container.className = containerClass
      const row = document.createElement('li')
      row.dataset.stream = 'stderr'
      const label = document.createElement('span')
      label.textContent = 'stderr'
      row.append(label)
      container.append(row)
      document.body.append(container)
      const wrapper = mount(ConsoleOutputText, {
        attachTo: row,
        props: {
          entry: { text: '[I] listening\n[E] failed\n', stream: 'stderr', seq: 1, occurredAt: 1000 }
        }
      })
      const [normal, error] = wrapper.findAll('.console-output-line')
      expect(getComputedStyle(normal.element).color).toBe('#72d9a0')
      expect(getComputedStyle(error.element).color).toBe('#ffaba5')
      expect(getComputedStyle(label).color).toBe('#7d8ea3')
      expect(getComputedStyle(normal.element).whiteSpace).not.toBe('nowrap')
      wrapper.unmount()
    }
  )
})
