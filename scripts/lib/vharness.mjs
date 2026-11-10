// Valley harness: Vite + installed Chrome (own temp profile) with WebGPU on the high-performance GPU, adapter and
// backend asserted (any real hardware GPU under WebGPU: never a software or fallback adapter, never a WebGL2
// fallback unless allowWebGL), adapter printed on every run, WGSL / pipeline errors fatal, teardown on every exit path.
import { createServer } from 'vite';
import { chromium } from 'playwright';

// `page` and `global` open another page of the project that sets window[global] = { ready, engine } (the gait lab).
export async function startValley({ width = 1920, height = 1080, query = '', timeout = 240000, allowWebGL = false, onLoading, page: pagePath = 'index.html', global: G = '__valley' } = {}) {
  let server, browser;
  const teardown = async (code, why) => {
    if (why) console.error('[teardown]', why);
    try { await browser?.close(); } catch {}
    try { await server?.close(); } catch {}
    if (code !== undefined) process.exit(code);
  };
  process.on('SIGINT', () => teardown(130, 'interrupted'));
  process.on('SIGTERM', () => teardown(143, 'terminated'));
  process.on('uncaughtException', (e) => teardown(1, e));
  process.on('unhandledRejection', (e) => teardown(1, e));

  server = await createServer({ server: { port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'warn', clearScreen: false });
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: [
      '--force-device-scale-factor=1', '--force_high_performance_gpu', '--enable-gpu', '--ignore-gpu-blocklist',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
      '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--mute-audio',
      ...(process.argv.includes('--uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
    ],
  });
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /WGSL|GPUValidationError|not available, running under WebGL2/i.test(t)) errors.push(t);
    if (process.env.VERBOSE || t.startsWith('[')) console.log('  [page]', t.slice(0, 400));
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });

  await page.goto(`${url}/${pagePath}?${query}`);
  const t0 = Date.now();
  for (;;) {
    const st = await page.evaluate((G) => ({ ready: !!window[G]?.ready, error: window[G]?.error, status: document.getElementById('load-status')?.textContent ?? document.getElementById('status')?.textContent }), G);
    if (st.error) { await teardown(); throw new Error('boot failed: ' + st.error); }
    if (st.ready) break;
    if (onLoading) await onLoading(page, Date.now() - t0);
    if (Date.now() - t0 > timeout) { await teardown(); throw new Error('boot timed out at: ' + st.status); }
    await page.waitForTimeout(500);
  }
  const gpu = await page.evaluate(async (G) => {
    const e = window[G].engine;
    const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    const i = a?.info ?? {};
    return { backend: e.backendName, adapter: { vendor: i.vendor, architecture: i.architecture, description: i.description, fallback: i.isFallbackAdapter } };
  }, G);
  console.log(`[gpu] backend ${gpu.backend} adapter ${JSON.stringify(gpu.adapter)}`);
  const desc = JSON.stringify(gpu.adapter);
  if ((!/webgpu/i.test(gpu.backend) && !allowWebGL) || /swiftshader|llvmpipe|software|basic render|"fallback":true/i.test(desc)) {
    await teardown();
    throw new Error(`not WebGPU on a hardware GPU: ${gpu.backend} ${desc}`);
  }
  console.log(`[valley] ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const assertClean = () => {
    const bad = errors.filter((e) => !/favicon|AudioContext|autoplay/i.test(e));
    if (bad.length) throw new Error('errors in the page:\n' + bad.slice(0, 12).join('\n'));
  };
  return { url, page, browser, server, teardown, errors, assertClean };
}
