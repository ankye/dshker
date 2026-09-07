import { app } from 'electron'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { PeerCredentialStore, type PeerCredential } from '../../electron/main/p2p/credentials'
import { PeerHelperError } from '../../electron/main/p2p/wire'

let stage = 'initialization'

async function main(): Promise<void> {
  const [root, phase, openssl] = process.argv.slice(2)
  assert(root && isAbsolute(root) && ['create', 'readback'].includes(phase))
  assert(openssl && isAbsolute(openssl), 'explicit OpenSSL with Ed25519 support required')
  await mkdir(join(root, 'electron'), { recursive: true })
  app.setPath('userData', join(root, 'electron'))
  await app.whenReady()
  const settings = join(root, 'settings')
  const store = new PeerCredentialStore(async () => settings)
  if (phase === 'create') {
    await mkdir(join(settings, 'dsh-launcher'), { recursive: true })
    stage = 'test-certificate'
    const credential = await makeCredential(root, openssl)
    stage = 'encrypted-create'
    const first = await store.create(credential)
    assert.deepEqual(first.credential, credential)
    const file = join(settings, 'dsh-launcher/p2p-credentials', credential.serviceId + '.json')
    const encrypted = await readFile(file, 'utf8')
    assert(!encrypted.includes(credential.privateKey) && !encrypted.includes('privateKey'))
    await assert.rejects(store.create(credential), code('p2p.credential_create_failed'))
    await assert.rejects(store.replace(credential, '0'.repeat(64)), code('p2p.credential_conflict'))
    const wrongKey = { ...credential, privateKey: randomBytes(64).toString('base64') }
    await assert.rejects(store.replace(wrongKey, first.revision), code('p2p.identity_mismatch'))
    assert.equal(await readFile(file, 'utf8'), encrypted)
    const changed = { ...credential, name: 'Credential persistence readback' }
    const second = await store.replace(changed, first.revision)
    assert.deepEqual(second.credential, changed)
    assert.notEqual(second.revision, first.revision)
    stage = 'public-oracle'
    await writeFile(
      join(root, 'oracle.json'),
      JSON.stringify({
        serviceId: changed.serviceId,
        deviceId: changed.deviceId,
        userId: changed.userId,
        name: changed.name,
        publicKey: changed.publicKey,
        revision: second.revision
      }),
      { mode: 0o600 }
    )
    stage = 'pending-enrollment-create'
    const pending = {
      serviceId: randomBytes(32).toString('hex'),
      requestId: randomBytes(16).toString('hex'),
      networkId: randomBytes(16).toString('hex'),
      userId: credential.userId,
      name: credential.name,
      publicKey: credential.publicKey,
      privateKey: credential.privateKey
    }
    const prepared = await store.prepareEnrollment(pending)
    assert.deepEqual(prepared.enrollment, pending)
    assert.deepEqual(await store.loadRegistration(pending.serviceId), {
      kind: 'pending',
      ...prepared
    })
    const pendingFile = join(settings, 'dsh-launcher/p2p-credentials', pending.serviceId + '.json')
    const pendingCiphertext = await readFile(pendingFile, 'utf8')
    assert(
      !pendingCiphertext.includes(pending.privateKey) && !pendingCiphertext.includes('privateKey')
    )
    await assert.rejects(store.prepareEnrollment(pending), code('p2p.credential_write_failed'))
    await assert.rejects(store.load(pending.serviceId), code('p2p.credential_invalid'))
    assert.equal(await readFile(pendingFile, 'utf8'), pendingCiphertext)
    const { privateKey: omitted, ...publicPending } = pending
    assert.equal(typeof omitted, 'string')
    await writeFile(
      join(root, 'pending-oracle.json'),
      JSON.stringify({
        ...publicPending,
        deviceId: credential.deviceId,
        certificate: credential.certificate,
        revision: prepared.revision
      }),
      { mode: 0o600 }
    )
  } else {
    stage = 'restart-readback'
    const expected = JSON.parse(await readFile(join(root, 'oracle.json'), 'utf8'))
    const loaded = await store.load(expected.serviceId)
    for (const field of ['serviceId', 'deviceId', 'userId', 'name', 'publicKey'] as const)
      assert.equal(loaded.credential[field], expected[field])
    assert.equal(loaded.revision, expected.revision)
    const file = join(settings, 'dsh-launcher/p2p-credentials', expected.serviceId + '.json')
    const encrypted = await readFile(file, 'utf8')
    await writeFile(file, '{"version":999}\n')
    await assert.rejects(store.load(expected.serviceId))
    assert.equal(
      await readFile(file, 'utf8'),
      '{"version":999}\n',
      'invalid record must not be reset'
    )
    // Restore only this test-owned ciphertext to continue the deletion scenario.
    await writeFile(file, encrypted)
    await assert.rejects(
      store.remove(expected.serviceId, '0'.repeat(64)),
      code('p2p.credential_conflict')
    )
    assert.equal((await store.load(expected.serviceId)).revision, expected.revision)
    await store.remove(expected.serviceId, expected.revision)
    await assert.rejects(store.load(expected.serviceId), code('p2p.credential_unavailable'))
    stage = 'pending-enrollment-restart'
    const pendingExpected = JSON.parse(await readFile(join(root, 'pending-oracle.json'), 'utf8'))
    const pendingLoaded = await store.loadPendingEnrollment(pendingExpected.serviceId)
    for (const field of [
      'serviceId',
      'requestId',
      'networkId',
      'userId',
      'name',
      'publicKey'
    ] as const)
      assert.equal(pendingLoaded.enrollment[field], pendingExpected[field])
    assert.equal(pendingLoaded.revision, pendingExpected.revision)
    const issued: PeerCredential = {
      serviceId: pendingExpected.serviceId,
      userId: pendingExpected.userId,
      name: pendingExpected.name,
      deviceId: pendingExpected.deviceId,
      certificate: pendingExpected.certificate,
      publicKey: pendingExpected.publicKey,
      privateKey: pendingLoaded.enrollment.privateKey
    }
    await assert.rejects(
      store.completeEnrollment(issued, '0'.repeat(64)),
      code('p2p.credential_conflict')
    )
    await assert.rejects(
      store.completeEnrollment({ ...issued, userId: 'f'.repeat(32) }, pendingLoaded.revision),
      code('p2p.credential_conflict')
    )
    await assert.rejects(
      store.completeEnrollment({ ...issued, name: 'wrong request name' }, pendingLoaded.revision),
      code('p2p.credential_conflict')
    )
    assert.deepEqual(await store.loadPendingEnrollment(issued.serviceId), pendingLoaded)
    const completed = await store.completeEnrollment(issued, pendingLoaded.revision)
    assert.deepEqual(completed.credential, issued)
    assert.deepEqual(await store.loadRegistration(issued.serviceId), {
      kind: 'registered',
      ...completed
    })
    assert.deepEqual(await store.load(issued.serviceId), completed)
    await assert.rejects(
      store.loadPendingEnrollment(issued.serviceId),
      code('p2p.enrollment_state_mismatch')
    )
    await assert.rejects(
      store.prepareEnrollment(pendingLoaded.enrollment),
      code('p2p.credential_write_failed')
    )
    assert.deepEqual(await store.load(issued.serviceId), completed)
    await store.remove(issued.serviceId, completed.revision)
  }
  console.log(
    JSON.stringify({
      classification: 'diagnostic',
      realElectronSafeStorage: true,
      phase,
      passed: true
    })
  )
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof PeerHelperError && error.code === expected
}

async function makeCredential(root: string, openssl: string): Promise<PeerCredential> {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const seed = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  const deviceId = randomBytes(16).toString('hex')
  const keyFile = join(root, 'test-signing-key.pem')
  await writeFile(keyFile, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    mode: 0o600
  })
  try {
    // Test-only self-signed identity exercises storage; coordinator trust and
    // authorization are separately validated by the production Go client.
    const { stdout } = await promisify(execFile)(openssl, [
      'req',
      '-new',
      '-x509',
      '-key',
      keyFile,
      '-subj',
      '/CN=' + deviceId,
      '-days',
      '1'
    ])
    const certificate = new X509Certificate(stdout)
    return {
      serviceId: randomBytes(32).toString('hex'),
      deviceId,
      userId: randomBytes(16).toString('hex'),
      name: 'Credential diagnostic',
      privateKey: Buffer.concat([seed, publicKey]).toString('base64'),
      publicKey: publicKey.toString('base64'),
      certificate: certificate.raw.toString('base64')
    }
  } finally {
    seed.fill(0)
    await unlink(keyFile)
  }
}

void main().then(
  () => app.exit(0),
  (error: unknown) => {
    // Never print assertion objects, credentials, ciphertext, or native errors.
    console.error(
      JSON.stringify({
        stage,
        error: error instanceof PeerHelperError ? error.code : 'diagnostic_failed'
      })
    )
    app.exit(1)
  }
)
