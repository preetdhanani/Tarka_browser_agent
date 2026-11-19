/**
 * Temporary UI preview: the side panel document at Chrome's side-panel width, idle, so the
 * header, composer, Settings, Logs, and Custom Model API dialog can be inspected across light,
 * dark, and narrow (320px) layouts without running a full model task. Not part of the suite.
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROMIUM = process.env.CHROMIUM_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const extensionPath = path.resolve('dist');
const profile = fs.mkdtempSync('/tmp/tarka-preview-');
const out = path.resolve('tests/e2e/screenshots/ui-preview');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROMIUM,
  headless: false,
  userDataDir: profile,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--window-size=440,980',
    '--no-first-run',
    '--no-default-browser-check'
  ],
  defaultViewport: { width: 360, height: 820, deviceScaleFactor: 2 }
});

try {
  const target = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 15000 }
  );
  const extensionId = new URL(target.url()).host;

  const pageErrors = [];

  async function openPanel(scheme, width = 360, height = 820) {
    const page = await browser.newPage();
    page.on('pageerror', (err) => pageErrors.push(`pageerror: ${err?.message || err}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
    });
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.evaluateOnNewDocument(() => {
      const original = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (queryInfo, cb) => {
        if (queryInfo && queryInfo.active && queryInfo.currentWindow && typeof cb === 'function') {
          return original({}, (tabs) => cb((tabs || []).filter((t) => t.url && !t.url.startsWith('chrome-extension://'))));
        }
        return original(queryInfo, cb);
      };
    });
    await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 900));
    return page;
  }

  async function shot(name, scheme, width = 360) {
    const page = await openPanel(scheme, width);
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: false });

    if (scheme === 'light') {
      await page.click('#btnApprovalMode');
      await new Promise((r) => setTimeout(r, 250));
      await page.screenshot({ path: path.join(out, `${name}-approval-menu.png`), fullPage: false });
      await page.keyboard.press('Escape');
      await page.click('#btnEffort');
      await new Promise((r) => setTimeout(r, 250));
      await page.screenshot({ path: path.join(out, `${name}-effort-menu.png`), fullPage: false });
      await page.keyboard.press('Escape');
      await page.click('#btnToggleHistory');
      await new Promise((r) => setTimeout(r, 350));
      await page.screenshot({ path: path.join(out, `${name}-history.png`), fullPage: false });
      const closeBtn = await page.$('#btnCloseHistory');
      if (closeBtn) { await closeBtn.click(); await new Promise((r) => setTimeout(r, 250)); }
      await page.click('#composerModel');
      await new Promise((r) => setTimeout(r, 500));
      await page.screenshot({ path: path.join(out, `${name}-model-menu.png`), fullPage: false });
      await page.keyboard.press('Escape');

      await page.focus('#taskInput');
      await page.type('#taskInput', 'Take the number of certifications you gave me in your last answer, multiply it by 7, and reply with the exact result only without extra notes.');
      await new Promise((r) => setTimeout(r, 150));
      const metrics = await page.$eval('#taskInput', (el) => ({
        height: Math.round(el.getBoundingClientRect().height),
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop
      }));
      console.log(`${name} multiline metrics:`, JSON.stringify(metrics));
      if (metrics.height <= 65 || metrics.scrollTop !== 0 || metrics.scrollHeight > metrics.clientHeight + 2) {
        pageErrors.push(`${name} multiline composer unexpected metrics: ${JSON.stringify(metrics)}`);
      }
      await page.screenshot({ path: path.join(out, `${name}-multiline.png`), fullPage: false });
    }
    await page.close();

    const settingsPage = await openPanel(scheme, width);
    await settingsPage.click('.nav-btn[data-tab="settings"]');
    await new Promise((r) => setTimeout(r, 400));
    await settingsPage.screenshot({ path: path.join(out, `${name}-settings.png`), fullPage: false });
    await settingsPage.close();
  }

  await shot('idle-light', 'light', 360);
  await shot('idle-dark', 'dark', 360);
  await shot('idle-narrow', 'light', 320);

  // Inspect Custom model API dialog (360 light/dark + 320 narrow) and custom provider Settings row
  for (const [label, scheme, width] of [['light', 'light', 360], ['dark', 'dark', 360], ['narrow', 'light', 320]]) {
    const dlgPage = await openPanel(scheme, width);
    await dlgPage.click('.nav-btn[data-tab="settings"]');
    await dlgPage.waitForSelector('#providerSelect', { visible: true, timeout: 5000 });
    await dlgPage.select('#providerSelect', '__custom_provider__');
    await dlgPage.waitForSelector('#cpOverlay', { visible: true, timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    await dlgPage.screenshot({ path: path.join(out, `cp-dialog-${label}.png`), fullPage: false });
    await dlgPage.close();
  }

  // Seed a custom provider and toggle Developer mode ON to inspect read-only Base URL, side-by-side actions, and Logs tab
  const seedPage = await openPanel('light', 360);
  await seedPage.evaluate(async () => {
    await chrome.storage.local.set({
      agent_settings: {
        provider: 'acme-relay',
        baseUrl: 'https://relay.example.com/v1',
        apiKey: 'sk-preview-123456',
        model: 'relay-70b',
        developerMode: false,
        customProviders: {
          'acme-relay': {
            id: 'acme-relay',
            displayName: 'Acme Relay',
            protocol: 'openai',
            baseUrl: 'https://relay.example.com/v1',
            models: ['relay-70b'],
            keyMode: 'apiKey',
            createdAt: 1,
            updatedAt: 1
          }
        },
        providerConfigs: {
          'acme-relay': {
            baseUrl: 'https://relay.example.com/v1',
            apiKey: 'sk-preview-123456',
            model: 'relay-70b'
          }
        }
      }
    });
  });
  await seedPage.close();

  for (const scheme of ['light', 'dark']) {
    const customPage = await openPanel(scheme, 360);
    await customPage.click('.nav-btn[data-tab="settings"]');
    await new Promise((r) => setTimeout(r, 400));
    const devChecked = await customPage.$eval('#btnDeveloperMode', (el) => el.getAttribute('aria-checked') === 'true');
    if (!devChecked && scheme === 'light') {
      await customPage.click('#btnDeveloperMode');
      await new Promise((r) => setTimeout(r, 300));
    }
    await customPage.screenshot({ path: path.join(out, `settings-custom-${scheme}.png`), fullPage: false });
    await customPage.click('.nav-btn[data-tab="logs"]');
    await new Promise((r) => setTimeout(r, 300));
    await customPage.screenshot({ path: path.join(out, `logs-${scheme}.png`), fullPage: false });
    await customPage.close();
  }

  if (pageErrors.length > 0) {
    throw new Error(`Side panel logged errors:\n${pageErrors.join('\n')}`);
  }
  console.log(`preview written to ${out}`);
} finally {
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
