import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { ChildOutputObserver } from './child-output-observer'

/**
 * The observer owns the one subtle part of launch output: chunk boundaries can
 * split the URL announcement mid-line, and adopting a truncated URL would drop
 * the session credential DSH puts in its query.
 */
describe('ChildOutputObserver', () => {
  function fakeChild(): ChildProcess {
    const child = new EventEmitter() as unknown as ChildProcess
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter() })
    return child
  }

  it('reads the announced URL only from a complete line split across chunks', () => {
    const urls: string[] = []
    const observer = new ChildOutputObserver({
      onText: () => undefined,
      onAnnouncedUrl: (url) => {
        urls.push(url)
      }
    })
    const child = fakeChild()
    observer.attach(child)

    child.stdout?.emit('data', 'building\ndsh web: http://127.0.0.1:3080/?token=ab')
    expect(urls).toEqual([])
    child.stdout?.emit('data', 'c123\nready\n')

    expect(urls).toEqual(['http://127.0.0.1:3080/?token=abc123'])
  })

  it('forwards every non-empty fragment with its stream, dropping empty chunks', () => {
    const fragments: string[] = []
    const observer = new ChildOutputObserver({
      onText: (stream, text) => {
        fragments.push(`${stream}:${text}`)
      },
      onAnnouncedUrl: () => undefined
    })
    const child = fakeChild()
    observer.attach(child)

    child.stdout?.emit('data', 'out\n')
    child.stderr?.emit('data', '')
    child.stderr?.emit('data', 'err\n')

    expect(fragments).toEqual(['stdout:out\n', 'stderr:err\n'])
  })

  it('drops the partial line from a previous launch after reset', () => {
    const urls: string[] = []
    const observer = new ChildOutputObserver({
      onText: () => undefined,
      onAnnouncedUrl: (url) => {
        urls.push(url)
      }
    })
    const first = fakeChild()
    observer.attach(first)
    first.stdout?.emit('data', 'dsh web: http://127.0.0.1:3080/?token=ol')

    observer.reset()
    const second = fakeChild()
    observer.attach(second)
    second.stdout?.emit('data', 'c123\n')

    // Without the reset, the stale fragment would complete with the new chunk
    // into the killed launch's URL and be adopted for the second launch.
    expect(urls).toEqual([])
  })
})
