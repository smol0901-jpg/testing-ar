/* ===================== RoastLab — app.js ===================== */
(() => {
'use strict';

const STORE_TESTS = 'roastlab_tests_v1';
const STORE_SETTINGS = 'roastlab_settings_v1';

/* ---------- storage helpers ---------- */
function loadTests(){
  try{ return JSON.parse(localStorage.getItem(STORE_TESTS)) || []; }
  catch(e){ return []; }
}
function saveTests(arr){
  localStorage.setItem(STORE_TESTS, JSON.stringify(arr));
}
function loadSettings(){
  try{ return JSON.parse(localStorage.getItem(STORE_SETTINGS)) || {}; }
  catch(e){ return {}; }
}
function saveSettings(s){
  localStorage.setItem(STORE_SETTINGS, JSON.stringify(s));
}

function clampLevels(n){
  n = parseInt(n, 10);
  if (!isFinite(n) || n < 1) n = 1;
  if (n > 30) n = 30;
  return n;
}

let tests = loadTests();
let settings = loadSettings();
let editingId = null;
let levelCount = clampLevels(settings.lastLevelCount || 1);
let tempPerLevel = false;
let lastReportTestId = null;
let reportMode = settings.reportMode === 'short' ? 'short' : 'full';
const DEFAULT_SECTIONS = { goal:true, posadkaDelta:true, tStart:true, normLoss:true, stage1:true, stage2:true, note:true };
let reportSections = Object.assign({}, DEFAULT_SECTIONS, settings.reportSections || {});

// test-chain linking (continuation of another test's stage 1)
let parentTestId = null;
let parentLevelIndex = null;
let showingChain = false;

const AI_DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  deepseek: 'deepseek-chat',
  custom: '',
};

/* ---------- frequency memory (goals/recipes/regimes/pan counts) ---------- */
function ensureFreq(){
  if (!settings.freq) settings.freq = {};
  ['goal','recipe','r1','r2','r3','r4','levelCounts'].forEach(k=>{
    if (!settings.freq[k]) settings.freq[k] = {};
  });
  if (!settings.freq.regimeCombos) settings.freq.regimeCombos = {};
}
ensureFreq();
function bumpFreq(field, value){
  value = (value===null||value===undefined) ? '' : String(value).trim();
  if (!value) return;
  const map = settings.freq[field];
  map[value] = (map[value]||0) + 1;
  const entries = Object.entries(map);
  if (entries.length > 30){
    entries.sort((a,b)=>b[1]-a[1]);
    settings.freq[field] = Object.fromEntries(entries.slice(0,30));
  }
}
function topFreqValues(field, n){
  const map = settings.freq[field] || {};
  return Object.entries(map).sort((a,b)=>b[1]-a[1]).slice(0,n).map(e=>e[0]);
}
function bumpRegimeCombo(t){
  const parts = [t.r1,t.r2,t.r3,t.r4,t.t1,t.t2].map(v=>(v||'').trim());
  const key = parts.join('|');
  if (parts.join('')==='') return;
  const combos = settings.freq.regimeCombos;
  if (combos[key]) combos[key].count++;
  else combos[key] = { r1:t.r1,r2:t.r2,r3:t.r3,r4:t.r4,t1:t.t1,t2:t.t2, count:1 };
  const entries = Object.entries(combos);
  if (entries.length > 20){
    entries.sort((a,b)=>b[1].count-a[1].count);
    settings.freq.regimeCombos = Object.fromEntries(entries.slice(0,20));
  }
}
function topRegimeCombos(n){
  return Object.values(settings.freq.regimeCombos||{}).sort((a,b)=>b.count-a.count).slice(0,n);
}
function renderDatalists(){
  const map = {goal:'dl-goal', recipe:'dl-recipe', r1:'dl-r1', r2:'dl-r2', r3:'dl-r3', r4:'dl-r4'};
  Object.keys(map).forEach(field=>{
    const el = document.getElementById(map[field]);
    if (!el) return;
    el.innerHTML = topFreqValues(field, 12).map(v=>`<option value="${escapeAttr(v)}"></option>`).join('');
  });
}
function renderLevelFreqChips(){
  const container = document.getElementById('lvlPresets');
  if (!container) return;
  container.querySelectorAll('.freq-chip').forEach(b=>b.remove());
  const defaults = new Set([1,4,8,12,20]);
  const top = topFreqValues('levelCounts', 8).map(v=>parseInt(v,10)).filter(n=>isFinite(n) && !defaults.has(n));
  top.slice(0,3).forEach(n=>{
    const btn = document.createElement('button');
    btn.textContent = String(n);
    btn.dataset.n = String(n);
    btn.className = 'freq-chip';
    container.appendChild(btn);
  });
  syncPresetButtons();
}
function regimeComboLabel(c){
  const stage1 = [c.r1,c.r2].filter(Boolean).join('/');
  const stage2 = [c.r3,c.r4].filter(Boolean).join('/');
  let label = stage1 || '—';
  if (stage2) label += ` → ${stage2}`;
  if (c.t1) label += ` · ${c.t1}°`;
  return label;
}
function renderRegimeFreqChips(){
  const container = document.getElementById('regimeFreqChips');
  if (!container) return;
  const combos = topRegimeCombos(4);
  if (combos.length === 0){ container.style.display='none'; container.innerHTML=''; return; }
  container.style.display = 'flex';
  container.innerHTML = combos.map((c,i)=>`<button type="button" data-idx="${i}">${escapeHtml(regimeComboLabel(c))}</button>`).join('');
  container.querySelectorAll('button').forEach((btn)=>{
    btn.addEventListener('click', ()=>{
      const c = combos[parseInt(btn.dataset.idx,10)];
      document.getElementById('f-r1').value = c.r1||'';
      document.getElementById('f-r2').value = c.r2||'';
      document.getElementById('f-r3').value = c.r3||'';
      document.getElementById('f-r4').value = c.r4||'';
      document.getElementById('f-t1').value = c.t1||'';
      document.getElementById('f-t2').value = c.t2||'';
      updateTempControls();
      toast('Режим подставлен');
    });
  });
}
function escapeAttr(s){ return String(s).replace(/[&"<>]/g, c=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[c])); }

/* ---------- number / format helpers ---------- */
function parseNum(v){
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(',', '.');
  if (s === '') return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}
function fmt(n, decimals){
  if (n === null || n === undefined || !isFinite(n)) return null;
  const d = decimals === undefined ? 1 : decimals;
  return n.toFixed(d).replace('.', ',');
}
function fmtOrDash(n, decimals){
  const f = fmt(n, decimals);
  return f === null ? '—' : f;
}
function rawOrDash(v){
  const s = (v === null || v === undefined) ? '' : String(v).trim();
  return s === '' ? '—' : s;
}
function todayISO(){
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off*60000);
  return local.toISOString().slice(0,10);
}
function fmtDateRu(iso){
  if (!iso) return '—';
  const [y,m,d] = iso.split('-');
  if(!y||!m||!d) return iso;
  return `${d}.${m}.${y}`;
}
function pctBadgeClass(p){
  if (p === null) return 'pct-empty';
  if (p >= 38 && p <= 46) return 'pct-ok';
  if (p > 46 && p <= 52) return 'pct-warn';
  if (p > 52) return 'pct-bad';
  return 'pct-warn';
}
function tempRange(){
  const min = parseNum(settings.tempMin);
  const max = parseNum(settings.tempMax);
  return { min: min===null?190:min, max: max===null?260:max };
}
function isTempOutOfRange(v){
  const n = parseNum(v);
  if (n === null) return false;
  const r = tempRange();
  return n < r.min || n > r.max;
}

/* ---------- calculation core ---------- */
function calcPct(base, out){
  if (base === null || out === null || base <= 0) return null;
  return (base - out) / base * 100;
}
function sumOrNull(arr){
  const vals = arr.filter(v => v !== null);
  if (vals.length === 0) return null;
  return vals.reduce((a,b)=>a+b, 0);
}
function spreadStats(arr){
  const vals = arr.filter(v=>v!==null);
  if (vals.length < 2) return null;
  const min = Math.min(...vals), max = Math.max(...vals);
  const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
  return { min, max, avg, spread: max-min };
}

// All yield percentages are computed against "норма" (nominal packed weight),
// per the shop's rule: packaging/vacuum loss is a real loss and must count
// toward the total, so факт (actual weighed meat) is diagnostic only.
function computeTotals(t){
  const n = t.levels.length || 1;
  const loads   = t.levels.map(l => parseNum(l.load));   // факт до Р1
  const out1s   = t.levels.map(l => parseNum(l.out1));
  const shockIns= t.levels.map(l => parseNum(l.shockIn));// вход на Р2 (после шокера)
  const out2s   = t.levels.map(l => parseNum(l.out2));

  const normPer = parseNum(t.norm);
  const totalNorm = (normPer!==null) ? normPer * n : null;

  const totalLoad    = sumOrNull(loads);
  const totalOut1    = out1s.every(v=>v===null) ? null : sumOrNull(out1s);
  const totalShockIn = shockIns.every(v=>v===null) ? null : sumOrNull(shockIns);
  const totalOut2    = out2s.every(v=>v===null) ? null : sumOrNull(out2s);

  const glazeRate = parseNum(t.glazeRate) || 0; // г/кг
  const glazeKgPerLevel = t.levels.map((l,i)=>{
    const base = shockIns[i]!==null ? shockIns[i] : (loads[i]!==null ? loads[i] : normPer);
    return (base!==null && base!==undefined) ? glazeRate*base/1000 : null;
  });
  const totalGlazeKg = sumOrNull(glazeKgPerLevel);

  const pctVacLoss = calcPct(totalNorm, totalLoad);
  const pct1  = calcPct(totalNorm, totalOut1);
  const pct2  = calcPct(totalNorm, totalOut2);
  const pct2glaze = (totalNorm!==null && totalOut2!==null)
    ? calcPct(totalNorm + (totalGlazeKg||0), totalOut2) : null;

  const levelPctVac = loads.map(l => calcPct(normPer, l));
  const levelPct1   = out1s.map(o => calcPct(normPer, o));
  const levelPct2   = out2s.map(o => calcPct(normPer, o));

  const t1 = parseNum(t.t1), t2 = parseNum(t.t2);
  const deltaT = (t1!==null && t2!==null) ? (t2-t1) : null;
  const deltaPct = (deltaT!==null && t1) ? (deltaT/t1*100) : null;

  return {
    loads, out1s, shockIns, out2s,
    normPer, totalNorm, totalLoad, totalOut1, totalShockIn, totalOut2,
    glazeKgPerLevel, totalGlazeKg,
    pctVacLoss, pct1, pct2, pct2glaze,
    levelPctVac, levelPct1, levelPct2,
    deltaT, deltaPct,
  };
}

/* ---------- view switching ---------- */
const views = document.querySelectorAll('.view');
const tabBtns = document.querySelectorAll('.tabbar button');
function showView(id){
  views.forEach(v => v.classList.toggle('active', v.id === id));
  tabBtns.forEach(b => b.classList.toggle('active', b.dataset.view === id));
  if (id === 'view-history') renderHistory();
  if (id === 'view-settings') renderSettings();
  window.scrollTo(0,0);
}
tabBtns.forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

/* ---------- toast ---------- */
let toastTimer;
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.remove('show'), 2200);
}

/* ---------- confirm modal ---------- */
function confirmAction(title, desc, onOk){
  const modal = document.getElementById('confirmModal');
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmDesc').textContent = desc;
  modal.classList.add('show');
  const ok = document.getElementById('confirmOk');
  const cancel = document.getElementById('confirmCancel');
  function cleanup(){ modal.classList.remove('show'); ok.removeEventListener('click', okH); cancel.removeEventListener('click', cH); }
  function okH(){ cleanup(); onOk(); }
  function cH(){ cleanup(); }
  ok.addEventListener('click', okH);
  cancel.addEventListener('click', cH);
}

/* ---------- level count selector ---------- */
function syncPresetButtons(){
  [...document.getElementById('lvlPresets').children].forEach(b=>{
    b.classList.toggle('active', parseInt(b.dataset.n,10)===levelCount);
  });
  document.getElementById('f-lvlCount').value = levelCount;
}
function setLevelCount(n){
  levelCount = clampLevels(n);
  settings.lastLevelCount = levelCount;
  saveSettings(settings);
  syncPresetButtons();
  renderLevelInputs();
  renderTempLevelInputs();
}
document.getElementById('lvlPresets').addEventListener('click', (e)=>{
  const btn = e.target.closest('button');
  if (!btn) return;
  setLevelCount(parseInt(btn.dataset.n, 10));
});
document.getElementById('f-lvlCount').addEventListener('change', (e)=>{
  setLevelCount(e.target.value);
});

/* ---------- weight level table (Факт / Выход Р1 / Вход Р2 / Выход Р2) ---------- */
function renderLevelInputs(){
  let html = '';
  for (let i=0; i<levelCount; i++){
    html += `<div class="lvl-row">
      <span class="lvl-num">${i+1}</span>
      <input type="text" inputmode="decimal" id="lvl-load-${i}" placeholder="0,977">
      <input type="text" inputmode="decimal" id="lvl-out1-${i}" placeholder="0,684">
      <input type="text" inputmode="decimal" id="lvl-shockIn-${i}" placeholder="0,672">
      <input type="text" inputmode="decimal" id="lvl-out2-${i}" placeholder="0,598">
    </div>`;
  }
  document.getElementById('levelsTable').innerHTML = html;
  document.getElementById('lvlWarnHint').style.display = levelCount > 6 ? 'block' : 'none';
  bindLiveCalc();
}
function collectLevelsFromForm(){
  const lv = [];
  for (let i=0;i<levelCount;i++){
    lv.push({
      load:    document.getElementById(`lvl-load-${i}`)    ? document.getElementById(`lvl-load-${i}`).value    : '',
      out1:    document.getElementById(`lvl-out1-${i}`)    ? document.getElementById(`lvl-out1-${i}`).value    : '',
      shockIn: document.getElementById(`lvl-shockIn-${i}`) ? document.getElementById(`lvl-shockIn-${i}`).value : '',
      out2:    document.getElementById(`lvl-out2-${i}`)    ? document.getElementById(`lvl-out2-${i}`).value    : '',
    });
  }
  return lv;
}
function bindLiveCalc(){
  document.querySelectorAll('#levelsTable input, #f-norm, #f-glazeRate').forEach(inp=>{
    inp.addEventListener('input', updateLiveHints);
  });
  updateLiveHints();
}
function updateLiveHints(){
  const draft = {
    levels: collectLevelsFromForm(),
    norm: document.getElementById('f-norm').value,
    glazeRate: document.getElementById('f-glazeRate').value,
  };
  const c = computeTotals(draft);
  document.getElementById('vacLossHint').innerHTML =
    `Потери при фасовке/вакуумировании: <b style="color:#e8edf1">${fmtOrDash(c.pctVacLoss,1)}%</b>`;
  document.getElementById('totalLoadHint').innerHTML =
    `Факт на противнях (общая): <b style="color:#e8edf1">${fmtOrDash(c.totalLoad,3)} кг</b>`;
  document.getElementById('out1TotalHint').innerHTML =
    `Итого после 1 этапа: <b style="color:#e8edf1">${fmtOrDash(c.totalOut1,3)} кг</b>` +
    (c.pct1!==null ? ` &nbsp;·&nbsp; ужарка <span class="pct-badge ${pctBadgeClass(c.pct1)}">${fmtOrDash(c.pct1,1)}%</span>` : '');
  document.getElementById('out2TotalHint').innerHTML =
    `Итого после 2 этапа: <b style="color:#e8edf1">${fmtOrDash(c.totalOut2,3)} кг</b>` +
    (c.pct2!==null ? ` &nbsp;·&nbsp; ужарка <span class="pct-badge ${pctBadgeClass(c.pct2)}">${fmtOrDash(c.pct2,1)}%</span>` : '') +
    (c.pct2glaze!==null ? ` &nbsp;·&nbsp; общая <span class="pct-badge ${pctBadgeClass(c.pct2glaze)}">${fmtOrDash(c.pct2glaze,1)}%</span>` : '');
  const spreadEl = document.getElementById('spreadHint');
  if (levelCount > 1){
    const st = spreadStats(c.levelPct2.every(v=>v===null) ? c.levelPct1 : c.levelPct2);
    if (st){
      spreadEl.style.display = 'block';
      spreadEl.innerHTML = `Разброс ужарки по уровням: <b style="color:#e8edf1">${fmtOrDash(st.spread,1)} п.п.</b> (мин ${fmtOrDash(st.min,1)}% · макс ${fmtOrDash(st.max,1)}% · сред. ${fmtOrDash(st.avg,1)}%)`;
    } else {
      spreadEl.style.display = 'none';
    }
  } else {
    spreadEl.style.display = 'none';
  }
}

/* ---------- temperature: global vs per-level ---------- */
document.getElementById('f-tempPerLevel').addEventListener('change', (e)=>{
  tempPerLevel = e.target.checked;
  document.getElementById('tempGlobalBlock').style.display = tempPerLevel ? 'none' : 'block';
  document.getElementById('tempLevelBlock').style.display = tempPerLevel ? 'block' : 'none';
  if (tempPerLevel) renderTempLevelInputs();
});
function renderTempLevelInputs(){
  if (!tempPerLevel) return;
  let html = '';
  for (let i=0; i<levelCount; i++){
    html += `<div class="lvl-row cols-3">
      <span class="lvl-num">${i+1}</span>
      <input type="text" inputmode="decimal" id="lvl-probe1-${i}" placeholder="—">
      <input type="text" inputmode="decimal" id="lvl-tempShock-${i}" placeholder="—">
      <input type="text" inputmode="decimal" id="lvl-probe2-${i}" placeholder="—">
    </div>`;
  }
  document.getElementById('tempLevelsTable').innerHTML = html;
}
function collectTempLevelsFromForm(){
  if (!tempPerLevel) return [];
  const lv = [];
  for (let i=0;i<levelCount;i++){
    lv.push({
      probe1:    document.getElementById(`lvl-probe1-${i}`)    ? document.getElementById(`lvl-probe1-${i}`).value    : '',
      tempShock: document.getElementById(`lvl-tempShock-${i}`) ? document.getElementById(`lvl-tempShock-${i}`).value : '',
      probe2:    document.getElementById(`lvl-probe2-${i}`)    ? document.getElementById(`lvl-probe2-${i}`).value    : '',
    });
  }
  return lv;
}

/* ---------- posadka temp validation + delta ---------- */
function updateTempControls(){
  const t1raw = document.getElementById('f-t1').value;
  const t2raw = document.getElementById('f-t2').value;
  const t1el = document.getElementById('f-t1');
  const t2el = document.getElementById('f-t2');
  const warn1 = isTempOutOfRange(t1raw);
  const warn2 = isTempOutOfRange(t2raw);
  t1el.classList.toggle('input-warn', warn1);
  t2el.classList.toggle('input-warn', warn2);
  const warnEl = document.getElementById('tempWarnHint');
  const r = tempRange();
  if (warn1 || warn2){
    warnEl.style.display = 'block';
    const parts = [];
    if (warn1) parts.push(`Р1 (${rawOrDash(t1raw)}°C)`);
    if (warn2) parts.push(`Р2 (${rawOrDash(t2raw)}°C)`);
    warnEl.textContent = `⚠ Вне допустимого диапазона ${fmtOrDash(r.min,0)}–${fmtOrDash(r.max,0)}°C: ${parts.join(', ')}`;
  } else {
    warnEl.style.display = 'none';
  }
  const t1 = parseNum(t1raw), t2 = parseNum(t2raw);
  const deltaEl = document.getElementById('tempDeltaHint');
  if (t1!==null && t2!==null){
    const dT = t2-t1;
    const dPct = t1 ? (dT/t1*100) : null;
    deltaEl.innerHTML = `Разница посадки Р1→Р2: <b style="color:#e8edf1">${dT>=0?'+':''}${fmtOrDash(dT,0)}°C</b>` +
      (dPct!==null ? ` (${dPct>=0?'+':''}${fmtOrDash(dPct,1)}%)` : '');
  } else {
    deltaEl.textContent = 'Разница посадки Р1→Р2: —';
  }
}
['f-t1','f-t2'].forEach(id=> document.getElementById(id).addEventListener('input', updateTempControls));

/* ---------- form: read / write ---------- */
function nextSuggestedNumber(){
  const nums = tests.map(t => parseInt(t.testNumber,10)).filter(n=>isFinite(n));
  if (nums.length===0) return '1';
  return String(Math.max(...nums)+1);
}
function resetForm(prefillNumber){
  editingId = null;
  document.getElementById('f-testNumber').value = prefillNumber !== undefined ? prefillNumber : nextSuggestedNumber();
  document.getElementById('f-date').value = todayISO();
  document.getElementById('f-recipe').value = settings.lastRecipe || 'Стандарт';
  document.getElementById('f-goal').value = '';
  document.getElementById('f-r1').value = '';
  document.getElementById('f-r2').value = '';
  document.getElementById('f-r3').value = '';
  document.getElementById('f-r4').value = '';
  document.getElementById('f-t1').value = '';
  document.getElementById('f-t2').value = '';
  document.getElementById('f-tStart').value = settings.lastTStart || '';
  document.getElementById('f-norm').value = settings.lastNorm || '1';
  document.getElementById('f-glazeRate').value = settings.lastGlazeRate || '85';
  document.getElementById('f-probe1').value = '';
  document.getElementById('f-tempShock').value = '';
  document.getElementById('f-probe2').value = '';
  document.getElementById('f-note1').value = '';
  document.getElementById('f-note2').value = '';
  document.getElementById('f-note').value = '';
  tempPerLevel = false;
  document.getElementById('f-tempPerLevel').checked = false;
  document.getElementById('tempGlobalBlock').style.display = 'block';
  document.getElementById('tempLevelBlock').style.display = 'none';
  levelCount = clampLevels(settings.lastLevelCount || 1);
  syncPresetButtons();
  renderLevelInputs();
  renderTempLevelInputs();
  updateTempControls();
  document.getElementById('f-isContinuation').checked = false;
  document.getElementById('parentLinkBlock').style.display = 'none';
  clearParent();
  renderDatalists();
  renderLevelFreqChips();
  renderRegimeFreqChips();
}
function readForm(){
  const levels = collectLevelsFromForm().map(l => ({
    load: l.load.trim(), out1: l.out1.trim(), shockIn: l.shockIn.trim(), out2: l.out2.trim()
  }));
  const tempLevels = collectTempLevelsFromForm().map(l => ({
    probe1: l.probe1.trim(), tempShock: l.tempShock.trim(), probe2: l.probe2.trim()
  }));
  return {
    id: editingId || ('t_' + Date.now() + '_' + Math.random().toString(36).slice(2,7)),
    testNumber: document.getElementById('f-testNumber').value.trim(),
    date: document.getElementById('f-date').value || todayISO(),
    recipe: document.getElementById('f-recipe').value.trim(),
    goal: document.getElementById('f-goal').value.trim(),
    levelCount,
    r1: document.getElementById('f-r1').value.trim(),
    r2: document.getElementById('f-r2').value.trim(),
    r3: document.getElementById('f-r3').value.trim(),
    r4: document.getElementById('f-r4').value.trim(),
    t1: document.getElementById('f-t1').value.trim(),
    t2: document.getElementById('f-t2').value.trim(),
    tStart: document.getElementById('f-tStart').value.trim(),
    norm: document.getElementById('f-norm').value.trim(),
    glazeRate: document.getElementById('f-glazeRate').value.trim(),
    levels,
    tempPerLevel,
    probe1: document.getElementById('f-probe1').value.trim(),
    tempShock: document.getElementById('f-tempShock').value.trim(),
    probe2: document.getElementById('f-probe2').value.trim(),
    tempLevels,
    note1: document.getElementById('f-note1').value.trim(),
    note2: document.getElementById('f-note2').value.trim(),
    note: document.getElementById('f-note').value.trim(),
    parentId: parentTestId || null,
    parentLevelIndex: (parentLevelIndex!==null && parentLevelIndex!==undefined) ? parentLevelIndex : null,
    createdAt: Date.now(),
  };
}
function fillFormFromTest(t){
  editingId = t.id;
  levelCount = clampLevels(t.levelCount || 1);
  syncPresetButtons();
  renderLevelInputs();
  document.getElementById('f-testNumber').value = t.testNumber||'';
  document.getElementById('f-date').value = t.date||todayISO();
  document.getElementById('f-recipe').value = t.recipe||'';
  document.getElementById('f-goal').value = t.goal||'';
  document.getElementById('f-r1').value = t.r1||'';
  document.getElementById('f-r2').value = t.r2||'';
  document.getElementById('f-r3').value = t.r3||'';
  document.getElementById('f-r4').value = t.r4||'';
  document.getElementById('f-t1').value = t.t1||'';
  document.getElementById('f-t2').value = t.t2||'';
  document.getElementById('f-tStart').value = t.tStart||'';
  document.getElementById('f-norm').value = t.norm||'1';
  document.getElementById('f-glazeRate').value = t.glazeRate||'85';
  document.getElementById('f-note1').value = t.note1||'';
  document.getElementById('f-note2').value = t.note2||'';
  document.getElementById('f-note').value = t.note||'';
  (t.levels||[]).forEach((l,i)=>{
    if (document.getElementById(`lvl-load-${i}`))    document.getElementById(`lvl-load-${i}`).value    = l.load||'';
    if (document.getElementById(`lvl-out1-${i}`))    document.getElementById(`lvl-out1-${i}`).value    = l.out1||'';
    if (document.getElementById(`lvl-shockIn-${i}`)) document.getElementById(`lvl-shockIn-${i}`).value = l.shockIn||'';
    if (document.getElementById(`lvl-out2-${i}`))    document.getElementById(`lvl-out2-${i}`).value    = l.out2||'';
  });
  tempPerLevel = !!t.tempPerLevel;
  document.getElementById('f-tempPerLevel').checked = tempPerLevel;
  document.getElementById('tempGlobalBlock').style.display = tempPerLevel ? 'none' : 'block';
  document.getElementById('tempLevelBlock').style.display = tempPerLevel ? 'block' : 'none';
  document.getElementById('f-probe1').value = t.probe1||'';
  document.getElementById('f-tempShock').value = t.tempShock||'';
  document.getElementById('f-probe2').value = t.probe2||'';
  renderTempLevelInputs();
  (t.tempLevels||[]).forEach((l,i)=>{
    if (document.getElementById(`lvl-probe1-${i}`))    document.getElementById(`lvl-probe1-${i}`).value    = l.probe1||'';
    if (document.getElementById(`lvl-tempShock-${i}`)) document.getElementById(`lvl-tempShock-${i}`).value = l.tempShock||'';
    if (document.getElementById(`lvl-probe2-${i}`))    document.getElementById(`lvl-probe2-${i}`).value    = l.probe2||'';
  });
  updateLiveHints();
  updateTempControls();
  parentTestId = t.parentId || null;
  parentLevelIndex = (t.parentLevelIndex!==undefined && t.parentLevelIndex!==null) ? t.parentLevelIndex : null;
  document.getElementById('f-isContinuation').checked = !!parentTestId;
  document.getElementById('parentLinkBlock').style.display = parentTestId ? 'block' : 'none';
  refreshParentUI();
}

/* ---------- chain linking: pick a parent (stage-1 source) test ---------- */
document.getElementById('f-isContinuation').addEventListener('change', (e)=>{
  document.getElementById('parentLinkBlock').style.display = e.target.checked ? 'block' : 'none';
  if (!e.target.checked) clearParent();
});
document.getElementById('btnPickParent').addEventListener('click', openParentPicker);
document.getElementById('parentPickClose').addEventListener('click', ()=>{
  document.getElementById('parentPickModal').classList.remove('show');
});
document.getElementById('parentSearchInput').addEventListener('input', (e)=> renderParentPickList(e.target.value));
document.getElementById('parentPickModal').addEventListener('click', (e)=>{
  if (e.target === document.getElementById('parentPickModal')) e.currentTarget.classList.remove('show');
});
document.getElementById('f-parentLevel').addEventListener('change', (e)=>{
  const v = e.target.value;
  parentLevelIndex = v===''? null : parseInt(v,10);
  const p = tests.find(x=>x.id===parentTestId);
  if (p) applyParentDefaults(p);
});

function openParentPicker(){
  document.getElementById('parentSearchInput').value = '';
  renderParentPickList('');
  document.getElementById('parentPickModal').classList.add('show');
}
function renderParentPickList(q){
  q = (q||'').toLowerCase().trim();
  const list = tests
    .filter(t=> t.id !== editingId)
    .filter(t=>{
      if (!q) return true;
      return [t.testNumber,t.date,t.recipe,t.goal].join(' ').toLowerCase().includes(q);
    })
    .slice(0, 50);
  const el = document.getElementById('parentPickList');
  if (list.length===0){
    el.innerHTML = '<div class="hint">Ничего не найдено</div>';
    return;
  }
  el.innerHTML = list.map(t=>{
    const c = computeTotals(t);
    return `<div class="parent-pick-item" data-id="${t.id}">
      <div class="t">Тест #${escapeHtml(t.testNumber||'—')} · ${fmtDateRu(t.date)}</div>
      <div class="s">${escapeHtml(t.recipe||'')} · ${t.levelCount} уров. · выход Р1 ${fmtOrDash(c.totalOut1,3)} кг</div>
    </div>`;
  }).join('');
  el.querySelectorAll('.parent-pick-item').forEach(item=>{
    item.addEventListener('click', ()=>{
      selectParent(item.dataset.id);
      document.getElementById('parentPickModal').classList.remove('show');
    });
  });
}
function selectParent(id){
  parentTestId = id;
  parentLevelIndex = null;
  refreshParentUI(true);
  toast('Источник выбран — норма/рецепт/глазурь подставлены');
}
function clearParent(){
  parentTestId = null;
  parentLevelIndex = null;
  refreshParentUI(false);
}
function refreshParentUI(force){
  const infoEl = document.getElementById('parentInfo');
  const levelField = document.getElementById('parentLevelField');
  const levelSel = document.getElementById('f-parentLevel');
  if (!infoEl) return;
  if (!parentTestId){
    infoEl.style.display = 'none';
    levelField.style.display = 'none';
    return;
  }
  const p = tests.find(x=>x.id===parentTestId);
  if (!p){ parentTestId = null; parentLevelIndex = null; infoEl.style.display='none'; levelField.style.display='none'; return; }
  const c = computeTotals(p);
  infoEl.style.display = 'flex';
  infoEl.innerHTML = `<div><b>Тест #${escapeHtml(p.testNumber||'—')} · ${fmtDateRu(p.date)}</b>${escapeHtml(p.recipe||'')} · выход Р1 ${fmtOrDash(c.totalOut1,3)} кг</div><span class="rm" id="parentRemoveBtn">✕ убрать</span>`;
  document.getElementById('parentRemoveBtn').addEventListener('click', ()=>{
    document.getElementById('f-isContinuation').checked = false;
    document.getElementById('parentLinkBlock').style.display = 'none';
    clearParent();
  });
  levelField.style.display = 'block';
  let opts = '<option value="">Не указан / несколько уровней</option>';
  (p.levels||[]).forEach((l,i)=>{
    const out1 = parseNum(l.out1);
    opts += `<option value="${i}">Уровень ${i+1}${out1!==null? ` — выход Р1 ${fmtOrDash(out1,3)} кг`:''}</option>`;
  });
  levelSel.innerHTML = opts;
  levelSel.value = (parentLevelIndex!==null && parentLevelIndex!==undefined) ? String(parentLevelIndex) : '';
  applyParentDefaults(p, !!force);
}
function applyParentDefaults(p, force){
  // On a fresh pick (force=true) we actively inherit norm/recipe/glaze from the
  // source test, since a continuation must match its source batch. When just
  // restoring an already-saved test (force=false), we never touch these — the
  // saved values are authoritative and already filled in by fillFormFromTest.
  const normEl = document.getElementById('f-norm');
  if (normEl && p.norm && (force || !normEl.value.trim())) normEl.value = p.norm;
  const glazeEl = document.getElementById('f-glazeRate');
  if (glazeEl && p.glazeRate && (force || !glazeEl.value.trim())) glazeEl.value = p.glazeRate;
  const recipeEl = document.getElementById('f-recipe');
  if (recipeEl && p.recipe && (force || !recipeEl.value.trim())) recipeEl.value = p.recipe;
  // Actual measured weight (shockIn) is never force-overwritten — only offered
  // as a starting value when the field is still empty.
  if (parentLevelIndex!==null && parentLevelIndex!==undefined && levelCount===1){
    const lvl = (p.levels||[])[parentLevelIndex];
    if (lvl){
      const shockEl = document.getElementById('lvl-shockIn-0');
      const out1 = parseNum(lvl.out1);
      if (shockEl && !shockEl.value.trim() && out1!==null){
        shockEl.value = String(out1).replace('.',',');
      }
    }
  } else if ((parentLevelIndex===null || parentLevelIndex===undefined) && levelCount === (p.levels||[]).length){
    // continuing the whole source batch at once, same pan count — line up levels 1:1
    (p.levels||[]).forEach((lvl,i)=>{
      const shockEl = document.getElementById(`lvl-shockIn-${i}`);
      const out1 = parseNum(lvl.out1);
      if (shockEl && !shockEl.value.trim() && out1!==null){
        shockEl.value = String(out1).replace('.',',');
      }
    });
  }
  updateLiveHints();
}

function saveCurrentTest(){
  const t = readForm();
  const idx = tests.findIndex(x=>x.id===t.id);
  if (idx>=0) tests[idx] = t; else tests.unshift(t);
  saveTests(tests);
  settings.lastRecipe = t.recipe;
  settings.lastNorm = t.norm;
  settings.lastGlazeRate = t.glazeRate;
  settings.lastTStart = t.tStart;
  bumpFreq('goal', t.goal);
  bumpFreq('recipe', t.recipe);
  bumpFreq('r1', t.r1);
  bumpFreq('r2', t.r2);
  bumpFreq('r3', t.r3);
  bumpFreq('r4', t.r4);
  bumpFreq('levelCounts', String(t.levelCount));
  bumpRegimeCombo(t);
  saveSettings(settings);
  renderDatalists();
  renderLevelFreqChips();
  renderRegimeFreqChips();
  return t;
}

document.getElementById('btnClearForm').addEventListener('click', ()=>{
  confirmAction('Очистить форму?', 'Несохранённые данные текущего теста будут потеряны.', ()=>{
    resetForm();
    toast('Форма очищена');
  });
});
document.getElementById('btnSaveOnly').addEventListener('click', ()=>{
  const t = saveCurrentTest();
  toast(`Тест #${t.testNumber||''} сохранён`);
  resetForm();
});
document.getElementById('btnSaveAndReport').addEventListener('click', ()=>{
  const t = saveCurrentTest();
  lastReportTestId = t.id;
  renderReport(t);
  showView('view-report');
  resetForm();
});

/* ---------- report generation ---------- */
function tempWithFlag(v){
  if (v===null || v===undefined || String(v).trim()==='') return '—';
  const flagged = isTempOutOfRange(v);
  return `${v}°C${flagged? ' ⚠ вне нормы':''}`;
}
function tempPerLevelFor(t){ return !!t.tempPerLevel; }
function generateReportText(t, mode){
  mode = mode || 'full';
  const sec = reportSections;
  const c = computeTotals(t);
  const multi = t.levelCount > 1;
  const detailed = multi && t.levelCount <= 6;
  const compact = multi && t.levelCount > 6;
  const full = mode === 'full';
  const showStage2 = sec.stage2 !== false;
  const parent = getParent(t);
  const parentLvlLabel = (t.parentLevelIndex!==null && t.parentLevelIndex!==undefined) ? `, уровень ${t.parentLevelIndex+1}` : '';
  let lines = [];

  lines.push(`Тест #${t.testNumber || '—'} · ${fmtDateRu(t.date)}`);
  lines.push(`Рецепт: ${rawOrDash(t.recipe)}`);
  if (sec.goal !== false && (full || t.goal)) lines.push(`Цель: ${rawOrDash(t.goal)}`);
  if (parent){
    lines.push(`🔗 Продолжение теста #${parent.testNumber||'—'} от ${fmtDateRu(parent.date)}${parentLvlLabel}`);
  }
  lines.push('');

  lines.push(`Режим 1- ${rawOrDash(t.r1)}`);
  lines.push(`Режим 2- ${rawOrDash(t.r2)}`);
  if (showStage2){
    lines.push(`Режим 3- ${rawOrDash(t.r3)}`);
    lines.push(`Режим 4- ${rawOrDash(t.r4)}`);
  }
  lines.push('');

  lines.push('Посадка:');
  lines.push(`Режим 1- ${tempWithFlag(t.t1)}`);
  if (showStage2) lines.push(`Режим 2- ${tempWithFlag(t.t2)}`);
  if (sec.posadkaDelta !== false && showStage2 && c.deltaT!==null){
    lines.push(`Разница Р1→Р2: ${c.deltaT>=0?'+':''}${fmtOrDash(c.deltaT,0)}°C${c.deltaPct!==null? ` (${c.deltaPct>=0?'+':''}${fmtOrDash(c.deltaPct,1)}%)`:''}`);
  }
  if (full && sec.tStart !== false){
    lines.push(`t° мяса перед началом: ${t.tStart? t.tStart+'°C':'—'}`);
  }
  lines.push('');

  lines.push(`Норма в пакет: ${fmtOrDash(c.normPer,3)} кг × ${t.levelCount} = ${fmtOrDash(c.totalNorm,3)} кг`);
  lines.push(`Факт на противнях: ${fmtOrDash(c.totalLoad,3)} кг${full && sec.normLoss !== false && c.pctVacLoss!==null? ` (потери фасовки/вакуума ${fmtOrDash(c.pctVacLoss,1)}%)`:''}`);
  if (full && detailed){
    c.loads.forEach((l,i)=> lines.push(`  Ур.${i+1}: ${fmtOrDash(l,3)}`));
  }
  lines.push('');

  if (showStage2){
    lines.push(`Глазурь: ${rawOrDash(t.glazeRate)} г/кг${full && c.totalGlazeKg!==null? ` (≈ ${fmtOrDash(c.totalGlazeKg*1000,0)} г на партию)`:''}`);
    lines.push('');
  }

  if (sec.stage1 !== false){
    if (c.totalOut1 !== null){
      // this test recorded its own stage-1 output
      lines.push(`Выход после 1 этапа: ${fmtOrDash(c.totalOut1,3)} кг${c.pct1!==null? `, ужарка ${fmtOrDash(c.pct1,2)}%`:''}`);
      if (full){
        if (detailed){
          c.out1s.forEach((o,i)=> lines.push(`  Ур.${i+1}: ${fmtOrDash(o,3)}${c.levelPct1[i]!==null? `, ${fmtOrDash(c.levelPct1[i],1)}%`:''}`));
        } else if (compact){
          const st = spreadStats(c.levelPct1);
          if (st) lines.push(`  Разброс по уровням: ${fmtOrDash(st.spread,1)} п.п. (мин ${fmtOrDash(st.min,1)}% · макс ${fmtOrDash(st.max,1)}% · сред ${fmtOrDash(st.avg,1)}%)`);
        }
        if (!tempPerLevelFor(t)){
          lines.push(`  Щуп после 1 этапа: ${t.probe1? t.probe1+'°C':'—'}`);
        }
        lines.push(`  Комментарий: ${t.note1? t.note1 : '—'}`);
      }
    } else if (parent){
      // pull stage-1 data from the source test for full traceability
      const pc = computeTotals(parent);
      const hasIdx = (t.parentLevelIndex!==null && t.parentLevelIndex!==undefined);
      const srcLevels = hasIdx ? [parent.levels[t.parentLevelIndex]].filter(Boolean) : (parent.levels||[]);
      const srcOut1 = srcLevels.map(l=>parseNum(l.out1));
      const totalSrcOut1 = sumOrNull(srcOut1);
      const srcNormTotal = (pc.normPer!==null) ? pc.normPer * srcLevels.length : null;
      const srcPct1 = calcPct(srcNormTotal, totalSrcOut1);
      lines.push(`Выход после 1 этапа (источник — тест #${parent.testNumber||'—'}): ${fmtOrDash(totalSrcOut1,3)} кг${srcPct1!==null? `, ужарка ${fmtOrDash(srcPct1,2)}%`:''}`);
      if (full){
        srcLevels.forEach((l,i)=>{
          const idx = hasIdx ? t.parentLevelIndex : i;
          const out1 = parseNum(l.out1);
          const pct1 = calcPct(pc.normPer, out1);
          lines.push(`  Ур.${idx+1} источника: ${fmtOrDash(out1,3)}${pct1!==null? `, ${fmtOrDash(pct1,1)}%`:''}`);
        });
        if (parent.probe1) lines.push(`  Щуп после 1 этапа (источник): ${parent.probe1}°C`);
        if (parent.note1) lines.push(`  Комментарий источника: ${parent.note1}`);
      }
    } else {
      lines.push(`Выход после 1 этапа: — кг`);
    }
    lines.push('');
  }

  if (showStage2){
    lines.push(`Вход на 2 этап (после шокера): ${fmtOrDash(c.totalShockIn,3)} кг`);
    if (full){
      if (detailed){
        c.shockIns.forEach((s,i)=> lines.push(`  Ур.${i+1}: ${fmtOrDash(s,3)}`));
      }
      if (!tempPerLevelFor(t)){
        lines.push(`  t° после шокера: ${t.tempShock? t.tempShock+'°C':'—'}`);
      }
    }
    lines.push('');

    lines.push(`Выход после 2 этапа: ${fmtOrDash(c.totalOut2,3)} кг${c.pct2!==null? `, ужарка ${fmtOrDash(c.pct2,2)}%`:''}${c.pct2glaze!==null? ` · общая ${fmtOrDash(c.pct2glaze,2)}%`:''}`);
    if (full){
      if (detailed){
        c.out2s.forEach((o,i)=> lines.push(`  Ур.${i+1}: ${fmtOrDash(o,3)}${c.levelPct2[i]!==null? `, ${fmtOrDash(c.levelPct2[i],1)}%`:''}`));
      } else if (compact){
        const st = spreadStats(c.levelPct2);
        if (st) lines.push(`  Разброс по уровням: ${fmtOrDash(st.spread,1)} п.п. (мин ${fmtOrDash(st.min,1)}% · макс ${fmtOrDash(st.max,1)}% · сред ${fmtOrDash(st.avg,1)}%)`);
      }
      if (!tempPerLevelFor(t)){
        lines.push(`  Щуп финал: ${t.probe2? t.probe2+'°C':'—'}`);
      }
      lines.push(`  Комментарий: ${t.note2? t.note2 : '—'}`);
    } else {
      if (t.probe2) lines.push(`Щуп финал: ${t.probe2}°C`);
    }
  }

  if (full && showStage2 && tempPerLevelFor(t) && (t.tempLevels||[]).length){
    lines.push('');
    lines.push('Температуры по уровням (Р1 / шокер / Р2):');
    t.tempLevels.forEach((l,i)=> lines.push(`  Ур.${i+1}: ${rawOrDash(l.probe1)}°C / ${rawOrDash(l.tempShock)}°C / ${rawOrDash(l.probe2)}°C`));
  }

  if (sec.note !== false){
    if (full){
      lines.push('');
      lines.push(`Примечание: ${rawOrDash(t.note)}`);
    } else if (t.note){
      lines.push('');
      lines.push(`Примечание: ${t.note}`);
    }
  }

  if (settings.showBranding !== false){
    lines.push('');
    lines.push('—');
    lines.push('Сделано с помощью NEURAL_ARCHITECT_PREMIUM++');
    lines.push('https://smol0901-jpg.github.io/testing/index.html');
  }
  return lines.join('\n');
}

function renderReport(t){
  showingChain = false;
  document.getElementById('reportText').textContent = generateReportText(t, reportMode);
  document.getElementById('reportModeSeg').style.display = 'flex';
  [...document.getElementById('reportModeSeg').children].forEach(b=>{
    b.classList.toggle('active', b.dataset.mode===reportMode);
  });
  const chainBtn = document.getElementById('btnChainReport');
  chainBtn.style.display = hasChainFor(t) ? 'block' : 'none';
  chainBtn.textContent = '🔗 Показать всю цепочку тестов';
  document.getElementById('aiOutput').style.display = 'none';
  document.getElementById('aiOutput').textContent = '';
  renderPhotoPreview(t);
}
document.getElementById('reportModeSeg').addEventListener('click', (e)=>{
  const btn = e.target.closest('button');
  if (!btn) return;
  reportMode = btn.dataset.mode;
  const t = tests.find(x=>x.id===lastReportTestId);
  if (t) renderReport(t);
});

/* ---------- photo attach (taken after cooking, shared together with the report) ---------- */
function getPhotos(t){
  if (!t) return [];
  if (Array.isArray(t.photos)) return t.photos;
  if (t.photo) return [t.photo];
  return [];
}
function setPhotos(t, arr){
  t.photos = arr;
  if ('photo' in t) delete t.photo; // migrate away from the old single-photo field
}
function renderPhotoPreview(t){
  const gallery = document.getElementById('photoGallery');
  const photos = getPhotos(t);
  gallery.innerHTML = photos.map((src,i)=>`
    <div class="photo-item" data-i="${i}">
      <img src="${src}" alt="Фото ${i+1}">
      <button type="button" class="rm-photo" data-i="${i}">✕</button>
    </div>`).join('');
  gallery.querySelectorAll('.rm-photo').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      removePhotoAt(t, parseInt(btn.dataset.i,10));
    });
  });
  document.getElementById('photoCountHint').textContent = photos.length
    ? `Фото: ${photos.length} — при «Поделиться» уйдут вместе с текстом`
    : 'Фото ещё не добавлены';
  document.getElementById('photoBulkRow').style.display = photos.length ? 'flex' : 'none';
}
function resizeImageToDataURL(file, maxDim, quality){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w >= h && w > maxDim){ h = Math.round(h*maxDim/w); w = maxDim; }
        else if (h > w && h > maxDim){ w = Math.round(w*maxDim/h); h = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('bad image'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}
function dataURLtoFile(dataUrl, filename){
  const arr = dataUrl.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--){ u8arr[n] = bstr.charCodeAt(n); }
  return new File([u8arr], filename, { type: mime });
}
async function addPhotosFromFiles(t, files){
  const before = getPhotos(t);
  const photos = before.slice();
  let added = 0, failed = 0;
  for (const file of files){
    try{
      const dataUrl = await resizeImageToDataURL(file, 1280, 0.7);
      photos.push(dataUrl);
      added++;
    }catch(err){ failed++; }
  }
  try{
    setPhotos(t, photos);
    saveTests(tests);
    renderPhotoPreview(t);
    toast(failed ? `Добавлено ${added}, ошибок ${failed}` : `Добавлено фото: ${added}`);
  }catch(err){
    // storage full — keep the previously saved state, don't lose already-stored photos
    setPhotos(t, before);
    saveTests(tests);
    renderPhotoPreview(t);
    toast('Не хватает места в памяти браузера — новые фото не сохранены');
  }
}
function removePhotoAt(t, idx){
  const photos = getPhotos(t).slice();
  photos.splice(idx,1);
  setPhotos(t, photos);
  saveTests(tests);
  renderPhotoPreview(t);
  toast('Фото удалено');
}
document.getElementById('btnAddPhotoCamera').addEventListener('click', ()=>{
  document.getElementById('photoCameraInput').click();
});
document.getElementById('btnAddPhotoGallery').addEventListener('click', ()=>{
  document.getElementById('photoGalleryInput').click();
});
function handlePhotoInputChange(e){
  const files = Array.from(e.target.files||[]);
  e.target.value = '';
  if (!files.length) return;
  const t = tests.find(x=>x.id===lastReportTestId);
  if (!t){ toast('Сначала откройте отчёт теста'); return; }
  addPhotosFromFiles(t, files);
}
document.getElementById('photoCameraInput').addEventListener('change', handlePhotoInputChange);
document.getElementById('photoGalleryInput').addEventListener('change', handlePhotoInputChange);
document.getElementById('btnClearPhotos').addEventListener('click', ()=>{
  const t = tests.find(x=>x.id===lastReportTestId);
  if (!t) return;
  confirmAction('Убрать все фото?', 'Все фото этого теста будут удалены без возможности восстановления.', ()=>{
    setPhotos(t, []);
    saveTests(tests);
    renderPhotoPreview(t);
    toast('Фото удалены');
  });
});
document.getElementById('btnDownloadAllPhotos').addEventListener('click', async ()=>{
  const t = tests.find(x=>x.id===lastReportTestId);
  if (!t) return;
  const photos = getPhotos(t);
  for (let i=0; i<photos.length; i++){
    const a = document.createElement('a');
    a.href = photos[i];
    a.download = `roastlab-test-${t.testNumber||'photo'}-${i+1}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (i < photos.length-1) await new Promise(r=>setTimeout(r, 300));
  }
});

document.getElementById('btnShare').addEventListener('click', async ()=>{
  const text = document.getElementById('reportText').textContent;
  if (!text || text==='—'){ toast('Нет отчёта для отправки'); return; }
  const t = tests.find(x=>x.id===lastReportTestId);
  const photos = getPhotos(t);
  if (photos.length && navigator.canShare){
    try{
      const files = photos.map((src,i)=> dataURLtoFile(src, `roastlab-test-${t.testNumber||'photo'}-${i+1}.jpg`));
      if (navigator.canShare({ files })){
        await navigator.share({ text, files });
        return;
      }
    }catch(err){
      if (err && err.name === 'AbortError') return;
      // fall through to text-only share below
    }
  }
  if (navigator.share){
    try{ await navigator.share({ text }); return; }
    catch(err){ if (err && err.name === 'AbortError') return; }
  }
  await copyText(text);
  toast('Отчёт скопирован (Share API недоступен)');
});
document.getElementById('btnCopy').addEventListener('click', async ()=>{
  const text = document.getElementById('reportText').textContent;
  if (!text || text==='—'){ toast('Нет отчёта для копирования'); return; }
  await copyText(text);
  toast('Скопировано в буфер обмена');
});
document.getElementById('btnDownloadTxt').addEventListener('click', ()=>{
  const text = document.getElementById('reportText').textContent;
  if (!text || text==='—'){ toast('Нет отчёта для скачивания'); return; }
  const t = tests.find(x=>x.id===lastReportTestId);
  const name = `test-${t?t.testNumber:'report'}-${t?t.date:todayISO()}.txt`;
  const blob = new Blob([text], {type:'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
});
async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
  }catch(e){
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  }
}

/* ---------- history ---------- */
function renderHistory(){
  const q = (document.getElementById('searchInput').value||'').toLowerCase().trim();
  const list = document.getElementById('historyList');
  const filtered = tests.filter(t=>{
    if (!q) return true;
    return [t.testNumber,t.date,t.recipe,t.goal,t.note,t.note1,t.note2].join(' ').toLowerCase().includes(q);
  });
  if (filtered.length===0){
    list.innerHTML = `<div class="empty-state"><div class="ic">🗂️</div>Тестов пока нет.<br>Заполните первый тест на вкладке «Тест».</div>`;
    return;
  }
  list.innerHTML = filtered.map(t=>{
    const c = computeTotals(t);
    const pct = c.pct2 !== null ? c.pct2 : c.pct1;
    const pctLabel = pct!==null ? fmtOrDash(pct,1)+'%' : '—';
    const parent = getParent(t);
    const childCount = getChildren(t.id).length;
    let badge = '';
    if (parent) badge = `<div><span class="chain-badge">🔗 продолжение #${escapeHtml(parent.testNumber||'?')}</span></div>`;
    else if (childCount) badge = `<div><span class="chain-badge">🔗 ${childCount} продолж.</span></div>`;
    return `<div class="test-item" data-id="${t.id}">
      <div class="test-item-main">
        <div class="test-item-title">Тест #${t.testNumber||'—'} · ${fmtDateRu(t.date)}</div>
        <div class="test-item-sub">${escapeHtml(t.recipe||'')}${t.goal? ' — '+escapeHtml(t.goal):''}</div>
        ${badge}
      </div>
      <div class="test-item-pct" style="color:${pct===null?'var(--text-faint)':(pctBadgeClass(pct)==='pct-ok'?'var(--green)':pctBadgeClass(pct)==='pct-warn'?'var(--amber)':'var(--red)')}">${pctLabel}</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.test-item').forEach(el=>{
    el.addEventListener('click', ()=> openTestActions(el.dataset.id));
  });
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
document.getElementById('searchInput').addEventListener('input', renderHistory);

/* ---------- test chain (parent/children) helpers ---------- */
function getParent(t){ return t.parentId ? tests.find(x=>x.id===t.parentId) : null; }
function getChildren(id){ return tests.filter(x=>x.parentId===id); }
function findChainRoot(t){
  let cur = t, guard = 0;
  while (cur.parentId && guard < 20){
    const p = tests.find(x=>x.id===cur.parentId);
    if (!p) break;
    cur = p;
    guard++;
  }
  return cur;
}
function hasChainFor(t){
  return !!t.parentId || tests.some(x=>x.parentId===t.id);
}
function generateChainReportText(anyTest){
  const root = findChainRoot(anyTest);
  const children = tests.filter(x=>x.parentId===root.id).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
  const c = computeTotals(root);
  let lines = [];
  lines.push(`🔗 Сквозной отчёт — Тест #${root.testNumber||'—'} · ${fmtDateRu(root.date)}`);
  lines.push(`Рецепт: ${rawOrDash(root.recipe)}`);
  lines.push('');
  lines.push(`Норма: ${fmtOrDash(c.normPer,3)} кг × ${root.levelCount} = ${fmtOrDash(c.totalNorm,3)} кг`);
  lines.push('Этап 1 (источник):');
  (root.levels||[]).forEach((l,i)=>{
    const load = parseNum(l.load), out1 = parseNum(l.out1);
    const pct1 = calcPct(c.normPer, out1);
    lines.push(`  Ур.${i+1}: факт ${fmtOrDash(load,3)} кг → выход Р1 ${fmtOrDash(out1,3)} кг${pct1!==null? `, ужарка ${fmtOrDash(pct1,1)}%`:''}`);
  });
  lines.push('');
  if (children.length===0){
    lines.push('Продолжений (этап 2) пока не найдено.');
  } else {
    lines.push(`Продолжения (этап 2) — ${children.length}:`);
    children.forEach(ch=>{
      const cc = computeTotals(ch);
      const lvlLabel = (ch.parentLevelIndex!==null && ch.parentLevelIndex!==undefined) ? `ур.${ch.parentLevelIndex+1} источника` : 'уровень источника не указан';
      lines.push(`— Тест #${ch.testNumber||'—'} · ${fmtDateRu(ch.date)} (${lvlLabel})`);
      lines.push(`   Вход Р2: ${fmtOrDash(cc.totalShockIn,3)} кг → выход Р2: ${fmtOrDash(cc.totalOut2,3)} кг`);
      const baseNormTotal = (c.normPer!==null) ? c.normPer * ch.levelCount : null;
      const endToEndPct = calcPct(baseNormTotal, cc.totalOut2);
      if (endToEndPct!==null) lines.push(`   Сквозная ужарка от нормы: ${fmtOrDash(endToEndPct,1)}%`);
      lines.push(`   Комментарий: ${ch.note? ch.note : '—'}`);
    });
  }
  lines.push('');
  if (settings.showBranding !== false){
    lines.push('—');
    lines.push('Сделано с помощью NEURAL_ARCHITECT_PREMIUM++');
    lines.push('https://smol0901-jpg.github.io/testing/index.html');
  }
  return lines.join('\n');
}
function showChainReport(t){
  showingChain = true;
  document.getElementById('reportText').textContent = generateChainReportText(t);
  document.getElementById('reportModeSeg').style.display = 'none';
  document.getElementById('btnChainReport').textContent = '← Обычный отчёт';
  document.getElementById('aiOutput').style.display = 'none';
  document.getElementById('aiOutput').textContent = '';
  renderPhotoPreview(t);
}
document.getElementById('btnChainReport').addEventListener('click', ()=>{
  const t = tests.find(x=>x.id===lastReportTestId);
  if (!t) return;
  if (showingChain) renderReport(t);
  else showChainReport(t);
});

function openTestActions(id){
  const t = tests.find(x=>x.id===id);
  if (!t) return;
  const modal = document.getElementById('actionsModal');
  document.getElementById('actionsTitle').textContent = `Тест #${t.testNumber||''} · ${fmtDateRu(t.date)}`;
  document.getElementById('actChainRow').style.display = hasChainFor(t) ? 'flex' : 'none';
  modal.classList.add('show');
  function close(){ modal.classList.remove('show'); }

  document.getElementById('actReport').onclick = ()=>{ close(); lastReportTestId=t.id; renderReport(t); showView('view-report'); };
  document.getElementById('actEdit').onclick = ()=>{ close(); fillFormFromTest(t); showView('view-form'); };
  document.getElementById('actChain').onclick = ()=>{ close(); lastReportTestId=t.id; showChainReport(t); showView('view-report'); };
  document.getElementById('actDup').onclick = ()=>{
    close();
    const copy = JSON.parse(JSON.stringify(t));
    copy.id = 't_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
    copy.testNumber = nextSuggestedNumber();
    copy.date = todayISO();
    fillFormFromTest(copy);
    editingId = null;
    showView('view-form');
    toast('Создан дубликат — измените и сохраните');
  };
  document.getElementById('actDel').onclick = ()=>{
    close();
    const childCount = getChildren(t.id).length;
    const warnText = childCount
      ? `Тест #${t.testNumber||''} будет удалён без возможности восстановления. У него есть ${childCount} связанных продолжений — цепочка потеряет источник, но сами продолжения останутся.`
      : `Тест #${t.testNumber||''} будет удалён без возможности восстановления.`;
    confirmAction('Удалить тест?', warnText, ()=>{
      tests = tests.filter(x=>x.id!==t.id);
      saveTests(tests);
      renderHistory();
      toast('Тест удалён');
    });
  };
  document.getElementById('actClose').onclick = close;
}

/* ---------- settings ---------- */
function renderSettings(){
  document.getElementById('testCountLabel').textContent = tests.length;
  const provider = settings.aiProvider || 'anthropic';
  document.getElementById('aiProvider').value = provider;
  document.getElementById('apiKeyInput').value = settings.apiKey || '';
  document.getElementById('aiModel').value = settings.aiModel || AI_DEFAULT_MODELS[provider] || '';
  document.getElementById('aiModel').placeholder = 'напр. ' + (AI_DEFAULT_MODELS[provider] || '(модель провайдера)');
  document.getElementById('aiBaseUrl').value = settings.aiBaseUrl || '';
  document.getElementById('aiBaseUrlField').style.display = provider === 'custom' ? 'block' : 'none';
  document.getElementById('f-tempMin').value = settings.tempMin || '190';
  document.getElementById('f-tempMax').value = settings.tempMax || '260';
  document.getElementById('f-showBranding').checked = settings.showBranding !== false;
  [...document.getElementById('reportModeSetting').children].forEach(b=>{
    b.classList.toggle('active', b.dataset.mode === reportMode);
  });
  Object.keys(DEFAULT_SECTIONS).forEach(key=>{
    const el = document.getElementById('sec-'+key);
    if (el) el.checked = !!reportSections[key];
  });
}
document.getElementById('f-showBranding').addEventListener('change', (e)=>{
  settings.showBranding = e.target.checked;
  saveSettings(settings);
  const t = tests.find(x=>x.id===lastReportTestId);
  if (t) { if (showingChain) showChainReport(t); else renderReport(t); }
});
document.getElementById('aiProvider').addEventListener('change', (e)=>{
  const provider = e.target.value;
  document.getElementById('aiBaseUrlField').style.display = provider === 'custom' ? 'block' : 'none';
  const modelEl = document.getElementById('aiModel');
  if (!modelEl.value.trim() || Object.values(AI_DEFAULT_MODELS).includes(modelEl.value.trim())){
    modelEl.value = AI_DEFAULT_MODELS[provider] || '';
  }
  modelEl.placeholder = 'напр. ' + (AI_DEFAULT_MODELS[provider] || '(модель провайдера)');
});
Object.keys(DEFAULT_SECTIONS).forEach(key=>{
  const el = document.getElementById('sec-'+key);
  if (!el) return;
  el.addEventListener('change', ()=>{
    reportSections[key] = el.checked;
    settings.reportSections = reportSections;
    saveSettings(settings);
    const t = tests.find(x=>x.id===lastReportTestId);
    if (t) renderReport(t);
  });
});
document.getElementById('btnOnlyStage1').addEventListener('click', ()=>{
  reportSections.stage2 = false;
  document.getElementById('sec-stage2').checked = false;
  settings.reportSections = reportSections;
  saveSettings(settings);
  toast('Отчёт: этап 2 скрыт');
  const t = tests.find(x=>x.id===lastReportTestId);
  if (t) renderReport(t);
});
document.getElementById('reportModeSetting').addEventListener('click', (e)=>{
  const btn = e.target.closest('button');
  if (!btn) return;
  reportMode = btn.dataset.mode;
  settings.reportMode = reportMode;
  saveSettings(settings);
  [...document.getElementById('reportModeSetting').children].forEach(b=> b.classList.toggle('active', b===btn));
  toast('Формат отчёта по умолчанию обновлён');
});
document.getElementById('f-tempMin').addEventListener('change', (e)=>{
  settings.tempMin = e.target.value.trim();
  saveSettings(settings);
  updateTempControls();
});
document.getElementById('f-tempMax').addEventListener('change', (e)=>{
  settings.tempMax = e.target.value.trim();
  saveSettings(settings);
  updateTempControls();
});
document.getElementById('btnSaveKey').addEventListener('click', ()=>{
  const provider = document.getElementById('aiProvider').value;
  settings.aiProvider = provider;
  settings.apiKey = document.getElementById('apiKeyInput').value.trim();
  settings.aiModel = document.getElementById('aiModel').value.trim() || AI_DEFAULT_MODELS[provider] || '';
  settings.aiBaseUrl = document.getElementById('aiBaseUrl').value.trim();
  saveSettings(settings);
  toast('Настройки нейросети сохранены');
});
document.getElementById('btnExport').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify({exportedAt:new Date().toISOString(), tests}, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `roastlab-export-${todayISO()}.json`; a.click();
  URL.revokeObjectURL(url);
  toast('Файл экспортирован');
});
document.getElementById('btnImportTrigger').addEventListener('click', ()=>{
  document.getElementById('importFile').click();
});
document.getElementById('importFile').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const data = JSON.parse(reader.result);
      const incoming = Array.isArray(data) ? data : (data.tests || []);
      if (!Array.isArray(incoming)) throw new Error('bad format');
      let added = 0, updated = 0;
      incoming.forEach(t=>{
        if (!t.id) t.id = 't_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
        const idx = tests.findIndex(x=>x.id===t.id);
        if (idx>=0){ tests[idx]=t; updated++; } else { tests.push(t); added++; }
      });
      tests.sort((a,b)=> (b.createdAt||0)-(a.createdAt||0));
      saveTests(tests);
      renderHistory();
      toast(`Импорт завершён: добавлено ${added}, обновлено ${updated}`);
    }catch(err){
      toast('Ошибка: неверный формат файла');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});
document.getElementById('btnWipe').addEventListener('click', ()=>{
  confirmAction('Удалить все тесты?', 'Это действие необратимо. Рекомендуем сначала сделать экспорт JSON.', ()=>{
    tests = [];
    saveTests(tests);
    renderHistory();
    renderSettings();
    toast('Все тесты удалены');
  });
});

/* ---------- AI analysis (provider-agnostic) ---------- */
async function callAI(prompt){
  const provider = settings.aiProvider || 'anthropic';
  const key = (settings.apiKey || '').trim();
  const model = (settings.aiModel || '').trim() || AI_DEFAULT_MODELS[provider] || '';
  if (!key) throw new Error('не задан API-ключ');
  if (!model) throw new Error('не задана модель');

  if (provider === 'anthropic'){
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ model, max_tokens: 500, messages: [{ role:'user', content: prompt }] })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
    const data = await res.json();
    return (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n\n');
  }

  if (provider === 'google'){
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
    const data = await res.json();
    const cand = (data.candidates||[])[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    return parts.map(p=>p.text||'').join('\n\n');
  }

  // openai / deepseek / custom — OpenAI-compatible chat completions
  let url;
  if (provider === 'openai') url = 'https://api.openai.com/v1/chat/completions';
  else if (provider === 'deepseek') url = 'https://api.deepseek.com/chat/completions';
  else {
    url = (settings.aiBaseUrl || '').trim();
    if (!url) throw new Error('не задан адрес API (Base URL)');
    if (!/\/chat\/completions\/?$/.test(url)) url = url.replace(/\/$/, '') + '/chat/completions';
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: 500, messages: [{ role:'user', content: prompt }] })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
  const data = await res.json();
  const choice = (data.choices||[])[0];
  return (choice && choice.message && choice.message.content) || '';
}

document.getElementById('btnAnalyze').addEventListener('click', async ()=>{
  const t = tests.find(x=>x.id===lastReportTestId);
  if (!t){ toast('Сначала сохраните и откройте отчёт теста'); return; }
  if (!settings.apiKey){
    toast('Добавьте API ключ нейросети в Настройках');
    showView('view-settings');
    return;
  }
  const out = document.getElementById('aiOutput');
  out.style.display = 'block';
  out.textContent = 'Анализирую…';
  const history = tests
    .filter(x=>x.recipe===t.recipe && x.id!==t.id)
    .slice(0,8)
    .map(x=>{
      const cc = computeTotals(x);
      return `#${x.testNumber} (${fmtDateRu(x.date)}): ужарка Р1 ${fmtOrDash(cc.pct1,1)}%, Р2 ${fmtOrDash(cc.pct2,1)}%, общая ${fmtOrDash(cc.pct2glaze,1)}%, режимы ${x.r1||'-'}/${x.r2||'-'}/${x.r3||'-'}/${x.r4||'-'}, посадка ${x.t1||'-'}/${x.t2||'-'}°C`;
    }).join('\n');

  const prompt = `Ты помогаешь пищевому технологу анализировать тесты жарки в конвекционной печи (цель — стабильная ужарка около 40% по мясу / 45% с учётом глазури, без пережара). Все проценты считаются от нормы фасовки (номинальный вес пакета до вакуумирования), поэтому потери на фасовке/вакуумировании тоже часть итоговой ужарки.

Текущий тест:
${generateReportText(t, 'full')}

Похожие тесты того же рецепта для сравнения (до 8 последних):
${history || 'нет данных для сравнения'}

Дай короткий анализ на русском (не больше 120 слов): как этот тест соотносится с целевым диапазоном ужарки, что могло повлиять на результат (время, температура посадки, глазурь, число противней, потери на фасовке), и один конкретный совет для следующего теста. Пиши по делу, без вступлений.`;

  try{
    const text = await callAI(prompt);
    out.textContent = text || 'Пустой ответ от модели.';
  }catch(err){
    out.textContent = 'Не удалось получить анализ: ' + err.message + '\n\nПроверьте провайдера, ключ, модель и подключение к интернету.';
  }
});

/* ---------- PWA install ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById('installBtn').classList.add('show');
});
document.getElementById('installBtn').addEventListener('click', async ()=>{
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  document.getElementById('installBtn').classList.remove('show');
});
window.addEventListener('appinstalled', ()=>{
  document.getElementById('installBtn').classList.remove('show');
  toast('RoastLab установлен');
});

if ('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}

/* ---------- modal backdrop click-to-close ---------- */
['confirmModal','actionsModal'].forEach(id=>{
  const modal = document.getElementById(id);
  modal.addEventListener('click', (e)=>{ if (e.target === modal) modal.classList.remove('show'); });
});

/* ---------- init ---------- */
resetForm();
renderHistory();

})();
