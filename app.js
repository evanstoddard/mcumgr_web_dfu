import { SmpSerial, SmpTimeout } from './smp.js';
import { parseImage, listZip, hex } from './image.js';

const $ = (id) => document.getElementById(id);
const els = {
  unsupported: $('unsupported'), connect: $('connect'), disconnect: $('disconnect'),
  status: $('status'), autoReconnect: $('auto-reconnect'),
  refresh: $('refresh'), echo: $('echo'), reset: $('reset'), erase: $('erase'), slots: $('slots'),
  file: $('file'), zipPick: $('zip-pick'), zipEntry: $('zip-entry'), imgInfo: $('img-info'),
  mtu: $('mtu'), lineDelay: $('line-delay'), after: $('after'), resetAfter: $('reset-after'),
  upload: $('upload'), cancel: $('cancel'), progress: $('progress'), progressText: $('progress-text'),
  log: $('log'), clearLog: $('clear-log'),
};

let userClosed = false;
let lastPort = null;
let lastInfo = null;
let reconnecting = false;
let probing = false;
let busy = false;
let abort = null;
let image = null; // { data, info, name }

function log(msg, cls = '') {
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  els.log.append(line);
  els.log.scrollTop = els.log.scrollHeight;
}

const smp = new SmpSerial({ log, onClose: onPortClosed });

function setStatus(text, state) {
  els.status.textContent = text;
  els.status.dataset.state = state;
}

function updateUi() {
  const on = smp.connected;
  els.connect.disabled = on || reconnecting;
  els.disconnect.disabled = !on && !reconnecting;
  for (const b of [els.refresh, els.echo, els.reset, els.erase]) b.disabled = !on || busy;
  els.upload.disabled = !on || busy || !image;
  els.cancel.disabled = !abort;
  els.slots.querySelectorAll('button').forEach((b) => { b.disabled = !on || busy; });
}

async function run(label, fn) {
  if (busy) return;
  busy = true; updateUi();
  try { return await fn(); }
  catch (e) { log(`${label} failed: ${e.message}`, 'err'); }
  finally { busy = false; updateUi(); }
}

// ---- connection ---------------------------------------------------------

async function connect() {
  let port;
  try { port = await navigator.serial.requestPort(); } catch { return; }
  try {
    await smp.open(port);
  } catch (e) {
    log(`open failed: ${e.message}`, 'err');
    return;
  }
  userClosed = false;
  lastPort = port;
  lastInfo = port.getInfo();
  onConnected();
}

function onConnected() {
  const i = lastInfo || {};
  setStatus(`Connected${i.usbVendorId ? ` (${i.usbVendorId.toString(16).padStart(4, '0')}:${i.usbProductId.toString(16).padStart(4, '0')})` : ''}`, 'on');
  log('connected', 'ok');
  updateUi();
  run('probe', async () => {
    try {
      await smp.echo('ping');
      log('echo ok', 'ok');
    } catch (e) {
      log(e instanceof SmpTimeout ? 'no SMP response - is this the SMP port and not a log/shell port?' : `echo failed: ${e.message}`, 'err');
      return;
    }
    await refreshSlots();
  });
}

async function disconnect() {
  userClosed = true;
  reconnecting = false;
  await smp.close();
  setStatus('Disconnected', 'off');
  updateUi();
}

function onPortClosed() {
  if (probing) return;
  els.slots.innerHTML = '';
  if (userClosed || !els.autoReconnect.checked) {
    setStatus('Disconnected', 'off');
    log('disconnected');
    updateUi();
    return;
  }
  log('device disconnected, waiting for it to come back...', 'warn');
  reconnectLoop();
}

// After a reset the USB device re-enumerates; Chrome keeps the permission, so
// poll the granted ports and probe each candidate with an echo.
async function reconnectLoop() {
  reconnecting = true;
  setStatus('Reconnecting...', 'wait');
  updateUi();
  const deadline = Date.now() + 30000;
  while (reconnecting && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    const ports = (await navigator.serial.getPorts()).filter((p) => {
      const i = p.getInfo();
      return !lastInfo?.usbVendorId || (i.usbVendorId === lastInfo.usbVendorId && i.usbProductId === lastInfo.usbProductId);
    });
    ports.sort((a, b) => (b === lastPort) - (a === lastPort));
    for (const port of ports) {
      if (!reconnecting) break;
      try { await smp.open(port); } catch { continue; }
      try {
        await smp.raw(2, 0, 0, { d: 'probe' }, 1000);
        reconnecting = false;
        lastPort = port;
        onConnected();
        return;
      } catch {
        probing = true; // this close is ours, not a device drop
        await smp.close();
        probing = false;
      }
    }
  }
  if (reconnecting) log('device did not come back within 30 s; click Connect', 'err');
  reconnecting = false;
  setStatus('Disconnected', 'off');
  updateUi();
}

// ---- device actions -----------------------------------------------------

function flagList(img) {
  return ['active', 'confirmed', 'pending', 'permanent', 'bootable'].filter((k) => img[k]);
}

async function refreshSlots() {
  const rsp = await smp.imageList();
  const images = rsp.images || [];
  els.slots.innerHTML = '';
  for (const img of images) {
    const tr = document.createElement('tr');
    const h = img.hash ? hex(img.hash) : '';
    const tags = flagList(img).map((f) => `<span class="tag tag-${f}">${f}</span>`).join(' ');
    tr.innerHTML = `<td>${img.image ?? 0}/${img.slot}</td><td>${img.version ?? ''}</td>
      <td>${tags}</td><td class="mono" title="${h}">${h.slice(0, 16)}${h ? '…' : ''}</td><td class="actions"></td>`;
    const actions = tr.querySelector('.actions');
    const btn = (text, fn, title) => {
      const b = document.createElement('button');
      b.textContent = text; b.title = title; b.className = 'small';
      b.onclick = () => run(text, async () => { await fn(); await refreshSlots(); });
      actions.append(b);
    };
    if (!img.active && img.hash) {
      btn('Test', () => smp.imageSet(img.hash, false), 'Boot this image once on next reset; reverts unless confirmed');
      btn('Confirm', () => smp.imageSet(img.hash, true), 'Make this image permanent on next reset');
    } else if (img.active && !img.confirmed) {
      btn('Confirm', () => smp.imageSet(img.hash, true), 'Confirm the running test image so it is not reverted');
    }
    els.slots.append(tr);
  }
  if (!images.length) els.slots.innerHTML = '<tr><td colspan="5" class="dim">no images reported</td></tr>';
  log(`slots: ${images.map((i) => `${i.slot}=${i.version}[${flagList(i).join(',')}]`).join('  ')}`);
}

els.connect.onclick = connect;
els.disconnect.onclick = disconnect;
els.refresh.onclick = () => run('image list', refreshSlots);
els.echo.onclick = () => run('echo', async () => {
  const t0 = performance.now();
  const r = await smp.echo('hello');
  log(`echo "${r.r}" in ${(performance.now() - t0).toFixed(1)} ms`, 'ok');
});
els.reset.onclick = () => run('reset', async () => {
  await smp.reset();
  log('reset requested', 'ok');
});
els.erase.onclick = () => run('erase', async () => {
  if (!confirm('Erase the secondary slot (slot 1)?')) return;
  await smp.imageErase(1);
  log('slot 1 erased', 'ok');
  await refreshSlots();
});
els.clearLog.onclick = () => { els.log.innerHTML = ''; };
els.lineDelay.onchange = () => { smp.lineDelayMs = Math.max(0, Number(els.lineDelay.value) || 0); };

// ---- image file ---------------------------------------------------------

async function useImage(data, name) {
  try {
    const info = parseImage(data);
    image = { data, info, name };
    els.imgInfo.innerHTML = `<b>${name}</b><br>version <b>${info.version}</b> · ${(info.size / 1024).toFixed(1)} KiB` +
      (info.hash ? `<br><span class="mono" title="${hex(info.hash)}">hash ${hex(info.hash).slice(0, 16)}…</span>` : '');
    els.imgInfo.classList.remove('err');
  } catch (e) {
    image = null;
    els.imgInfo.textContent = `${name}: ${e.message}`;
    els.imgInfo.classList.add('err');
  }
  updateUi();
}

els.file.onchange = async () => {
  const f = els.file.files[0];
  els.zipPick.hidden = true;
  image = null;
  if (!f) { els.imgInfo.textContent = ''; updateUi(); return; }
  const buf = new Uint8Array(await f.arrayBuffer());
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    let bins;
    try { bins = listZip(buf).filter((e) => e.name.endsWith('.bin')); }
    catch (e) { els.imgInfo.textContent = e.message; els.imgInfo.classList.add('err'); return; }
    if (!bins.length) { els.imgInfo.textContent = 'zip has no .bin files'; els.imgInfo.classList.add('err'); return; }
    els.zipEntry.innerHTML = '';
    bins.forEach((b, i) => els.zipEntry.add(new Option(b.name, i)));
    const pick = async () => useImage(await bins[els.zipEntry.value].read(), `${f.name} › ${bins[els.zipEntry.value].name}`);
    els.zipEntry.onchange = pick;
    els.zipPick.hidden = bins.length < 2;
    await pick();
  } else {
    await useImage(buf, f.name);
  }
};

// ---- upload -------------------------------------------------------------

function fmtTime(s) { return s < 60 ? `${s.toFixed(0)} s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`; }

els.upload.onclick = () => run('upload', async () => {
  const { data, info } = image;
  const mtu = Number(els.mtu.value) || 256;
  abort = new AbortController();
  updateUi();
  const t0 = performance.now();
  log(`uploading ${info.version} (${data.length} B, mtu ${mtu})`);
  try {
    await smp.upload(data, {
      mtu,
      signal: abort.signal,
      onProgress: (off, total) => {
        const pct = (100 * off) / total;
        const dt = (performance.now() - t0) / 1000;
        const rate = off / Math.max(dt, 0.001);
        els.progress.value = pct;
        els.progressText.textContent = `${pct.toFixed(1)}%  ${(rate / 1024).toFixed(1)} KiB/s` +
          (off && off < total ? `  ETA ${fmtTime((total - off) / rate)}` : '');
      },
    });
  } finally {
    abort = null;
  }
  log(`upload done in ${fmtTime((performance.now() - t0) / 1000)}`, 'ok');

  const action = els.after.value;
  if (action !== 'none') {
    const list = (await smp.imageList()).images || [];
    const target = info.hash
      ? list.find((i) => i.hash && hex(i.hash) === hex(info.hash))
      : list.find((i) => i.slot === 1);
    if (!target) throw new Error('uploaded image not found in slot list');
    if (target.active) {
      log('uploaded image is already the running image; nothing to mark', 'warn');
    } else {
      await smp.imageSet(target.hash, action === 'confirm');
      log(`marked slot ${target.slot} ${action === 'confirm' ? 'confirmed (permanent)' : 'test'}`, 'ok');
    }
  }
  await refreshSlots();
  if (els.resetAfter.checked && action !== 'none') {
    await smp.reset();
    log('reset requested', 'ok');
  }
});

els.cancel.onclick = () => abort?.abort();

// ---- init ---------------------------------------------------------------

if (!('serial' in navigator)) {
  els.unsupported.hidden = false;
  els.connect.disabled = true;
} else {
  smp.lineDelayMs = Number(els.lineDelay.value) || 0;
  navigator.serial.addEventListener('disconnect', (e) => { if (e.target === lastPort) log('USB port removed', 'dim'); });
  updateUi();
}
