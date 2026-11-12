(function () {
  'use strict';

  /* =========================================================
   * Armazenamento (tudo local, neste aparelho)
   * ========================================================= */
  const STORE_KEY = 'balanca:v1';
  const defaults = () => ({
    profile: { name: '', sex: '', birth: '', height: '', goal: '', waist: '' },
    settings: { fatOffset: 0, btMethod: 'auto', deviceId: '' },
    measurements: [], // {id, ts, weight, impedance, variant}
  });

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaults();
      const d = JSON.parse(raw);
      const base = defaults();
      return {
        profile: Object.assign(base.profile, d.profile),
        settings: Object.assign(base.settings, d.settings),
        measurements: Array.isArray(d.measurements) ? d.measurements : [],
      };
    } catch (e) {
      return defaults();
    }
  }
  let db = load();
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
    catch (e) { toast('Não foi possível salvar os dados neste aparelho.'); }
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  const sorted = () => db.measurements.slice().sort((a, b) => a.ts - b.ts);
  const profileForCalc = () => Object.assign({}, db.profile, { fatOffset: db.settings.fatOffset });
  const profileComplete = () => !!(db.profile.sex && db.profile.birth && Number(db.profile.height));

  /* =========================================================
   * Utilidades de UI
   * ========================================================= */
  const $ = (s) => document.querySelector(s);
  const fmt = (n, d = 1) => (n == null || !Number.isFinite(n) ? '--' : n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  function goto(view) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.goto === view));
    if (view === 'history') renderHistory();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => goto(b.dataset.goto)));

  /* =========================================================
   * Cartões de resultado
   * ========================================================= */
  function noteFor(r) {
    if (!r.complete) return 'Complete o perfil para ver os índices corporais.';
    if (!r.hasImpedance) return 'A balança não enviou impedância nesta pesagem, então os índices foram estimados pelo IMC. Suba descalço e fique parado até o fim para medir a bioimpedância.';
    return 'Peso e impedância são medidos; os demais índices são estimativas calculadas com equações científicas publicadas. Toque em um índice para ver como é calculado.';
  }

  // Medição de ~30 dias antes (no mínimo 5 dias), para a análise de tendência.
  function pastFor(m, list) {
    const older = list.filter((x) => x.ts <= m.ts - 5 * 86400000);
    if (!older.length) return null;
    const target = m.ts - 30 * 86400000;
    return older.reduce((a, b) => (Math.abs(b.ts - target) < Math.abs(a.ts - target) ? b : a));
  }

  function analysisFor(m) {
    const p = profileForCalc();
    const r = Body.compute(p, m);
    if (!r.complete) return { r, a: null };
    const pm = pastFor(m, sorted());
    const past = pm ? Body.compute(p, pm) : null;
    const days = pm ? Math.round((m.ts - pm.ts) / 86400000) : 0;
    return { r, a: Body.analyze(r, past, days) };
  }

  let currentResult = null;

  function renderLatest() {
    const list = sorted();
    $('#setupCard').hidden = profileComplete();
    $('#profileName').textContent = db.profile.name ? 'de ' + db.profile.name : '';
    const last = list[list.length - 1];
    if (!last) {
      ['#resultsTitle', '#scoreCard', '#analysisCard', '#metricsTitle', '#resultsNote'].forEach((s) => { $(s).hidden = true; });
      $('#results').innerHTML = '';
      return;
    }
    const { r, a } = analysisFor(last);
    currentResult = r;
    $('#resultsTitle').hidden = false;
    $('#resultsTitle').textContent = 'Última medição · ' + new Date(last.ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    $('#scoreCard').hidden = !a;
    $('#analysisCard').hidden = !a;
    if (a) {
      $('#scoreCard').innerHTML = Metrics.scoreHTML(r);
      $('#analysisCard').innerHTML = '<h2 class="card-title">Análise</h2>' + Metrics.analysisHTML(a);
    }
    $('#metricsTitle').hidden = false;
    $('#results').innerHTML = Metrics.cardsHTML(r);
    $('#resultsNote').hidden = false;
    $('#resultsNote').textContent = noteFor(r);
    if (state === 'idle') {
      setWeight(last.weight, 'done');
      showDelta(last, list[list.length - 2]);
    }
  }

  function showDelta(cur, prev) {
    const el = $('#deltaLine');
    el.className = 'delta';
    if (!cur || !prev) { el.textContent = ''; return; }
    const d = cur.weight - prev.weight;
    if (Math.abs(d) < 0.05) { el.textContent = 'Igual à pesagem anterior'; return; }
    el.classList.add(d < 0 ? 'down' : 'up');
    el.textContent = (d < 0 ? '▼ ' : '▲ ') + fmt(Math.abs(d), 2) + ' kg desde a pesagem anterior';
  }

  /* =========================================================
   * Bluetooth — leitura dos anúncios da balança
   * ========================================================= */
  let state = 'idle'; // idle | scanning | measuring | finalizing
  let leScan = null;
  let watchAbort = null;
  let watchedDevice = null;
  let recent = [];        // leituras recentes p/ detectar estabilidade
  let best = null;        // melhor leitura estável
  let finalizeTimer = null;
  let scanTimeout = null;
  let debugOn = false;

  function setWeight(kg, mode) {
    const el = $('#liveWeight');
    el.textContent = kg == null ? '--,-' : fmt(kg, kg >= 100 ? 1 : 2);
    el.className = 'weight' + (mode ? ' ' + mode : '');
  }
  function setStatus(html) { $('#statusLine').innerHTML = html; }
  function setButton() {
    const b = $('#btnWeigh');
    const active = state !== 'idle';
    b.textContent = active ? 'Parar' : 'Pesar';
    b.className = 'btn big ' + (active ? 'stop' : 'primary');
  }

  function showBtHelp(reason) {
    $('#btHelp').hidden = false;
    $('#btHelpReason').textContent = reason;
  }

  async function startWeigh() {
    $('#btHelp').hidden = true;
    if (!window.isSecureContext) {
      showBtHelp('O app precisa ser aberto por um endereço https:// para usar o Bluetooth.');
      return;
    }
    if (!navigator.bluetooth) {
      showBtHelp('Este navegador não tem Bluetooth web. Use o Google Chrome no Android.');
      return;
    }
    recent = []; best = null;
    const method = db.settings.btMethod;
    const errors = [];

    if (method === 'auto' || method === 'scan') {
      try { await startLEScan(); return began('scan'); }
      catch (e) { errors.push(e); if (isUserCancel(e)) return; }
    }
    if (method === 'auto' || method === 'device') {
      try { await startDeviceWatch(); return began('device'); }
      catch (e) { errors.push(e); if (isUserCancel(e)) return; }
    }
    stopWeigh(true);
    log('Falha ao iniciar: ' + errors.map((e) => e && (e.message || e)).join(' | '));
    showBtHelp('O Chrome não liberou a leitura dos sinais da balança (' + (errors[errors.length - 1]?.message || 'recurso desligado') + ').');
  }

  function isUserCancel(e) {
    if (e && e.name === 'NotFoundError' && /cancel/i.test(e.message || '')) {
      setStatus('Busca cancelada. Toque em <b>Pesar</b> para tentar de novo.');
      return true;
    }
    if (e && e.name === 'NotAllowedError') {
      setStatus('Permissão de Bluetooth negada. Toque em <b>Pesar</b> e permita o acesso.');
      return true;
    }
    return false;
  }

  async function startLEScan() {
    if (typeof navigator.bluetooth.requestLEScan !== 'function') throw new Error('requestLEScan indisponível');
    leScan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
    navigator.bluetooth.addEventListener('advertisementreceived', onAdvertisement);
  }

  async function startDeviceWatch() {
    if (typeof navigator.bluetooth.requestDevice !== 'function') throw new Error('requestDevice indisponível');
    let device = null;
    if (db.settings.deviceId && typeof navigator.bluetooth.getDevices === 'function') {
      try {
        const devices = await navigator.bluetooth.getDevices();
        device = devices.find((d) => d.id === db.settings.deviceId) || null;
      } catch (e) { /* segue para o seletor */ }
    }
    if (!device) {
      setStatus('Suba na balança para ela ligar e escolha <b>ADV</b>, <b>Chipsea-BLE</b> ou similar na lista.');
      device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalManufacturerData: OKOK.MANUFACTURER_IDS,
      });
    }
    if (typeof device.watchAdvertisements !== 'function') throw new Error('watchAdvertisements indisponível');
    watchedDevice = device;
    device.addEventListener('advertisementreceived', onAdvertisement);
    watchAbort = new AbortController();
    await device.watchAdvertisements({ signal: watchAbort.signal });
    db.settings.deviceId = device.id;
    save();
  }

  function began(how) {
    state = 'scanning';
    setButton();
    setWeight(null, 'live');
    $('#deltaLine').textContent = '';
    setStatus('Procurando a balança… <b>suba nela descalço</b> e fique parado.');
    log('Leitura iniciada (' + (how === 'scan' ? 'escuta geral' : 'balança escolhida') + ')');
    clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
      if (state === 'scanning') {
        stopWeigh(true);
        setStatus('A balança não foi encontrada. Suba nela para acordá-la e toque em <b>Pesar</b> de novo. Se persistir, veja o <b>Diagnóstico</b> no Perfil.');
      }
    }, 60000);
  }

  function stopWeigh(silent) {
    clearTimeout(finalizeTimer);
    clearTimeout(scanTimeout);
    if (leScan) { try { leScan.stop(); } catch (e) {} leScan = null; }
    if (navigator.bluetooth) navigator.bluetooth.removeEventListener('advertisementreceived', onAdvertisement);
    if (watchAbort) { watchAbort.abort(); watchAbort = null; }
    if (watchedDevice) { watchedDevice.removeEventListener('advertisementreceived', onAdvertisement); watchedDevice = null; }
    simStop();
    state = 'idle';
    setButton();
    if (!silent) {
      setStatus('Leitura parada.');
      renderLatest();
    }
  }

  function onAdvertisement(event) {
    const reading = OKOK.parseManufacturerData(event.manufacturerData);
    if (debugOn) logAdvertisement(event, reading);
    if (!reading || state === 'idle') return;
    onReading(reading, event.device);
  }

  function onReading(r, device) {
    if (state === 'scanning') {
      state = 'measuring';
      clearTimeout(scanTimeout);
      if (device && device.id && device.id !== 'sim') { db.settings.deviceId = device.id; save(); }
    }
    const now = Date.now();
    setWeight(r.weight, 'live');

    // Estabilidade: usa a flag da balança quando existe; senão, 3 leituras iguais em 1,5 s.
    recent.push({ t: now, w: r.weight });
    recent = recent.filter((x) => now - x.t < 4000);
    let stable = r.stable;
    if (stable == null) {
      const same = recent.filter((x) => Math.abs(x.w - r.weight) < 0.06);
      stable = same.length >= 3 && now - same[0].t >= 1500;
    }

    if (state === 'finalizing' && best && Math.abs(r.weight - best.weight) > 0.3) {
      // Mudou de peso (desceu e subiu, por exemplo): recomeça.
      clearTimeout(finalizeTimer);
      state = 'measuring';
      best = null;
    }

    if (!stable) {
      if (state === 'measuring') setStatus('Medindo… fique parado.');
      return;
    }

    if (!best) best = Object.assign({}, r);
    else {
      best.weight = r.weight;
      if (r.impedance) best.impedance = r.impedance;
    }

    if (state !== 'finalizing') {
      state = 'finalizing';
      setWeight(r.weight, 'done');
      const waitsImpedance = r.variant === 'V20' || r.variant === 'C0';
      if (waitsImpedance && !r.impedance) {
        setStatus('Peso estável. Medindo a bioimpedância… <b>continue descalço</b>.');
        finalizeTimer = setTimeout(finalize, 10000);
      } else {
        finalizeTimer = setTimeout(finalize, 1200);
      }
    }
    if (best.impedance && !best.closing) {
      best.closing = true; // agenda uma única vez, mesmo com muitos quadros chegando
      clearTimeout(finalizeTimer);
      finalizeTimer = setTimeout(finalize, 400);
    }
  }

  function finalize() {
    if (!best) return;
    const m = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      weight: Math.round(best.weight * 100) / 100,
      impedance: best.impedance ? Math.round(best.impedance * 10) / 10 : null,
      variant: best.variant,
    };
    const list = sorted();
    const prev = list[list.length - 1];
    const dup = prev && m.ts - prev.ts < 90000 && Math.abs(prev.weight - m.weight) < 0.1;
    if (dup) {
      Object.assign(prev, { weight: m.weight, impedance: m.impedance || prev.impedance });
    } else {
      db.measurements.push(m);
    }
    save();
    stopWeigh(true);
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    setWeight(m.weight, 'done');
    showDelta(m, dup ? list[list.length - 2] : prev);
    setStatus(m.impedance ? 'Pesagem salva com bioimpedância ✓' : 'Pesagem salva ✓');
    renderLatest();
  }

  $('#btnWeigh').addEventListener('click', () => {
    if (state === 'idle') startWeigh();
    else stopWeigh(false);
  });

  /* =========================================================
   * Diagnóstico
   * ========================================================= */
  const logLines = [];
  let lastLogged = '';
  function log(line) {
    const t = new Date().toLocaleTimeString('pt-BR');
    logLines.unshift(t + '  ' + line);
    if (logLines.length > 120) logLines.length = 120;
    $('#debugLog').textContent = logLines.join('\n');
  }
  function logAdvertisement(ev, reading) {
    const name = (ev.device && ev.device.name) || ev.name || '(sem nome)';
    const parts = [];
    if (ev.manufacturerData) {
      for (const [k, dv] of ev.manufacturerData) {
        parts.push('0x' + k.toString(16).padStart(4, '0') + ': ' + OKOK.hex(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)));
      }
    }
    if (!parts.length && !OKOK.looksLikeScaleName(name)) return; // ignora ruído
    const summary = reading
      ? ` → ${reading.variant} ${fmt(reading.weight, 2)} kg${reading.impedance ? ' ' + reading.impedance + ' Ω' : ''}${reading.stable ? ' estável' : ''}`
      : '';
    const line = `${name} rssi=${ev.rssi ?? '?'} ${parts.join(' | ') || 'sem manufacturer data'}${summary}`;
    if (line === lastLogged) return;
    lastLogged = line;
    log(line);
  }
  $('#debugToggle').addEventListener('change', (e) => { debugOn = e.target.checked; });
  $('#btnClearLog').addEventListener('click', () => { logLines.length = 0; $('#debugLog').textContent = ''; });

  // Simulação: gera quadros V20 reais e passa pelo mesmo decodificador.
  let simTimer = null;
  function simStop() { clearInterval(simTimer); simTimer = null; }
  $('#btnSimulate').addEventListener('click', () => {
    if (state !== 'idle') stopWeigh(true);
    goto('weigh');
    const list = sorted();
    const target = Math.round(((list.length ? list[list.length - 1].weight : 74) + (Math.random() - 0.55) * 0.8) * 20) / 20;
    const imp = Math.round(480 + Math.random() * 60);
    began('scan');
    let step = 0;
    simTimer = setInterval(() => {
      step++;
      let w, stable = false, z = 0;
      if (step < 8) w = target * (step / 8) + (Math.random() - 0.5) * 2;
      else if (step < 12) w = target + (Math.random() - 0.5) * 0.3;
      else { w = target; stable = true; if (step > 18) z = imp; }
      const frame = OKOK.buildV20Frame(Math.max(2.1, w), z, stable);
      onAdvertisement({
        device: { id: 'sim', name: 'ADV (simulação)' },
        rssi: -60,
        manufacturerData: new Map([[0x20ca, new DataView(frame.buffer)]]),
      });
      if (step > 30) simStop();
    }, 350);
  });

  /* =========================================================
   * Histórico
   * ========================================================= */
  let range = 30;
  $('#rangeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    range = Number(b.dataset.range);
    document.querySelectorAll('#rangeSeg button').forEach((x) => x.classList.toggle('on', x === b));
    renderChart();
  });

  function renderHistory() {
    renderChart();
    const list = sorted().reverse();
    const out = [];
    let group = '';
    const p = profileForCalc();
    list.forEach((m, i) => {
      const d = new Date(m.ts);
      let g = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      g = g.charAt(0).toUpperCase() + g.slice(1);
      if (g !== group) { group = g; out.push(`<div class="list-group">${esc(g)}</div>`); }
      const r = Body.compute(p, m);
      const prev = list[i + 1];
      const diff = prev ? m.weight - prev.weight : 0;
      const dcls = Math.abs(diff) < 0.05 ? '' : diff < 0 ? 'down' : 'up';
      const dtxt = prev && dcls ? (diff < 0 ? '▼ ' : '▲ ') + fmt(Math.abs(diff), 1) : '';
      const meta = [
        d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit' }) + ' · ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        r.fat != null ? 'gordura ' + fmt(r.fat, 1) + '%' : null,
        r.score ? 'nota ' + r.score.value : null,
      ].filter(Boolean).join(' · ');
      out.push(`<button class="item" data-id="${esc(m.id)}"><span class="w">${fmt(m.weight, 2)} kg</span><span class="d ${dcls}">${dtxt}</span><span class="meta">${esc(meta)}</span></button>`);
    });
    $('#historyList').innerHTML = out.length ? out.join('') : '<div class="card muted">Nenhuma pesagem ainda.</div>';
  }

  $('#historyList').addEventListener('click', (e) => {
    const b = e.target.closest('.item');
    if (b) openDetail(b.dataset.id);
  });

  function renderChart() {
    const el = $('#chart');
    const all = sorted();
    const since = range ? Date.now() - range * 86400000 : 0;
    const pts = all.filter((m) => m.ts >= since);
    if (pts.length < 2) {
      el.innerHTML = `<div class="chart-empty">${pts.length ? 'Faça mais uma pesagem para ver o gráfico.' : 'Sem pesagens neste período.'}</div>`;
      $('#chartSummary').textContent = '';
      return;
    }
    const W = Math.max(280, el.clientWidth || 320), H = 210;
    const padL = 38, padR = 10, padT = 12, padB = 26;
    const goal = Number(db.profile.goal) || null;
    let lo = Math.min(...pts.map((p) => p.weight)), hi = Math.max(...pts.map((p) => p.weight));
    if (goal && goal > lo - 5 && goal < hi + 5) { lo = Math.min(lo, goal); hi = Math.max(hi, goal); }
    const span = Math.max(1, hi - lo);
    lo = Math.floor(lo - span * 0.15); hi = Math.ceil(hi + span * 0.15);
    const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
    const x = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
    const y = (w) => padT + (1 - (w - lo) / (hi - lo)) * (H - padT - padB);

    const grid = [];
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = lo + ((hi - lo) * i) / steps;
      grid.push(`<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v, 0)}</text>`);
    }
    const dfmt = (t) => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
    grid.push(`<text class="axis-label" x="${padL}" y="${H - 6}">${dfmt(t0)}</text><text class="axis-label" x="${W - padR}" y="${H - 6}" text-anchor="end">${dfmt(t1)}</text>`);

    const line = pts.map((p, i) => (i ? 'L' : 'M') + x(p.ts).toFixed(1) + ' ' + y(p.weight).toFixed(1)).join(' ');
    const area = line + ` L${x(t1).toFixed(1)} ${H - padB} L${x(t0).toFixed(1)} ${H - padB} Z`;
    const dots = pts.length <= 40 ? pts.map((p) => `<circle class="dot" cx="${x(p.ts).toFixed(1)}" cy="${y(p.weight).toFixed(1)}" r="3.5"><title>${fmt(p.weight, 2)} kg</title></circle>`).join('') : '';
    const goalLine = goal && goal >= lo && goal <= hi
      ? `<line class="goal" x1="${padL}" x2="${W - padR}" y1="${y(goal)}" y2="${y(goal)}"/><text class="goal-label" x="${W - padR}" y="${y(goal) - 5}" text-anchor="end">meta ${fmt(goal, 1)}</text>`
      : '';
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico do peso">${grid.join('')}${goalLine}<path class="area" d="${area}"/><path class="line" d="${line}"/>${dots}</svg>`;

    const diff = pts[pts.length - 1].weight - pts[0].weight;
    $('#chartSummary').textContent = `${pts.length} pesagens · variação de ${diff > 0 ? '+' : ''}${fmt(diff, 2)} kg no período` +
      (goal ? ` · faltam ${fmt(Math.abs(pts[pts.length - 1].weight - goal), 1)} kg para a meta` : '');
  }

  let detailId = null;
  function openDetail(id) {
    const m = db.measurements.find((x) => x.id === id);
    if (!m) return;
    detailId = id;
    $('#detailTitle').textContent = new Date(m.ts).toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' });
    const { r, a } = analysisFor(m);
    detailResult = r;
    $('#detailBody').innerHTML =
      (a ? `<div class="card score-card">${Metrics.scoreHTML(r)}</div><div class="card analysis-card">${Metrics.analysisHTML(a)}</div>` : '') +
      `<div class="metrics">${Metrics.cardsHTML(r)}</div>`;
    $('#detailDialog').showModal();
  }
  let detailResult = null;

  // Explicação de cada índice
  function openInfo(key, r) {
    if (!r) return;
    $('#infoTitle').textContent = Metrics.label(key);
    $('#infoBody').innerHTML = Metrics.infoHTML(key, r);
    $('#infoDialog').showModal();
  }
  $('#results').addEventListener('click', (e) => {
    const b = e.target.closest('[data-metric]');
    if (b) openInfo(b.dataset.metric, currentResult);
  });
  $('#detailBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-metric]');
    if (b) openInfo(b.dataset.metric, detailResult);
  });
  $('#infoClose').addEventListener('click', () => $('#infoDialog').close());
  ['#infoDialog', '#detailDialog'].forEach((s) => {
    $(s).addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  });
  $('#detailClose').addEventListener('click', () => $('#detailDialog').close());
  $('#detailDelete').addEventListener('click', () => {
    if (!detailId || !confirm('Apagar esta medição? Não dá para desfazer.')) return;
    db.measurements = db.measurements.filter((x) => x.id !== detailId);
    save();
    $('#detailDialog').close();
    renderHistory();
    renderLatest();
    toast('Medição apagada.');
  });

  $('#manualForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const w = parseFloat(String($('#manualWeight').value).replace(',', '.'));
    if (!(w >= 2 && w <= 250)) return toast('Informe um peso entre 2 e 250 kg.');
    db.measurements.push({ id: Date.now().toString(36), ts: Date.now(), weight: w, impedance: null, variant: 'manual' });
    save();
    $('#manualWeight').value = '';
    renderHistory();
    renderLatest();
    toast('Peso adicionado.');
  });

  /* =========================================================
   * Perfil, ajustes e dados
   * ========================================================= */
  function fillForms() {
    const pf = $('#profileForm');
    pf.name.value = db.profile.name || '';
    pf.birth.value = db.profile.birth || '';
    pf.height.value = db.profile.height || '';
    pf.goal.value = db.profile.goal || '';
    pf.waist.value = db.profile.waist || '';
    pf.querySelectorAll('input[name="sex"]').forEach((r) => { r.checked = r.value === db.profile.sex; });
    const sf = $('#settingsForm');
    sf.fatOffset.value = db.settings.fatOffset || 0;
    sf.btMethod.value = db.settings.btMethod || 'auto';
  }

  $('#profileForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    db.profile = {
      name: f.name.value.trim(),
      sex: (f.querySelector('input[name="sex"]:checked') || {}).value || '',
      birth: f.birth.value,
      height: Number(f.height.value) || '',
      goal: Number(String(f.goal.value).replace(',', '.')) || '',
      waist: Number(String(f.waist.value).replace(',', '.')) || '',
    };
    save();
    renderLatest();
    toast('Perfil salvo.');
  });

  $('#settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    db.settings.fatOffset = Number(String(f.fatOffset.value).replace(',', '.')) || 0;
    db.settings.btMethod = f.btMethod.value;
    save();
    renderLatest();
    toast('Ajustes salvos.');
  });

  $('#btnForget').addEventListener('click', async () => {
    if (watchedDevice && watchedDevice.forget) { try { await watchedDevice.forget(); } catch (e) {} }
    db.settings.deviceId = '';
    save();
    toast('Balança esquecida. Na próxima pesagem ela será procurada de novo.');
  });

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const today = () => new Date().toISOString().slice(0, 10);

  $('#btnCsv').addEventListener('click', () => {
    const p = profileForCalc();
    const n = (v, d) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(d).replace('.', ','));
    const rows = [['Data', 'Hora', 'Peso (kg)', 'Impedância (ohm)', 'Pontuação', 'Tipo corporal', 'IMC', 'Gordura (%)', 'Massa de gordura (kg)', 'Gordura visceral', 'Massa magra (kg)', 'Músculo esquelético (kg)', 'Massa muscular (kg)', 'Água (%)', 'Proteína (%)', 'Massa óssea (kg)', 'Metabolismo (kcal)', 'Idade metabólica'].join(';')];
    sorted().forEach((m) => {
      const r = Body.compute(p, m);
      const d = new Date(m.ts);
      rows.push([
        d.toLocaleDateString('pt-BR'), d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        n(m.weight, 2), n(m.impedance, 0), r.score ? r.score.value : '', r.bodyType || '',
        n(r.bmi, 1), n(r.fat, 1), n(r.fatMass, 1), n(r.visceral, 0), n(r.leanMass, 1), n(r.skeletal, 1), n(r.muscleMass, 1),
        n(r.water, 1), n(r.protein, 1), n(r.bone, 1), n(r.bmr, 0), n(r.metabolicAge, 0),
      ].join(';'));
    });
    download('pesagens-' + today() + '.csv', '﻿' + rows.join('\r\n'), 'text/csv;charset=utf-8');
  });

  $('#btnBackup').addEventListener('click', () => {
    download('backup-balanca-' + today() + '.json', JSON.stringify(db, null, 2), 'application/json');
  });

  $('#fileRestore').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const d = JSON.parse(await file.text());
      if (!Array.isArray(d.measurements)) throw new Error('formato');
      if (!confirm(`Restaurar ${d.measurements.length} pesagens deste backup? Os dados atuais serão substituídos.`)) return;
      const base = defaults();
      db = {
        profile: Object.assign(base.profile, d.profile),
        settings: Object.assign(base.settings, d.settings),
        measurements: d.measurements.filter((m) => m && Number.isFinite(m.ts) && Number.isFinite(m.weight)),
      };
      save();
      fillForms();
      renderLatest();
      toast('Backup restaurado.');
    } catch (err) {
      toast('Arquivo de backup inválido.');
    }
  });

  /* =========================================================
   * Início
   * ========================================================= */
  fillForms();
  setButton();
  renderLatest();
  if (!profileComplete()) $('#setupCard').hidden = false;
  window.addEventListener('resize', () => { if ($('#view-history').classList.contains('active')) renderChart(); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
