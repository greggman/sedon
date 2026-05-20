// Repro the "Destroyed texture used in submit" on tree-bush → forest switch.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
console.log('dev server:', server.url);

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});
const page = await browser.newPage();
const errors = [];
const warnings = [];
const logs = [];
page.on('console', async (msg) => {
  const type = msg.type();
  const parts = await Promise.all(
    msg.args().map(async (arg) => {
      try { return await arg.evaluate((v) => (typeof v === 'string' ? v : JSON.stringify(v))); }
      catch { return String(arg); }
    }),
  );
  const text = parts.join(' ');
  if (type === 'error') errors.push(text);
  else if (type === 'warning') warnings.push(text);
  else logs.push(`[${type}] ${text}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

// Capture stack at each submit + correlate with async uncaptured errors.
await page.evaluate(() => {
  const wait = () => new Promise((r) => {
    const check = () => {
      const dev = window.__sedonStore__.getState().device;
      if (dev) return r(dev);
      setTimeout(check, 50);
    };
    check();
  });
  globalThis.__submitLog__ = [];
  globalThis.__uncapturedErrors__ = [];
  globalThis.__destroyLog__ = [];
  globalThis.__createTexLog__ = [];

  wait().then((dev) => {
    const origSubmit = dev.queue.submit.bind(dev.queue);
    dev.queue.submit = (...args) => {
      const st = new Error('submit').stack;
      globalThis.__submitLog__.push({ t: performance.now(), stack: st });
      return origSubmit(...args);
    };

    // Intercept every GPUTexture.destroy to record who destroyed it +
    // when. Patch the prototype so all textures (existing + future) are
    // captured.
    const proto = Object.getPrototypeOf(dev.createTexture({
      size: [1], format: 'rgba8unorm', usage: 1,
    }));
    const origDestroy = proto.destroy;
    let texCounter = 0;
    const origCreateTex = dev.createTexture.bind(dev);
    dev.createTexture = (desc) => {
      const t = origCreateTex(desc);
      t.__id__ = ++texCounter;
      t.__desc__ = JSON.parse(JSON.stringify(desc));
      t.__alive__ = true;
      globalThis.__createTexLog__.push({ id: t.__id__, w: desc.size?.[0] ?? desc.size?.width, h: desc.size?.[1] ?? desc.size?.height, format: desc.format, t: performance.now() });
      return t;
    };
    proto.destroy = function () {
      this.__alive__ = false;
      globalThis.__destroyLog__.push({
        id: this.__id__,
        w: this.__desc__?.size?.[0] ?? this.__desc__?.size?.width,
        h: this.__desc__?.size?.[1] ?? this.__desc__?.size?.height,
        format: this.__desc__?.format,
        t: performance.now(),
      });
      return origDestroy.call(this);
    };

    // Patch createBindGroup to record which texture ids each bind
    // group references, so when a submit fails we can correlate the
    // failure to the most-recent bind group it might have been built
    // against. Helpful but heavy; only patch the device's
    // createBindGroup.
    let bgCounter = 0;
    globalThis.__bgIndex__ = new Map(); // bgId -> { texIds, builtAt, builtFromAlive }
    const origCreateBG = dev.createBindGroup.bind(dev);
    dev.createBindGroup = (desc) => {
      const bg = origCreateBG(desc);
      const id = ++bgCounter;
      const texIds = [];
      let allAlive = true;
      for (const e of desc.entries ?? []) {
        const r = e.resource;
        if (r && r.__id__ !== undefined) { texIds.push(r.__id__); if (!r.__alive__) allAlive = false; }
        else if (r && r.texture && r.texture.__id__ !== undefined) { texIds.push(r.texture.__id__); if (!r.texture.__alive__) allAlive = false; }
      }
      bg.__id__ = id;
      bg.__texIds__ = texIds;
      bg.__builtAt__ = performance.now();
      bg.__builtFromAlive__ = allAlive;
      const stack = !allAlive
        ? new Error('createBindGroup-with-destroyed-tex').stack
        : undefined;
      globalThis.__bgIndex__.set(id, { id, texIds, builtAt: bg.__builtAt__, builtFromAlive: allAlive, stack });
      return bg;
    };

    dev.addEventListener?.('uncapturederror', (ev) => {
      const recent = globalThis.__submitLog__.slice(-2);
      const recentBGs = [...globalThis.__bgIndex__.values()].slice(-20);
      // Extract the size from "(unlabeled 512x512 px, ...)" so we
      // can correlate to which texture id matches.
      const msg = ev.error?.message ?? String(ev);
      const sizeMatch = msg.match(/(\d+)x(\d+)\s+px/);
      const w = sizeMatch ? Number(sizeMatch[1]) : null;
      // Filter destroys + bind groups by that size.
      const matchingDestroys = w
        ? globalThis.__destroyLog__.filter((d) => d.w === w)
        : globalThis.__destroyLog__;
      const matchingBGs = w
        ? recentBGs.filter((bg) => bg.texIds.some((id) => {
            const e = globalThis.__createTexLog__.find((c) => c.id === id);
            return e?.w === w;
          }))
        : recentBGs;
      // For each destroyed texture id, look up when it was created.
      const destroyedIdsInfo = new Map();
      for (const d of matchingDestroys) {
        const c = globalThis.__createTexLog__.find((x) => x.id === d.id);
        if (c) destroyedIdsInfo.set(d.id, { createdAt: c.t, destroyedAt: d.t, w: c.w, h: c.h, format: c.format });
      }
      globalThis.__uncapturedErrors__.push({
        msg,
        t: performance.now(),
        recentSubmits: recent,
        matchingDestroys,
        matchingBGs,
        destroyedIdsInfo: [...destroyedIdsInfo.values()],
        switchTime: globalThis.__switchT__ ?? null,
      });
    });
  });
});

// === Step 1: load tree-bush ===
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'tree-bush');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 4000));
console.log('after tree-bush:', errors.length, 'errors,', warnings.length, 'warnings');

const errorsBefore = errors.length;

// === Step 2: switch to forest ===
await page.evaluate(() => {
  globalThis.__switchT__ = performance.now();
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 4000));
console.log('after forest:  ', errors.length, 'errors,', warnings.length, 'warnings');

const captured = await page.evaluate(() => globalThis.__uncapturedErrors__);

await browser.close();
await server.stop();

console.log('\n========== UNCAPTURED ERROR + CONTEXT ==========');
for (const c of captured.slice(0, 1)) {
  console.log('msg:', c.msg);
  console.log('error t:', c.t.toFixed(2));
  console.log(`switch t = ${c.switchTime?.toFixed(2) ?? 'n/a'} (forest demo loaded at this time)`);
  console.log(`destroys MATCHING the error's size (all so far):`);
  for (const d of c.matchingDestroys) {
    console.log(`  id=${d.id} ${d.w}x${d.h} ${d.format}  t=${d.t.toFixed(2)}`);
  }
  console.log(`creation info for those destroyed textures:`);
  for (const info of c.destroyedIdsInfo) {
    const era = c.switchTime !== null
      ? (info.createdAt < c.switchTime ? 'TREE-BUSH (pre-switch)' : 'FOREST (post-switch)')
      : '?';
    console.log(`  ${info.w}x${info.h} ${info.format}  created=${info.createdAt.toFixed(2)} destroyed=${info.destroyedAt.toFixed(2)}  era=${era}`);
  }
  console.log(`recent BIND GROUPS referencing a texture of matching size:`);
  for (const bg of c.matchingBGs) {
    console.log(`  bg#${bg.id} builtAt=${bg.builtAt.toFixed(2)} builtFromAlive=${bg.builtFromAlive} texIds=${bg.texIds.join(',')}`);
    if (bg.stack) {
      const lines = bg.stack.split('\n').slice(1, 12).map((l) => l.trim());
      for (const line of lines) console.log('    ' + line);
    }
  }
  console.log('recent submits:');
  for (const s of c.recentSubmits) {
    console.log(`  t=${s.t.toFixed(2)}`);
    console.log('  ' + (s.stack ?? '').split('\n').slice(1, 10).join('\n  '));
  }
  console.log('======');
}
