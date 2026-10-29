/**
 * Functional diagnosis of the installed formal application through public UI.
 * Inputs use real CDP mouse events; all page evaluation only observes DOM state.
 * Raw DOM, URLs and screenshots stay under an explicitly private D-drive root.
 * This does not certify compositor frames, latency budgets or overnight P2P.
 */
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const code = (suffix) => `test.formal_ui_${suffix}`
const fail = (suffix) => {
  throw new Error(code(suffix))
}
const requireCondition = (condition, suffix) => {
  if (!condition) fail(suffix)
}
const selector = (id) => {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(id)) fail('invalid_observed_test_id')
  return `[data-testid="${id}"]`
}

async function inputs() {
  if (process.argv.includes('--help')) {
    console.log(
      'Installed Windows functional recovery observer. Required: DSHKER_FORMAL_UI_PORT, DSHKER_FORMAL_UI_ARTIFACT_ROOT (existing private D-drive directory). Optional: DSHKER_FORMAL_UI_SSH_LABEL and DSHKER_FORMAL_UI_PEER_LABEL select exact visible titles when ambiguous. DSHKER_FORMAL_UI_REUSE_READY=1 preserves already-ready connections and verifies their actual guest content. The default interactive path requires a visible, signed-in app and exercises public SSH connection/tab controls. --observe-existing reads already-connected SSH and P2P tabs and their real guest DOM without input, focus, navigation or a visibility requirement. This is readback after separately recorded manual-control acceptance. No credentials are entered. No compositor or latency acceptance is claimed.'
    )
    return null
  }
  const observeExisting = process.argv.length === 3 && process.argv[2] === '--observe-existing'
  if (process.argv.length !== 2 && !observeExisting) fail('unknown_argument')
  if (process.platform !== 'win32') fail('native_windows_required')
  const port = Number(process.env.DSHKER_FORMAL_UI_PORT)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('explicit_port_required')
  const supplied = process.env.DSHKER_FORMAL_UI_ARTIFACT_ROOT
  if (!supplied || !path.isAbsolute(supplied) || !/^d:[\\/]/i.test(supplied))
    fail('private_d_drive_output_required')
  const info = await lstat(supplied).catch(() => undefined)
  if (!info?.isDirectory() || info.isSymbolicLink()) fail('existing_output_directory_required')
  const output = await realpath(supplied)
  if (!/^d:[\\/]/i.test(output)) fail('output_realpath_must_use_d_drive')
  assertPrivateDirectory(output)
  const pkg = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) fail('stable_expected_version_required')
  return {
    port,
    output,
    version: pkg.version,
    sshLabel: process.env.DSHKER_FORMAL_UI_SSH_LABEL,
    peerLabel: process.env.DSHKER_FORMAL_UI_PEER_LABEL,
    reuseReady: process.env.DSHKER_FORMAL_UI_REUSE_READY === '1',
    observeExisting
  }
}

function assertPrivateDirectory(directory) {
  const literal = `'${directory.replaceAll("'", "''")}'`
  const script = `$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath ${literal}; $s=[Security.Principal.WindowsIdentity]::GetCurrent().User; if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $s.Value){exit 2}; foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $r.IdentityReference.Value -notin @($s.Value,'S-1-5-18')){exit 3}}; exit 0`
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4096
    }
  )
  if (result.error || result.status !== 0)
    fail('output_acl_must_allow_only_current_user_and_system')
}

async function connectCdp(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  const listeners = new Set()
  let next = 1
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error(code('cdp_open_failed'))), {
      once: true
    })
  })
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data))
    if (!message.id) {
      for (const listener of listeners) listener(message)
      return
    }
    const owner = pending.get(message.id)
    if (!owner) return
    pending.delete(message.id)
    clearTimeout(owner.timer)
    if (message.error) {
      const error = new Error(code('cdp_command_failed'))
      error.cdpMethod = owner.method
      error.cdpCode = message.error.code
      owner.reject(error)
    } else owner.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const owner of pending.values()) {
      clearTimeout(owner.timer)
      owner.reject(new Error(code('cdp_closed')))
    }
    pending.clear()
  })
  await opened
  return {
    send(method, params = {}, sessionId) {
      const id = next++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          const error = new Error(code('cdp_command_timeout'))
          error.cdpMethod = method
          reject(error)
        }, 45_000)
        pending.set(id, { resolve, reject, timer, method })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      socket.close()
    }
  }
}

async function evaluate(client, fn, args = []) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) fail('dom_observation_failed')
  return result.result?.value
}

async function waitFor(client, predicate, args, timeout = 30_000) {
  let deadline
  const observation = evaluate(
    client,
    (source, values, budget) =>
      new Promise((resolve) => {
        const predicate = (0, eval)(`(${source})`)
        const deadline = performance.now() + budget
        function sample() {
          if (document.visibilityState !== 'visible') return resolve({ failed: 'page_not_visible' })
          const result = predicate(...values)
          if (result) return resolve(result)
          if (performance.now() >= deadline) return resolve({ failed: 'condition_timeout' })
          requestAnimationFrame(sample)
        }
        sample()
      }),
    [predicate.toString(), args, timeout]
  )
  const result = await Promise.race([
    observation,
    new Promise((resolve) => {
      deadline = setTimeout(() => resolve({ failed: 'condition_timeout' }), timeout)
    })
  ]).finally(() => clearTimeout(deadline))
  if (result?.failed) fail(result.failed)
  return result
}

async function click(client, control, traceRoot = control) {
  const point = await waitFor(
    client,
    (control) => {
      const nodes = document.querySelectorAll(control)
      if (nodes.length > 1) return { failed: 'control_ambiguous' }
      const node = nodes[0]
      const rect = node?.getBoundingClientRect()
      if (!node || node.disabled || node.getAttribute('aria-disabled') === 'true' || !rect)
        return null
      const x = rect.x + rect.width / 2,
        y = rect.y + rect.height / 2
      if (
        document.visibilityState !== 'visible' ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        x < 0 ||
        y < 0 ||
        x >= innerWidth ||
        y >= innerHeight ||
        !node.contains(document.elementFromPoint(x, y))
      )
        return null
      return { x, y }
    },
    [control],
    10_000
  )
  await evaluate(
    client,
    (control, root) => {
      window.__formalRecoveryTrace?.stop()
      const node = document.querySelector(control)
      const container = document.querySelector(root)
      const entries = []
      const record = (kind, event) =>
        entries.push({
          at: performance.now(),
          kind,
          trusted: event?.isTrusted === true,
          disabled: node?.disabled === true,
          states: Array.from(container?.querySelectorAll('[data-state]') ?? []).map(
            (entry) => entry.dataset.state
          )
        })
      const handler = (event) => {
        if (node?.contains(event.target)) record('click', event)
      }
      const observer = new MutationObserver(() => record('mutation'))
      observer.observe(container ?? node, { attributes: true, childList: true, subtree: true })
      document.addEventListener('click', handler, true)
      record('before')
      window.__formalRecoveryTrace = {
        entries,
        stop() {
          observer.disconnect()
          document.removeEventListener('click', handler, true)
        }
      }
    },
    [control, traceRoot]
  )
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  for (const type of ['mousePressed', 'mouseReleased'])
    await client.send('Input.dispatchMouseEvent', {
      type,
      ...point,
      button: 'left',
      clickCount: 1
    })
  const trace = await readTrace(client)
  if (!trace.some((entry) => entry.kind === 'click' && entry.trusted))
    fail('trusted_click_required')
}

function readTrace(client) {
  return evaluate(client, () => window.__formalRecoveryTrace?.entries ?? [])
}

function chooseObserved(options, explicit, kind) {
  const matching = explicit
    ? options.filter((entry) => entry.label === explicit)
    : options.filter((entry) => /macbook|macos|\bmac\b/i.test(entry.label))
  if (matching.length === 1) return matching[0]
  if (!explicit && matching.length === 0 && options.length === 1) return options[0]
  fail(`${kind}_target_ambiguous`)
}

function accountState() {
  const text = (s) => document.querySelector(s)?.textContent?.trim() ?? ''
  const footer = text('.statusbar-network .statusbar-fact-value')
  const account = text('[data-testid="p2p-account-session-status"]')
  const network = text('[data-testid="p2p-network-status"]')
  const user = text('.p2p-account-identity-name')
  const device = text('[data-testid="p2p-device-info"] code')
  const refresh = document.querySelector('[data-testid="p2p-account-read-user"]')
  return {
    version: text('.statusbar-facts .statusbar-fact:first-child .statusbar-fact-value'),
    signedIn: ['已登录', 'Signed in'].includes(account) && !!user,
    equal: footer === account && account === network,
    serviceGateAbsent: !document.querySelector('[data-testid="p2p-account-service-gate"]'),
    refreshEnabled: !!refresh && !refresh.disabled,
    errorAbsent: !document.querySelector('[data-testid="p2p-account-error"]'),
    user,
    device,
    selectedNetwork: text('[data-testid="p2p-network-id"]')
  }
}

async function capture(client, directory, name, extra, screenshot = true) {
  const dom = await evaluate(client, () => ({
    readyState: document.readyState,
    visibility: document.visibilityState,
    html: document.documentElement.outerHTML
  }))
  await writeFile(path.join(directory, `${name}-dom.json`), JSON.stringify({ dom, extra }, null, 2))
  if (screenshot) {
    const image = await client.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(path.join(directory, `${name}.png`), Buffer.from(image.data, 'base64'))
  }
}

async function guestObserver(browser, shellId, src) {
  const expected = new URL(src)
  const candidates = new Map()
  const matches = (target) => {
    if (target.targetId === shellId || !['page', 'webview'].includes(target.type)) return false
    try {
      const actual = new URL(target.url)
      return actual.protocol === expected.protocol && actual.host === expected.host
    } catch {
      return false
    }
  }
  const select = () => {
    const all = [...candidates.values()].filter(matches)
    const exact = all.filter((target) => target.url === src)
    if (exact.length === 1) return exact[0]
    return all.length === 1 ? all[0] : undefined
  }
  let signalChange
  const stop = browser.onEvent((event) => {
    if (event.method === 'Target.targetCreated' || event.method === 'Target.targetInfoChanged') {
      const target = event.params.targetInfo
      candidates.set(target.targetId, target)
      signalChange?.()
    }
    if (event.method === 'Target.targetDestroyed') candidates.delete(event.params.targetId)
  })
  try {
    await browser.send('Target.setDiscoverTargets', { discover: true })
    for (const target of (await browser.send('Target.getTargets')).targetInfos)
      candidates.set(target.targetId, target)
    const target =
      select() ??
      (await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(code('guest_target_unavailable'))), 10_000)
        signalChange = () => {
          const target = select()
          if (target) {
            clearTimeout(timer)
            resolve(target)
          }
        }
        signalChange()
      }))
    const { sessionId } = await browser.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true
    })
    return {
      targetId: target.targetId,
      exactUrlMatched: target.url === src,
      send: (method, params) => browser.send(method, params, sessionId),
      close: () => browser.send('Target.detachFromTarget', { sessionId })
    }
  } finally {
    stop()
  }
}

async function verifyWorkbench(shell, browser, shellId, tabId, directory, kind) {
  const viewSelector = selector(`runtime-webview-${tabId}`)
  const tabSelector = selector(`runtime-tab-${tabId}`)
  const view = await waitFor(
    shell,
    (viewSelector, tabSelector) => {
      const tab = document.querySelector(tabSelector)
      const row = tab?.closest('.browser-tab')
      if (row?.dataset.state === 'failed') return { failed: 'workbench_connection_failed' }
      const view = document.querySelector(viewSelector)
      if (
        row?.dataset.state !== 'ready' ||
        tab?.getAttribute('aria-selected') !== 'true' ||
        view?.dataset.hidden !== 'false' ||
        !view.getAttribute('src')
      )
        return null
      return { src: view.getAttribute('src'), ready: true }
    },
    [viewSelector, tabSelector]
  )
  const guest = await guestObserver(browser, shellId, view.src)
  try {
    await guest.send('Runtime.enable')
    await guest.send('Page.enable')
    const loaded = await waitFor(guest, () => {
      const root = document.querySelector('#root, #app')
      const controls = document.querySelectorAll('button, input, textarea, select, [role="button"]')
      const ready =
        document.readyState === 'complete' &&
        !!root &&
        root.childElementCount > 0 &&
        (document.body?.innerText.trim().length ?? 0) > 0 &&
        controls.length > 0 &&
        !document.querySelector('input[type="password"]')
      return ready
        ? {
            readyState: document.readyState,
            rootPresent: true,
            interactiveControls: controls.length
          }
        : null
    }, [])
    // Electron webview targets do not own a separately capturable native surface.
    // Preserve their real DOM and capture the visible shell containing the guest.
    await capture(guest, directory, `${kind}-guest`, loaded, false)
    await capture(shell, directory, `${kind}-shell`, { activeReadyTab: true })
    return { ready: true, actualGuestLoaded: true, interactiveControls: loaded.interactiveControls }
  } finally {
    await guest.close()
  }
}

// This mode deliberately has no route to the interactive runner or its trace mutations.
// It reads only DOM rendered by the user's existing real connections.
async function observeExisting(input) {
  const runId = randomUUID()
  const directory = path.join(input.output, runId)
  await mkdir(directory)
  assertPrivateDirectory(directory)
  const summary = {
    runId,
    expectedVersion: input.version,
    kind: 'manual-public-control-readonly-readback',
    stage: 'connect-cdp',
    noInputSent: true,
    publicControlsExercisedByObserver: false,
    separateManualControlAcceptanceRequired: true,
    compositorFrameAcceptance: false,
    latencyAcceptance: false,
    readbackPassed: false,
    account: false,
    ssh: false,
    lan: false
  }
  let shell, browser
  const guestIdentities = new Set()
  try {
    const response = await fetch(`http://127.0.0.1:${input.port}/json/list`)
    requireCondition(response.ok, 'target_inventory_unavailable')
    const pages = (await response.json()).filter(
      (target) =>
        target.type === 'page' &&
        target.url?.startsWith('dsh-app://') &&
        target.webSocketDebuggerUrl
    )
    requireCondition(pages.length === 1, 'exact_formal_shell_required')
    const info = await (await fetch(`http://127.0.0.1:${input.port}/json/version`)).json()
    requireCondition(info.webSocketDebuggerUrl, 'browser_observation_endpoint_required')
    shell = await connectCdp(pages[0].webSocketDebuggerUrl)
    browser = await connectCdp(info.webSocketDebuggerUrl)
    summary.stage = 'shell-readback'
    const observed = await evaluate(shell, () => {
      const text = (s) => document.querySelector(s)?.textContent?.trim() ?? ''
      return {
        version: text('.statusbar-facts .statusbar-fact:first-child .statusbar-fact-value'),
        footer: text('.statusbar-network .statusbar-fact-value'),
        accountPanel: document.querySelector('[data-testid="p2p-account-panel"]')
          ? {
              session: text('[data-testid="p2p-account-session-status"]'),
              network: text('[data-testid="p2p-network-status"]'),
              identityPresent: !!text('.p2p-account-identity-name')
            }
          : null,
        tabs: Array.from(
          document.querySelectorAll(
            '[data-testid^="runtime-tab-remote:"], [data-testid^="runtime-tab-peer:"]'
          )
        ).map((tab) => {
          const id = tab.dataset.testid.slice('runtime-tab-'.length)
          const view = document.querySelector(`[data-testid="runtime-webview-${id}"]`)
          return {
            id,
            label: tab.querySelector('.browser-tab-title')?.textContent?.trim() ?? '',
            ready: tab.closest('.browser-tab')?.dataset.state === 'ready',
            src: view?.getAttribute('src') ?? null
          }
        })
      }
    })
    await capture(shell, directory, 'existing-shell', observed, false)
    requireCondition(observed.version === input.version, 'exact_version_required')
    requireCondition(['已登录', 'Signed in'].includes(observed.footer), 'footer_not_signed_in')
    summary.accountPanelObserved = observed.accountPanel !== null
    if (observed.accountPanel)
      requireCondition(
        observed.accountPanel.session === observed.footer &&
          observed.accountPanel.network === observed.footer &&
          observed.accountPanel.identityPresent,
        'observed_account_state_mismatch'
      )
    summary.account = true
    for (const [kind, prefix, label] of [
      ['ssh', 'remote:', input.sshLabel],
      ['lan', 'peer:', input.peerLabel]
    ]) {
      summary.stage = `${kind}-existing-readback`
      const candidates = observed.tabs.filter((tab) => tab.id.startsWith(prefix) && tab.ready)
      requireCondition(candidates.length > 0, `${kind}_existing_ready_tab_missing`)
      const tab = chooseObserved(candidates, label, `${kind}_existing`)
      requireCondition(tab.src, `${kind}_existing_webview_missing`)
      const guest = await guestObserver(browser, pages[0].id, tab.src)
      try {
        requireCondition(guest.exactUrlMatched, `${kind}_existing_guest_url_mismatch`)
        requireCondition(!guestIdentities.has(guest.targetId), 'distinct_existing_guests_required')
        guestIdentities.add(guest.targetId)
        const loaded = await evaluate(guest, () => {
          const root = document.querySelector('#root, #app')
          return {
            readyState: document.readyState,
            rootPresent: !!root,
            rootChildren: root?.childElementCount ?? 0,
            bodyTextLength: document.body?.innerText.trim().length ?? 0,
            interactiveControls: document.querySelectorAll(
              'button, input, textarea, select, [role="button"]'
            ).length,
            passwordPresent: !!document.querySelector('input[type="password"]')
          }
        })
        await capture(guest, directory, `${kind}-existing-guest`, { tab, loaded }, false)
        requireCondition(
          loaded.readyState === 'complete' &&
            loaded.rootPresent &&
            loaded.rootChildren > 0 &&
            loaded.bodyTextLength > 0 &&
            loaded.interactiveControls > 0 &&
            !loaded.passwordPresent,
          `${kind}_existing_guest_not_loaded`
        )
        summary[`${kind}Workbench`] = {
          tabIdentitySha256: createHash('sha256').update(tab.id).digest('hex'),
          guestIdentitySha256: createHash('sha256').update(guest.targetId).digest('hex'),
          exactGuestUrlMatched: true,
          ready: true,
          actualGuestLoaded: true,
          interactiveControls: loaded.interactiveControls
        }
        summary[kind] = true
      } finally {
        await guest.close()
      }
    }
    summary.readbackPassed = true
    summary.stage = 'complete'
  } catch (error) {
    if (typeof error.cdpMethod === 'string') {
      summary.cdpMethod = error.cdpMethod
      summary.cdpCode = error.cdpCode
    }
    summary.failure = /^test[.]formal_ui_[a-z_]+$/.test(error.message)
      ? error.message
      : code('unexpected_diagnostic_failure')
  } finally {
    shell?.close()
    browser?.close()
    await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2))
    console.log(JSON.stringify(summary))
  }
  if (!summary.readbackPassed) process.exitCode = 1
}

async function run(input) {
  const runId = randomUUID()
  const directory = path.join(input.output, runId)
  await mkdir(directory)
  assertPrivateDirectory(directory)
  const summary = {
    runId,
    expectedVersion: input.version,
    kind: 'installed-formal-functional-recovery',
    stage: 'connect-cdp',
    functionalPassed: false,
    compositorFrameAcceptance: false,
    latencyAcceptance: false,
    account: false,
    ssh: false,
    lan: false
  }
  let shell, browser, beforeAccount
  try {
    const targetResponse = await fetch(`http://127.0.0.1:${input.port}/json/list`)
    if (!targetResponse.ok) fail('target_inventory_unavailable')
    const targets = await targetResponse.json()
    const pages = targets.filter(
      (target) =>
        target.type === 'page' &&
        target.url?.startsWith('dsh-app://') &&
        target.webSocketDebuggerUrl
    )
    if (pages.length !== 1) fail('exact_formal_shell_required')
    const versionInfo = await (await fetch(`http://127.0.0.1:${input.port}/json/version`)).json()
    if (!versionInfo.webSocketDebuggerUrl) fail('browser_observation_endpoint_required')
    shell = await connectCdp(pages[0].webSocketDebuggerUrl)
    browser = await connectCdp(versionInfo.webSocketDebuggerUrl)
    await shell.send('Page.bringToFront')
    await shell.send('Runtime.enable')
    await shell.send('Page.enable')
    summary.stage = 'account'
    await click(shell, selector('nav-remote'))
    await click(shell, selector('remote-tab-account'))
    beforeAccount = await waitFor(
      shell,
      (source) => {
        const state = (0, eval)(`(${source})`)()
        return state.signedIn &&
          state.equal &&
          state.serviceGateAbsent &&
          state.refreshEnabled &&
          state.selectedNetwork
          ? state
          : null
      },
      [accountState.toString()]
    )
    requireCondition(beforeAccount.version === input.version, 'exact_version_required')
    requireCondition(/^[a-f0-9]{12}$/.test(beforeAccount.device), 'existing_device_required')
    await click(shell, selector('p2p-account-read-user'), selector('p2p-account-panel'))
    const afterRefresh = await waitFor(
      shell,
      (source) => {
        const state = (0, eval)(`(${source})`)()
        if (!state.refreshEnabled) return null
        if (!state.errorAbsent) return { failed: 'account_refresh_failed' }
        return state.signedIn && state.equal ? state : null
      },
      [accountState.toString()]
    )
    const accountTrace = await readTrace(shell)
    requireCondition(
      accountTrace.some((event) => event.disabled),
      'account_request_cycle_unobserved'
    )
    requireCondition(afterRefresh.user === beforeAccount.user, 'account_identity_changed')
    requireCondition(afterRefresh.device === beforeAccount.device, 'device_identity_changed')
    await capture(shell, directory, 'account', { state: afterRefresh, trace: accountTrace })
    summary.account = true

    summary.stage = 'ssh'
    await click(shell, selector('remote-tab-connect'))
    const sshOptions = await waitFor(shell, () => {
      const rows = Array.from(document.querySelectorAll('.remote-computer-row')).map((row) => ({
        id: row.querySelector('[data-testid^="remote-open-workbench-"]')?.dataset.testid,
        label: row.querySelector('.remote-computer-title strong')?.textContent?.trim() ?? ''
      }))
      return rows.length > 0 && rows.every((row) => row.id) ? rows : null
    }, [])
    const ssh = chooseObserved(sshOptions, input.sshLabel, 'ssh')
    const connectionId = ssh.id.slice('remote-open-workbench-'.length)
    const row = `.remote-computer-row:has(${selector(ssh.id)})`
    const current = await evaluate(
      shell,
      (row) => document.querySelector(`${row} .remote-status`)?.dataset.state,
      [row]
    )
    if (current === 'connecting') fail('ssh_preexisting_operation_in_progress')
    summary.sshReusedReady = input.reuseReady && current === 'ready'
    let sshTestTrace = []
    if (!summary.sshReusedReady) {
      if (current === 'ready') {
        await click(shell, `${row} .remote-row-actions > button:not([data-testid])`, row)
        await waitFor(
          shell,
          (row) =>
            document.querySelector(`${row} .remote-status`)?.dataset.state === 'disconnected',
          [row]
        )
      }
      await click(shell, `${row} ${selector('remote-test-connection')}`, row)
      await waitFor(
        shell,
        (row) => {
          const state = document.querySelector(`${row} .remote-test-status`)?.dataset.state
          if (state === 'failed') return { failed: 'ssh_test_failed' }
          return state === 'passed'
        },
        [row]
      )
      sshTestTrace = await readTrace(shell)
      requireCondition(
        sshTestTrace.some((event) => event.states.includes('testing')),
        'ssh_test_cycle_unobserved'
      )
      await click(
        shell,
        `${row} .remote-row-actions > button.prototype-button--primary:not([data-testid])`,
        row
      )
      await waitFor(
        shell,
        (row) => {
          const state = document.querySelector(`${row} .remote-status`)?.dataset.state
          if (state === 'failed') return { failed: 'ssh_connect_failed' }
          return state === 'ready'
        },
        [row]
      )
    }
    await capture(shell, directory, 'ssh-ready', {
      testTrace: sshTestTrace,
      trace: await readTrace(shell)
    })
    await click(shell, selector(ssh.id))
    summary.sshWorkbench = await verifyWorkbench(
      shell,
      browser,
      pages[0].id,
      `remote:${connectionId}`,
      directory,
      'ssh'
    )
    summary.ssh = true

    summary.stage = 'lan'
    await click(shell, selector('nav-runtime'))
    const existing = await evaluate(shell, () =>
      Array.from(document.querySelectorAll('[data-testid^="runtime-tab-peer:"]')).map((node) => ({
        id: node.dataset.testid,
        label: node.querySelector('.browser-tab-title')?.textContent?.trim() ?? '',
        ready: node.closest('.browser-tab')?.dataset.state === 'ready'
      }))
    )
    const reusable = input.reuseReady ? existing.filter((tab) => tab.ready) : []
    let peerId
    summary.lanReusedReady = reusable.length > 0
    if (summary.lanReusedReady) {
      const tab = chooseObserved(reusable, input.peerLabel, 'existing_lan')
      peerId = tab.id.slice('runtime-tab-peer:'.length)
      await click(shell, selector(tab.id))
    } else {
      if (existing.length > 0) {
        const tab = chooseObserved(existing, input.peerLabel, 'existing_lan')
        await click(shell, selector(tab.id.replace('runtime-tab-', 'runtime-tab-close-')))
      }
      await click(shell, selector('runtime-add-tab'))
      const peerOptions = await waitFor(shell, () => {
        const options = Array.from(document.querySelectorAll('[data-testid^="runtime-add-peer-"]'))
          .filter((node) => !node.disabled)
          .map((node) => ({
            id: node.dataset.testid,
            label: node.querySelector('strong')?.textContent?.trim() ?? ''
          }))
        return options.length > 0 ? options : null
      }, [])
      const peer = chooseObserved(peerOptions, input.peerLabel, 'lan')
      peerId = peer.id.slice('runtime-add-peer-'.length)
      await capture(shell, directory, 'lan-selection', { selected: peer.id })
      await click(shell, selector(peer.id))
    }
    summary.lanWorkbench = await verifyWorkbench(
      shell,
      browser,
      pages[0].id,
      `peer:${peerId}`,
      directory,
      'lan'
    )
    summary.lan = true

    summary.stage = 'final-account'
    await click(shell, selector('nav-remote'))
    await click(shell, selector('remote-tab-account'))
    const finalAccount = await evaluate(shell, accountState)
    requireCondition(finalAccount.user === beforeAccount.user, 'final_account_identity_changed')
    requireCondition(finalAccount.device === beforeAccount.device, 'final_device_identity_changed')
    requireCondition(
      finalAccount.selectedNetwork === beforeAccount.selectedNetwork,
      'selected_network_changed'
    )
    requireCondition(
      finalAccount.signedIn && finalAccount.equal && finalAccount.errorAbsent,
      'final_account_not_ready'
    )
    await capture(shell, directory, 'final-account', finalAccount)
    summary.originalAccountRetained = true
    summary.originalDeviceRetained = true
    summary.originalNetworkSelectionRetained = true
    summary.functionalPassed = true
    summary.stage = 'complete'
  } catch (error) {
    if (typeof error.cdpMethod === 'string') {
      summary.cdpMethod = error.cdpMethod
      summary.cdpCode = error.cdpCode
    }
    summary.failure = /^test[.]formal_ui_[a-z_]+$/.test(error.message)
      ? error.message
      : code('unexpected_diagnostic_failure')
    if (shell)
      await capture(shell, directory, 'failure', { failure: summary.failure }).catch(
        () => undefined
      )
  } finally {
    if (shell) {
      await evaluate(shell, () => window.__formalRecoveryTrace?.stop()).catch(() => undefined)
      shell.close()
    }
    browser?.close()
    await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2))
    console.log(JSON.stringify(summary))
  }
  if (!summary.functionalPassed) process.exitCode = 1
}

try {
  const input = await inputs()
  if (input) await (input.observeExisting ? observeExisting(input) : run(input))
} catch (error) {
  console.error(
    /^test[.]formal_ui_[a-z_]+$/.test(error.message) ? error.message : code('startup_failed')
  )
  process.exitCode = 1
}
