/**
 * Test-only public-control observer. Never imported by a production entry point.
 * DOM/rAF readback is diagnostic: it cannot certify every compositor pixel frame.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const selector = '[data-testid="remote-tab-account"]'
const contractPath = path.join(root, 'test-gates/account-session-interaction.json')
const fail = (code) => {
  throw new Error(code)
}

function explicitInputs() {
  if (process.argv.includes('--help')) {
    console.log(
      'Diagnostic public UI observer. Required: DSHKER_ACCOUNT_UI_PORT, DSHKER_ACCOUNT_UI_ARTIFACT_ROOT, DSHKER_ACCOUNT_UI_LOCALE=zh-CN|en-US. The existing native Windows candidate must be 0.1.95, visible and already signed in. No app lifecycle or credential mutations are performed. Every run reports releaseAccepted=false.'
    )
    return null
  }
  if (process.argv.length !== 2) fail('test.account_ui_unknown_argument')
  const port = process.env.DSHKER_ACCOUNT_UI_PORT
  if (!/^\d+$/.test(port ?? '') || Number(port) < 1024 || Number(port) > 65535)
    fail('test.account_ui_explicit_port_required')
  const locale = process.env.DSHKER_ACCOUNT_UI_LOCALE
  if (locale !== 'zh-CN' && locale !== 'en-US') fail('test.account_ui_explicit_locale_required')
  const raw = process.env.DSHKER_ACCOUNT_UI_ARTIFACT_ROOT
  if (!raw || !path.isAbsolute(raw)) fail('test.account_ui_explicit_artifact_root_required')
  const output = path.resolve(raw)
  const relative = path.relative(path.join(root, '.run'), output)
  if (relative.startsWith('..') || path.isAbsolute(relative) || /^[cC]:/.test(output))
    fail('test.account_ui_artifacts_must_use_repository_run_root')
  if (process.platform !== 'win32') fail('test.account_ui_native_windows_required')
  return { port: Number(port), locale, output }
}

async function clientFor(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) fail('test.account_ui_target_inventory_failed')
  const targets = await response.json()
  const candidates = targets.filter(
    (t) => t.type === 'page' && t.url?.startsWith('dsh-app://') && t.webSocketDebuggerUrl
  )
  if (candidates.length !== 1) fail('test.account_ui_exact_production_page_required')
  const socket = new WebSocket(candidates[0].webSocketDebuggerUrl)
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('test.account_ui_channel_failed')), {
      once: true
    })
  })
  const pending = new Map()
  let next = 1
  socket.addEventListener('message', ({ data }) => {
    const r = JSON.parse(String(data))
    if (!r.id) return
    const owner = pending.get(r.id)
    if (!owner) return
    pending.delete(r.id)
    if (r.error) owner.reject(new Error('test.account_ui_command_failed'))
    else owner.resolve(r.result)
  })
  async function send(method, params = {}) {
    await opened
    const id = next++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  return {
    send,
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      })
      if (r.exceptionDetails) fail('test.account_ui_observation_failed')
      return r.result?.value
    },
    close() {
      socket.close()
    }
  }
}

// This function executes in the page and reads only DOM state. It does not use
// Vue instances, preload methods, credentials, application commands or network.
function pageSetup(labels) {
  const norm = (v) => (v ?? '').replace(/\s+/g, ' ').trim()
  const footer = () => document.querySelector('.statusbar-network')
  const text = (s) => norm(document.querySelector(s)?.textContent)
  const rect = (node) => {
    if (!node) return null
    const r = node.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }
  const state = () => {
    const footerText = text('.statusbar-network .statusbar-fact-value')
    const badge = text('[data-testid="p2p-network-status"]')
    const panel = text('[data-testid="p2p-account-session-status"]')
    const version = text('.statusbar-facts .statusbar-fact:first-child .statusbar-fact-value')
    return {
      version,
      footer_text: footerText,
      footer_caption: text('.statusbar-network .statusbar-fact-label'),
      badge_text: badge,
      panel_text: panel,
      labels_equal: footerText === badge && badge === panel && !!panel,
      signed_in:
        footerText === labels.signedIn && badge === labels.signedIn && panel === labels.signedIn,
      statuses_visible: [
        '.statusbar-network',
        '[data-testid="p2p-network-status"]',
        '[data-testid="p2p-account-session-status"]'
      ].every((s) => visible(document.querySelector(s))),
      local_device_id: text('[data-testid="p2p-device-info"] code'),
      account_selected:
        document
          .querySelector('[data-testid="remote-tab-account"]')
          ?.getAttribute('aria-selected') === 'true'
    }
  }
  const visible = (node) => {
    if (!node) return false
    const r = node.getBoundingClientRect(),
      style = getComputedStyle(node)
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.x >= 0 &&
      r.y >= 0 &&
      r.right <= innerWidth &&
      r.bottom <= innerHeight &&
      style.visibility === 'visible' &&
      style.display !== 'none'
    )
  }
  const control = (s) => {
    const node = document.querySelector(s)
    if (!visible(node) || node.disabled) throw new Error('test.account_ui_control_unavailable')
    const r = node.getBoundingClientRect()
    const x = r.x + r.width / 2,
      y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    if (!node.contains(hit)) throw new Error('test.account_ui_control_obscured')
    return { x, y, visible: true, enabled: true }
  }
  const tree = () =>
    [...document.querySelectorAll('[data-testid], .statusbar-fact')].map((node) => ({
      selector: node.hasAttribute('data-testid')
        ? `[data-testid="${node.getAttribute('data-testid')}"]`
        : `.${[...node.classList].join('.')}`,
      role: node.getAttribute('role'),
      text: norm(node.textContent).slice(0, 500),
      disabled: !!node.disabled,
      rect: rect(node)
    }))
  const wait = (predicate) =>
    new Promise((resolve, reject) => {
      const deadline = performance.now() + 30000
      const sample = () => {
        if (predicate()) return resolve(true)
        if (performance.now() >= deadline)
          return reject(new Error('test.account_ui_condition_timeout'))
        requestAnimationFrame(sample)
      }
      sample()
    })
  window.__accountUiObserver = {
    state,
    tree,
    control,
    waitControl: (s) =>
      wait(() => {
        try {
          control(s)
          return true
        } catch {
          return false
        }
      }),
    waitSignedIn: () => wait(() => state().footer_text === labels.signedIn),
    arm(s, gestureId) {
      if (document.visibilityState !== 'visible')
        throw new Error('test.account_ui_visible_page_required')
      const before = state(),
        point = control(s)
      const report = {
        ready_ms: performance.now(),
        before_state: before,
        control: point,
        events: [],
        frames: [],
        settled: false
      }
      let previous,
        stable = 0,
        framePeriod
      const periods = []
      const onClick = (e) => {
        if (!e.target.closest(s)) return
        document.removeEventListener('click', onClick, true)
        report.events.push({
          kind: 'click',
          gesture_id: gestureId,
          at_ms: performance.now(),
          trusted: e.isTrusted,
          selector: s
        })
        if (!e.isTrusted) {
          report.failure = 'test.account_ui_untrusted_input'
          return
        }
        report.accepted_ms = performance.now()
        const sample = (timestamp) => {
          const current = state(),
            box = rect(footer())
          const complete =
            current.labels_equal &&
            current.signed_in &&
            current.statuses_visible &&
            current.footer_caption === labels.account &&
            /^[a-f0-9]{12}$/.test(current.local_device_id)
          const now = performance.now()
          if (previous) periods.push(timestamp - previous.timestamp)
          const label = footer()?.querySelector('.statusbar-fact-label')
          const value = footer()?.querySelector('.statusbar-fact-value')
          const a = rect(label),
            b = rect(value)
          const overlap =
            a && b && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)
              ? Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
              : 0
          const jump =
            previous?.box && box
              ? Math.max(Math.abs(previous.box.x - box.x), Math.abs(previous.box.y - box.y))
              : 0
          report.frames.push({
            presented_ms: timestamp,
            observed_dom_at_ms: now,
            footer_rect: box,
            observed_state: current,
            missing_visible_page_count: footer() && visible(footer()) ? 0 : 1,
            gap_px: a && b && box ? Math.max(0, box.x - a.x, b.x + b.width - box.x - box.width) : 1,
            overlap_px: overlap,
            reverse_px: previous?.box && box ? Math.max(0, previous.box.x - box.x) : 0,
            content_error_count:
              current.footer_text === labels.signedIn && (!report.visible_ms || complete) ? 0 : 1,
            text_order_error_count:
              label &&
              value &&
              label.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_FOLLOWING
                ? 0
                : 1,
            unexpected_jump_px: jump,
            white_frame: null,
            flash_frame: null,
            pixel_measurement: 'unproven',
            observation_kind:
              'DOM sampled at requestAnimationFrame, not compositor presentation proof'
          })
          if (complete && report.visible_ms === undefined) {
            report.visible_ms = now
            report.visible_state = current
            report.outcome_ms = now
            report.outcome = 'applied'
          }
          stable =
            complete && previous?.state?.labels_equal && previous.state.signed_in && jump === 0
              ? stable + 1
              : 0
          previous = { timestamp, state: current, box }
          if (stable >= 2) {
            report.settled_ms = now
            report.settled = true
          } else if (now - report.accepted_ms > 1000) {
            report.failure = 'test.account_ui_settled_budget_exceeded'
          }
          if (!report.settled && !report.failure) return requestAnimationFrame(sample)
          const sorted = periods.filter((n) => n > 0).sort((a, b) => a - b)
          framePeriod = sorted[Math.floor(sorted.length / 2)]
          for (const frame of report.frames) {
            // The sampled rAF interval is not independently verified display
            // timing. Keep the acceptance field unknown instead of laundering
            // a dropped-frame observation into its own permissive denominator.
            frame.refresh_period_ms = null
            frame.observed_raf_period_median_ms = framePeriod ?? null
          }
          report.terminals = [
            { outcome: report.outcome ?? 'failed', at_ms: report.outcome_ms ?? now }
          ]
          report.tree = tree()
          report.completed = true
        }
        requestAnimationFrame(sample)
      }
      document.addEventListener('click', onClick, true)
      this.report = report
      return { before, point, ready_ms: report.ready_ms }
    },
    report: null
  }
  return { version: state().version, visible: document.visibilityState === 'visible' }
}

async function click(client, s) {
  const point = await client.evaluate(`window.__accountUiObserver.control(${JSON.stringify(s)})`)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
}

/** Plain observed selectors remain literal; raw DOM/AX JSON is retained beside it. */
function observedTreeText(nodes) {
  assert.ok(Array.isArray(nodes) && nodes.length > 0, 'test.account_ui_observed_tree_required')
  const lines = nodes.flatMap((node) => {
    assert.ok(
      typeof node.selector === 'string' &&
        node.selector.length > 0 &&
        !/[\r\n]/.test(node.selector),
      'test.account_ui_observed_selector_required'
    )
    return [
      node.selector,
      `  role=${node.role ?? ''} disabled=${node.disabled === true}`,
      `  text=${String(node.text ?? '').replace(/[\r\n]+/g, ' ')}`,
      `  rect=${JSON.stringify(node.rect)}`
    ]
  })
  const result = lines.join('\n') + '\n'
  // Check the serialized output itself. JSON escaping once concealed literal
  // attribute selectors from the acceptance validator's raw tree search.
  const serializedLines = new Set(result.split('\n'))
  for (const node of nodes)
    assert.ok(
      serializedLines.has(node.selector),
      'test.account_ui_observed_selector_serialization_lost'
    )
  return result
}

async function run(inputs) {
  const contract = JSON.parse(await readFile(contractPath, 'utf8'))
  if (contract.acceptance_stage !== 'diagnostic')
    fail('test.account_ui_pixel_coverage_unproven_for_release')
  if (!contract.implementation_complete || contract.prerequisites.some((p) => !p.passed))
    fail('test.account_ui_implementation_prerequisites_incomplete')
  for (const prereq of contract.prerequisites) {
    if (!(await readFile(path.join(root, prereq.artifact))).length)
      fail('test.account_ui_missing_prerequisite_artifact')
  }
  const runId = randomUUID(),
    output = path.join(inputs.output, runId)
  await mkdir(output, { recursive: true })
  const artifact = (name) => path.relative(root, path.join(output, name)).split(path.sep).join('/')
  const ledger = path.join(output, 'ledger.jsonl')
  const labels = contract.expected_labels[inputs.locale]
  await writeFile(
    path.join(output, 'oracle.json'),
    JSON.stringify(
      {
        labels,
        version: '0.1.95',
        expected_device: 'one enrolled 12-digit hexadecimal local device ID',
        required: 'shared account label; footer account caption; device identity present'
      },
      null,
      2
    )
  )
  const client = await clientFor(inputs.port)
  const summary = {
    runId,
    deviceId: hostname(),
    deviceKind: 'physical-windows-host',
    releaseAccepted: false,
    pixelCoverage: 'unproven',
    diagnosticPassed: false,
    artifactDirectory: artifact(''),
    attempts: 0
  }
  try {
    await client.send('Page.bringToFront')
    await client.send('Runtime.enable')
    await client.send('Accessibility.enable')
    const initial = await client.evaluate(`(${pageSetup.toString()})(${JSON.stringify(labels)})`)
    assert.equal(initial.version, '0.1.95', 'test.account_ui_exact_candidate_version_required')
    assert.equal(initial.visible, true, 'test.account_ui_visible_page_required')
    await client.evaluate('window.__accountUiObserver.waitSignedIn()')
    await client.evaluate('window.__accountUiObserver.waitControl(\'[data-testid="nav-remote"]\')')
    await click(client, '[data-testid="nav-remote"]')
    await client.evaluate(`window.__accountUiObserver.waitControl(${JSON.stringify(selector)})`)
    const inventory = await client.evaluate('window.__accountUiObserver.tree()')
    await writeFile(path.join(output, 'inventory-ui-tree.json'), JSON.stringify(inventory, null, 2))
    await writeFile(path.join(output, 'inventory-ui-tree.txt'), observedTreeText(inventory))
    await writeFile(
      path.join(output, 'inventory-events.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          publicPath: ['Remote connections', 'Network and account'],
          selector,
          nativeDevice: hostname()
        },
        null,
        2
      )
    )
    await appendFile(
      ledger,
      JSON.stringify({
        record_type: 'inventory',
        run_id: runId,
        visible_enabled_controls: ['open-account-session'],
        control_selectors: { 'open-account-session': selector },
        artifacts: {
          ui_tree: artifact('inventory-ui-tree.txt'),
          raw_ui_tree: artifact('inventory-ui-tree.json'),
          event_log: artifact('inventory-events.json')
        }
      }) + '\n'
    )
    for (let index = 0; index < contract.workflows[0].minimum_attempts; index++) {
      await client.evaluate(
        'window.__accountUiObserver.waitControl(\'[data-testid="remote-tab-connect"]\')'
      )
      await click(client, '[data-testid="remote-tab-connect"]')
      await client.evaluate(`window.__accountUiObserver.waitControl(${JSON.stringify(selector)})`)
      const gestureId = randomUUID(),
        attemptId = randomUUID()
      await client.evaluate(
        `window.__accountUiObserver.arm(${JSON.stringify(selector)}, ${JSON.stringify(gestureId)})`
      )
      await click(client, selector)
      const report = await client.evaluate(
        `new Promise((resolve, reject) => { const deadline=performance.now()+2000; function sample(){const r=window.__accountUiObserver.report;if(r?.completed)return resolve(r);if(performance.now()>deadline)return reject(new Error('test.account_ui_report_timeout'));requestAnimationFrame(sample)}sample()})`
      )
      const ax = await client.send('Accessibility.getFullAXTree')
      const nativeLabels = ax.nodes.map((n) => n.name?.value).filter((n) => typeof n === 'string')
      const nativeState = {
        version: nativeLabels.includes('0.1.95') ? '0.1.95' : '',
        labels_equal: nativeLabels.filter((n) => n === labels.signedIn).length >= 3,
        signed_in:
          nativeLabels.some((n) => n === `${labels.account}: ${labels.signedIn}`) &&
          nativeLabels.filter((n) => n === labels.signedIn).length >= 3
      }
      const prefix = `attempt-${index + 1}`
      await writeFile(
        path.join(output, `${prefix}-ui-tree.json`),
        JSON.stringify({ dom: report.tree, accessibility: ax }, null, 2)
      )
      await writeFile(path.join(output, `${prefix}-ui-tree.txt`), observedTreeText(report.tree))
      await writeFile(
        path.join(output, `${prefix}-accessibility.json`),
        JSON.stringify(ax, null, 2)
      )
      await writeFile(
        path.join(output, `${prefix}-events.json`),
        JSON.stringify(
          {
            events: report.events,
            signature: report.events.some((e) => e.trusted)
              ? 'trusted-public-account-tab-click'
              : 'untrusted',
            domFrames: report.frames,
            pixelCoverage: 'unproven'
          },
          null,
          2
        )
      )
      const screenshot = await client.send('Page.captureScreenshot', { format: 'png' })
      await writeFile(path.join(output, `${prefix}.png`), Buffer.from(screenshot.data, 'base64'))
      const record = {
        record_type: 'attempt',
        run_id: runId,
        attempt_id: attemptId,
        gesture_id: gestureId,
        workflow_id: 'open-account-session',
        input_modality: 'mouse',
        profile: 'signed-in-windows',
        device_kind: 'physical',
        device_id: hostname(),
        public_ui_action: true,
        ui_path: ['Remote connections', 'Network and account tab'],
        control_selector: selector,
        control_visible: report.control.visible,
        control_enabled: report.control.enabled,
        ready_ms: report.ready_ms,
        accepted_ms: report.accepted_ms,
        visible_ms: report.visible_ms,
        outcome_ms: report.outcome_ms,
        settled_ms: report.settled_ms,
        outcome: report.outcome,
        terminals: report.terminals,
        before_state: report.before_state,
        visible_state: report.visible_state,
        native_state: nativeState,
        native_event_signature: report.events.some((e) => e.trusted)
          ? 'trusted-public-account-tab-click'
          : 'untrusted',
        frames: report.frames,
        content_error_count: report.visible_state?.labels_equal && nativeState.labels_equal ? 0 : 1,
        content_checks: [
          {
            id: 'shared_account_label',
            expected_signature: labels.signedIn,
            actual_signature: report.visible_state?.labels_equal
              ? report.visible_state.footer_text
              : 'mismatch',
            passed: !!report.visible_state?.labels_equal,
            oracle_artifact: artifact('oracle.json')
          },
          {
            id: 'footer_account_caption',
            expected_signature: labels.account,
            actual_signature: report.visible_state?.footer_caption ?? 'missing',
            passed: report.visible_state?.footer_caption === labels.account,
            oracle_artifact: artifact('oracle.json')
          },
          {
            id: 'device_identity_present',
            expected_signature: 'one enrolled 12-digit hexadecimal local device ID',
            actual_signature: /^[a-f0-9]{12}$/.test(report.visible_state?.local_device_id ?? '')
              ? 'one enrolled 12-digit hexadecimal local device ID'
              : 'missing',
            passed: /^[a-f0-9]{12}$/.test(report.visible_state?.local_device_id ?? ''),
            oracle_artifact: artifact('oracle.json')
          }
        ],
        artifacts: {
          ui_tree: artifact(`${prefix}-ui-tree.txt`),
          raw_ui_tree: artifact(`${prefix}-ui-tree.json`),
          accessibility_tree: artifact(`${prefix}-accessibility.json`),
          event_log: artifact(`${prefix}-events.json`),
          screenshot: artifact(`${prefix}.png`)
        },
        measurement_scope:
          'DOM/rAF and accessibility observation; pixel white/flash metrics unknown',
        releaseAccepted: false
      }
      await appendFile(ledger, JSON.stringify(record) + '\n')
      summary.attempts++
      assert.equal(report.failure, undefined, report.failure)
      assert.equal(record.visible_state.labels_equal, true, 'test.account_ui_surfaces_disagree')
      assert.equal(record.visible_state.signed_in, true, 'test.account_ui_not_confirmed_signed_in')
      assert.equal(
        nativeState.labels_equal && nativeState.signed_in,
        true,
        'test.account_ui_accessibility_readback_disagrees'
      )
      assert.ok(
        report.visible_ms - report.accepted_ms <= 500,
        'test.account_ui_visible_budget_exceeded'
      )
      assert.ok(
        report.settled_ms - report.accepted_ms <= 1000,
        'test.account_ui_settled_budget_exceeded'
      )
    }
    summary.diagnosticPassed = true
  } catch (error) {
    summary.failure = /^test\./.test(error.message)
      ? error.message
      : 'test.account_ui_diagnostic_failed'
    throw error
  } finally {
    await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2))
    await writeFile(path.join(inputs.output, 'latest-run.json'), JSON.stringify(summary, null, 2))
    client.close()
    console.log(JSON.stringify(summary))
  }
}

try {
  const inputs = explicitInputs()
  if (inputs) await run(inputs)
} catch (error) {
  console.error(/^test\./.test(error.message) ? error.message : 'test.account_ui_diagnostic_failed')
  process.exitCode = 1
}
