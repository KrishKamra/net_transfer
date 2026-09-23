import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(here, '../../../docs/screenshots')
const base = process.env.NT_WEB || 'http://127.0.0.1:3000'
const user = process.env.NT_USER || 'labshot'
const pass = process.env.NT_PASS || 'lab-pass-9'
const uploadName = 'lab_notes.bin'

await mkdir(outDir, { recursive: true })
const payload = Buffer.alloc(256 * 1024, 0x5a)
const uploadPath = path.join(os.tmpdir(), uploadName)
await writeFile(uploadPath, payload)

const browser = await chromium.launch({ headless: true })
const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })

async function shot(page, name) {
  const file = path.join(outDir, name)
  await page.screenshot({ path: file, fullPage: false })
  console.log(file)
}

try {
  await desktop.goto(base, { waitUntil: 'networkidle' })
  await desktop.getByRole('heading', { name: 'Sign in' }).waitFor()
  await shot(desktop, 'sign-in-desktop.png')

  await desktop.getByRole('button', { name: 'Create account', exact: true }).click()
  await desktop.getByRole('heading', { name: 'Create account' }).waitFor()
  await desktop.waitForTimeout(350)
  await shot(desktop, 'create-account-desktop.png')

  await desktop.getByRole('button', { name: 'Sign in', exact: true }).click()
  await desktop.getByRole('heading', { name: 'Sign in' }).waitFor()
  await desktop.locator('input[name="username"]').fill(user)
  await desktop.locator('input[name="password"]').fill(pass)
  await desktop.locator('button[type="submit"]').click()
  await desktop.getByRole('heading', { name: 'Transfers' }).waitFor()
  await desktop.getByText('Live', { exact: true }).waitFor({ timeout: 10000 })
  await shot(desktop, 'sandbox-empty-desktop.png')

  await desktop.keyboard.press('Control+K')
  await desktop.getByPlaceholder('Type a command').waitFor()
  await shot(desktop, 'commands-desktop.png')
  await desktop.keyboard.press('Escape')

  await desktop.locator('input[type="file"]').setInputFiles(uploadPath)
  await desktop.getByText(/STOR on TCP 2121\.|STOR complete/).first().waitFor({ timeout: 20000 })
  await shot(desktop, 'upload-desktop.png')
  await desktop.getByText(/STOR complete/).waitFor({ timeout: 20000 })
  await shot(desktop, 'upload-complete-desktop.png')

  await desktop.getByRole('rowheader', { name: uploadName }).waitFor({ timeout: 10000 })
  await shot(desktop, 'sandbox-file-desktop.png')

  const download = desktop.waitForEvent('download')
  await desktop.getByRole('button', { name: 'Download' }).click()
  await desktop.getByText(/RETR complete/).waitFor({ timeout: 20000 })
  await shot(desktop, 'download-desktop.png')
  const saved = await download
  await saved.cancel().catch(() => {})

  await desktop.getByRole('region', { name: 'Recorded transfers' }).scrollIntoViewIfNeeded()
  await shot(desktop, 'history-desktop.png')

  await desktop.setViewportSize({ width: 390, height: 844 })
  await desktop.waitForTimeout(250)
  await shot(desktop, 'sandbox-mobile.png')
  await desktop.getByRole('button', { name: 'Sign out' }).click()
  await desktop.getByRole('heading', { name: 'Sign in' }).waitFor()
  await shot(desktop, 'sign-in-mobile.png')

  console.log('CAPTURE_OK')
} finally {
  await browser.close()
}
