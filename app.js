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
  saveSettings(settings);
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
  const c = computeTotals(t);
  const multi = t.levelCount > 1;
  const detailed = multi && t.levelCount <= 6;
  const compact = multi && t.levelCount > 6;
  const full = mode === 'full';
  let lines = [];

  lines.push(`Тест #${t.testNumber || '—'} · ${fmtDateRu(t.date)}`);
  lines.push(`Рецепт: ${rawOrDash(t.recipe)}`);
  if (full || t.goal) lines.push(`Цель: ${rawOrDash(t.goal)}`);
  lines.push('');

  lines.push(`Режим 1- ${rawOrDash(t.r1)}`);
  lines.push(`Режим 2- ${rawOrDash(t.r2)}`);
  lines.push(`Режим 3- ${rawOrDash(t.r3)}`);
  lines.push(`Режим 4- ${rawOrDash(t.r4)}`);
  lines.push('');

  lines.push('Посадка:');
  lines.push(`Режим 1- ${tempWithFlag(t.t1)}`);
  lines.push(`Режим 2- ${tempWithFlag(t.t2)}`);
  if (c.deltaT!==null){
    lines.push(`Разница Р1→Р2: ${c.deltaT>=0?'+':''}${fmtOrDash(c.deltaT,0)}°C${c.deltaPct!==null? ` (${c.deltaPct>=0?'+':''}${fmtOrDash(c.deltaPct,1)}%)`:''}`);
  }
  if (full){
    lines.push(`t° мяса перед началом: ${t.tStart? t.tStart+'°C':'—'}`);
  }
  lines.push('');

  lines.push(`Норма в пакет: ${fmtOrDash(c.normPer,3)} кг × ${t.levelCount} = ${fmtOrDash(c.totalNorm,3)} кг`);
  lines.push(`Факт на противнях: ${fmtOrDash(c.totalLoad,3)} кг${full && c.pctVacLoss!==null? ` (потери фасовки/вакуума ${fmtOrDash(c.pctVacLoss,1)}%)`:''}`);
  if (full && detailed){
    c.loads.forEach((l,i)=> lines.push(`  Ур.${i+1}: ${fmtOrDash(l,3)}`));
  }
  lines.push('');

  lines.push(`Глазурь: ${rawOrDash(t.glazeRate)} г/кг${full && c.totalGlazeKg!==null? ` (≈ ${fmtOrDash(c.totalGlazeKg*1000,0)} г на партию)`:''}`);
  lines.push('');

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
  lines.push('');

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

  if (full && tempPerLevelFor(t) && (t.tempLevels||[]).length){
    lines.push('');
    lines.push('Температуры по уровням (Р1 / шокер / Р2):');
    t.tempLevels.forEach((l,i)=> lines.push(`  Ур.${i+1}: ${rawOrDash(l.probe1)}°C / ${rawOrDash(l.tempShock)}°C / ${rawOrDash(l.probe2)}°C`));
  }

  if (full){
    lines.push('');
    lines.push(`Примечание: ${rawOrDash(t.note)}`);
  } else if (t.note){
    lines.push('');
    lines.push(`Примечание: ${t.note}`);
  }

  lines.push('');
  lines.push('—');
  lines.push('Сделано с помощью NEURAL_ARCHITECT_PREMIUM++');
  lines.push('https://smol0901-jpg.github.io/neural-architect-premium-pages/');
  return lines.join('\n');
}

function renderReport(t){
  document.getElementById('reportText').textContent = generateReportText(t, reportMode);
  [...document.getElementById('reportModeSeg').children].forEach(b=>{
    b.classList.toggle('active', b.dataset.mode===reportMode);
  });
  document.getElementById('aiOutput').style.display = 'none';
  document.getElementById('aiOutput').textContent = '';
}
document.getElementById('reportModeSeg').addEventListener('click', (e)=>{
  const btn = e.target.closest('button');
  if (!btn) return;
  reportMode = btn.dataset.mode;
  const t = tests.find(x=>x.id===lastReportTestId);
  if (t) renderReport(t);
});

document.getElementById('btnShare').addEventListener('click', async ()=>{
  const text = document.getElementById('reportText').textContent;
  if (!text || text==='—'){ toast('Нет отчёта для отправки'); return; }
  if (navigator.share){
    try{ await navigator.share({ text }); }
    catch(e){ /* user cancelled */ }
  } else {
    await copyText(text);
    toast('Отчёт скопирован (Share API недоступен)');
  }
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
    return `<div class="test-item" data-id="${t.id}">
      <div class="test-item-main">
        <div class="test-item-title">Тест #${t.testNumber||'—'} · ${fmtDateRu(t.date)}</div>
        <div class="test-item-sub">${escapeHtml(t.recipe||'')}${t.goal? ' — '+escapeHtml(t.goal):''}</div>
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

function openTestActions(id){
  const t = tests.find(x=>x.id===id);
  if (!t) return;
  const modal = document.getElementById('actionsModal');
  document.getElementById('actionsTitle').textContent = `Тест #${t.testNumber||''} · ${fmtDateRu(t.date)}`;
  modal.classList.add('show');
  function close(){ modal.classList.remove('show'); }

  document.getElementById('actReport').onclick = ()=>{ close(); lastReportTestId=t.id; renderReport(t); showView('view-report'); };
  document.getElementById('actEdit').onclick = ()=>{ close(); fillFormFromTest(t); showView('view-form'); };
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
    confirmAction('Удалить тест?', `Тест #${t.testNumber||''} будет удалён без возможности восстановления.`, ()=>{
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
  document.getElementById('apiKeyInput').value = settings.apiKey || '';
  document.getElementById('f-tempMin').value = settings.tempMin || '190';
  document.getElementById('f-tempMax').value = settings.tempMax || '260';
  [...document.getElementById('reportModeSetting').children].forEach(b=>{
    b.classList.toggle('active', b.dataset.mode === reportMode);
  });
}
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
  settings.apiKey = document.getElementById('apiKeyInput').value.trim();
  saveSettings(settings);
  toast('Ключ сохранён локально');
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

/* ---------- AI analysis ---------- */
document.getElementById('btnAnalyze').addEventListener('click', async ()=>{
  const t = tests.find(x=>x.id===lastReportTestId);
  if (!t){ toast('Сначала сохраните и откройте отчёт теста'); return; }
  if (!settings.apiKey){
    toast('Добавьте API ключ в Настройках');
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
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role:'user', content: prompt }]
      })
    });
    if (!res.ok){
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.slice(0,200)}`);
    }
    const data = await res.json();
    const textBlocks = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text);
    out.textContent = textBlocks.join('\n\n') || 'Пустой ответ от модели.';
  }catch(err){
    out.textContent = 'Не удалось получить анализ: ' + err.message + '\n\nПроверьте ключ и подключение к интернету.';
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
