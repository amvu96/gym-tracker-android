/* ============================================================
   NULLVAULT — training log
   Vanilla JS, offline-first, localStorage-backed.
   ============================================================ */
(function(){
'use strict';

// Bump this on every code change (even small ones). Shown in Settings so a
// stale/cached build can be identified at a glance instead of guessing —
// if what you see on-device doesn't match what should have shipped, this
// number tells you whether you're actually running the latest code.
const APP_VERSION = 'v1.48.0';

const STORAGE_KEY = 'gymtracker_data_v1';
const LB_PER_KG = 2.20462;

/* ---------------- STATE ---------------- */
let state = loadState();
let currentView = 'home';
let activeWorkout = null; // {startedAt, exercises:[{exId, name, sets:[{weight,reps,done}], notes}]}
let pickerMode = 'session'; // 'session' = adding to activeWorkout, 'template' = adding to editingTemplateExIds, 'superset' = adding to activeWorkout AND linking with pendingSupersetSourceIdx
let pendingSupersetSourceIdx = null; // set when the picker was opened via the per-exercise Link button
let workoutTimerInterval = null;
let calCursor = new Date(); // month being viewed in calendar
let customExercises = [];
// Template IDs dismissed from today's "Scheduled for today" suggestion.
// Intentionally in-memory only (not persisted/synced) — a dismissal is a
// same-day "not today" choice, not data worth backing up, and naturally
// resets on next load or the next calendar day either way.
let dismissedTodayRoutines = new Set();
let pendingSharedRoutine = null; // decoded {v,n,e} payload from a #routine= link, until dismissed/imported

function defaultState(){
  return {
    sessions: [],          // {id, date(ISO), exercises:[{exId,name,sets,notes}], durationMin, kcal, type}
    settings: {
      bodyWeightKg: 75,
      weeklyGoal: 4,
      useLbs: false,
      lastBackupAt: null,
      notificationsEnabled: false
    },
    customExercises: [],
    templates: [],          // {id, name, exIds:[...], createdAt}
    bodyWeightLogs: []      // {id, date(ISO), weightKg} — separate from settings.bodyWeightKg,
                            // which stays purely the input to the kcal-estimate formula
  };
}

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed, {
      settings: Object.assign(defaultState().settings, parsed.settings || {})
    });
  }catch(e){
    console.error('Failed to load state', e);
    return defaultState();
  }
}

function saveState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if(window.GymSync) window.GymSync.push(state);
}

/* ---------------- ACTIVE WORKOUT PERSISTENCE ----------------
   activeWorkout lives in memory during a session, but must survive page
   refreshes/crashes, so every mutation is mirrored to localStorage under
   its own key and restored on load.
------------------------------------------------- */
const ACTIVE_WORKOUT_KEY = 'gymtracker_active_workout_v1';

function persistActiveWorkout(){
  try{
    if(activeWorkout){
      localStorage.setItem(ACTIVE_WORKOUT_KEY, JSON.stringify(activeWorkout));
    } else {
      localStorage.removeItem(ACTIVE_WORKOUT_KEY);
    }
  }catch(e){
    console.error('Failed to persist active workout', e);
  }
}

function loadActiveWorkout(){
  try{
    const raw = localStorage.getItem(ACTIVE_WORKOUT_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(!parsed || !Array.isArray(parsed.exercises) || !parsed.date || !parsed.startedAt) return null;
    return parsed;
  }catch(e){
    console.error('Failed to load active workout', e);
    return null;
  }
}

/* ---------------- HELPERS ---------------- */
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function fmtDateISO(d){
  const y = d.getFullYear();
  const m = (d.getMonth()+1).toString().padStart(2,'0');
  const day = d.getDate().toString().padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function todayISO(){ return fmtDateISO(new Date()); }
function parseISO(iso){ const [y,m,d]=iso.split('-').map(Number); return new Date(y,m-1,d); }
function sameDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
function allExercises(){ return EXERCISE_DB.concat(state.customExercises); }
function findExercise(id){ return allExercises().find(e=>e.id===id); }

/* ---------------- ROUTINE SHARING (URL-embedded, no backend) ----------------
   A shared routine's whole payload (name + exercise ids + supersets + rest
   times) is base64'd straight into the link's hash fragment — no server or
   Firestore doc needed, consistent with the rest of this app being
   offline/local-first. Only built-in EXERCISE_DB ids are shareable (not
   customExercises), since a custom exercise id has nothing to resolve
   against on the recipient's device. ------------------------------------- */
function b64EncodeUtf8(str){
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b=>{ bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64DecodeUtf8(b64){
  let s = b64.replace(/-/g,'+').replace(/_/g,'/');
  while(s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, c=>c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
// Encodes a template into a compact payload: {v, n, e:[[exId,restSeconds,supersetGroupIndex], ...]}.
// Returns {b64, skippedCount} — skippedCount is how many exercises were
// custom (unshareable) and got left out.
// Payload v2: exercises identified by their numeric position in the
// built-in EXERCISE_DB array instead of their full string id, and each
// entry is a sparse object with single-letter keys that simply omit rest
// (r) / superset group (g) when unset, rather than writing out an explicit
// null placeholder for every plain exercise. Spelling out ids like
// "cable-woodchopper" three times over, inflated another ~33% by base64,
// was by far the biggest contributor to shared-routine links (and their
// QR codes) getting unreasonably long for anything beyond a handful of
// exercises. v1 links people already have out in the wild still decode
// correctly — see decodeShareableRoutine, which normalizes either version
// down to the same shape before anything else in the app touches it.
function encodeShareableRoutine(t){
  const groupMap = {};
  let nextGroup = 0;
  let skippedCount = 0;
  const e = t.exIds.map((exId, idx)=>{
    const dbIdx = EXERCISE_DB.findIndex(d=>d.id===exId);
    if(dbIdx===-1){ skippedCount++; return null; } // custom exercise — not in the shared catalog, can't be shared
    const entry = {i: dbIdx};
    const gid = t.supersetGroups && t.supersetGroups[idx];
    if(gid){
      if(!(gid in groupMap)) groupMap[gid] = nextGroup++;
      entry.g = groupMap[gid];
    }
    const rest = (t.restSeconds && t.restSeconds[idx]!=null) ? t.restSeconds[idx] : null;
    if(rest!=null) entry.r = rest;
    return entry;
  }).filter(Boolean);
  const payload = {v:2, n:t.name, e};
  return {b64: b64EncodeUtf8(JSON.stringify(payload)), skippedCount};
}
function decodeShareableRoutine(b64){
  const payload = JSON.parse(b64DecodeUtf8(b64));
  if(!payload || !Array.isArray(payload.e)) throw new Error('Malformed routine link');

  if(payload.v===2){
    // Normalize to the same [exId, rest, groupIdx] triples v1 already used,
    // so nothing downstream (the preview page, the importer) needs to know
    // there's more than one payload version at all.
    payload.e = payload.e
      .map(entry=>{
        const def = EXERCISE_DB[entry.i];
        return def ? [def.id, entry.r!=null?entry.r:null, entry.g!=null?entry.g:null] : null;
      })
      .filter(Boolean);
    return payload;
  }
  if(payload.v===1){
    return payload; // already [exId, rest, groupIdx] triples
  }
  throw new Error('Unsupported routine link version');
}
function shareableRoutineLink(b64){
  return `${location.origin}${location.pathname}#routine=${b64}`;
}

// Small QR renderer local to app.js (groups.js has its own copy — separate
// script scope, both just call the same globally-loaded QRCode library).
function renderAppQr(text, elId){
  const el = document.getElementById(elId);
  if(!el) return;
  el.innerHTML = '';
  if(window.QRCode){
    new window.QRCode(el, { text, width:180, height:180, colorDark:'#0a0e0f', colorLight:'#d7e5e2' });
  } else {
    el.innerHTML = '<p class="text-sm text-muted">QR code unavailable offline — share the link instead.</p>';
  }
}

function showShareRoutineSheet(templateId){
  const t = state.templates.find(x=>x.id===templateId);
  if(!t) return;
  const {b64, skippedCount} = encodeShareableRoutine(t);
  const link = shareableRoutineLink(b64);
  document.getElementById('shareRoutineLinkText').textContent = link;
  document.getElementById('shareRoutineNote').textContent = skippedCount>0
    ? `Anyone who opens this link or scans this code can see the routine and import it. ${skippedCount} custom exercise${skippedCount!==1?'s':''} in it won't be included, since they only exist on your device.`
    : 'Anyone who opens this link or scans this code can see the routine and choose to import it into their own app. No account needed.';
  openSheet('sheetShareRoutine');
  renderAppQr(link, 'shareRoutineQr');

  document.getElementById('btnCopyRoutineLink').onclick = async ()=>{
    try{ await navigator.clipboard.writeText(link); toast('Link copied'); }
    catch(e){ toast('Could not copy — long-press to copy manually'); }
  };
  document.getElementById('btnShareRoutineNative').onclick = async ()=>{
    if(navigator.share){
      try{ await navigator.share({title:`"${t.name}" routine`, url:link}); }
      catch(e){ /* user cancelled the share sheet — no action needed */ }
    } else {
      try{ await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch(e){ toast(link); }
    }
  };
}

/* ---------------- SHARED ROUTINE (import) VIEW ---------------- */
function renderSharedRoutineView(){
  const wrap = document.getElementById('sharedRoutineContent');
  const payload = pendingSharedRoutine;
  if(!payload){
    wrap.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M18 6L6 18M6 6l12 12"/></svg>
      <p>This routine link is invalid or has expired.</p>
    </div>`;
    return;
  }

  const resolved = payload.e.map(([exId, rest, grp])=>{
    const def = findExercise(exId);
    return def ? {exId, def, rest, grp} : null;
  });
  const skippedCount = resolved.filter(r=>!r).length;
  const found = resolved.filter(Boolean);

  currentMuscleMapView = 'front';
  const highlights = computeMuscleIntensityFromExerciseIds(found.map(r=>r.exId));

  wrap.innerHTML = `
    <div class="card mb-16">
      <div class="settings-row-label" style="font-size:19px;">${payload.n}</div>
      <div class="text-sm text-faint mt-4">${found.length} exercise${found.length!==1?'s':''}${skippedCount>0?` · ${skippedCount} unavailable`:''}</div>
    </div>
    <div id="sharedRoutineMusclesMap" class="mb-16"></div>
    <h2 class="section-label">Exercises</h2>
    <div id="sharedRoutineExerciseList" class="mb-16"></div>
    ${skippedCount>0 ? `<p class="text-sm text-faint mb-16">${skippedCount} exercise${skippedCount!==1?'s':''} in this routine couldn't be matched on this device and won't be imported.</p>` : ''}
    <button class="btn btn-primary btn-block mb-8" id="btnImportSharedRoutine">Import into my routines</button>
    <button class="btn btn-secondary btn-block" id="btnNotNowSharedRoutine">Not now</button>
  `;

  renderMuscleMapCard('sharedRoutineMusclesMap', highlights, {
    title: 'Muscles worked',
    emptyMessage: 'No muscle data available for this routine.'
  });

  const list = document.getElementById('sharedRoutineExerciseList');
  if(found.length===0){
    list.innerHTML = `<p class="text-sm text-faint" style="padding:8px 2px;">None of this routine's exercises are available on this device.</p>`;
  } else {
    list.innerHTML = found.map(r=>`
      <div class="reorder-item">
        <div class="reorder-item-top">
          <div class="ex-icon">${r.def.icon}</div>
          <div class="ex-info">
            <div class="ex-name">${r.def.name}</div>
            <div class="ex-meta">${capitalize(r.def.muscle)}${r.grp!=null?' · Superset':''}</div>
          </div>
          <div class="text-sm text-faint" style="flex-shrink:0;">${formatRestShort(r.rest!=null?r.rest:90)} rest</div>
        </div>
      </div>
    `).join('');
  }

  document.getElementById('btnImportSharedRoutine').addEventListener('click', importSharedRoutine);
  document.getElementById('btnNotNowSharedRoutine').addEventListener('click', dismissSharedRoutine);
}

function importSharedRoutine(){
  if(!pendingSharedRoutine) return;
  const payload = pendingSharedRoutine;
  const groupIdMap = {};
  const exIds = [], supersetGroups = [], restSeconds = [];

  payload.e.forEach(([exId, rest, grp])=>{
    if(!findExercise(exId)) return; // not available on this device — skip
    exIds.push(exId);
    restSeconds.push(rest!=null ? rest : null);
    if(grp!=null){
      if(!(grp in groupIdMap)) groupIdMap[grp] = uid();
      supersetGroups.push(groupIdMap[grp]);
    } else {
      supersetGroups.push(null);
    }
  });

  if(exIds.length===0){
    toast('None of these exercises are available on this device');
    return;
  }

  state.templates.push({
    id: uid(),
    name: payload.n,
    exIds, supersetGroups, restSeconds,
    scheduledDays: [],
    createdAt: Date.now()
  });
  saveState();
  toast(`Imported "${payload.n}"`);
  pendingSharedRoutine = null;
  showView('templates');
}

function dismissSharedRoutine(){
  pendingSharedRoutine = null;
  showView('home');
}

// Extracts an 11-char YouTube video ID from any common URL shape
// (watch?v=, youtu.be/, shorts/, embed/) so we can build a thumbnail URL
// and a clean watch link without needing an API call.
function getYouTubeId(url){
  if(!url) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtube\.com\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  ];
  for(const re of patterns){
    const m = url.match(re);
    if(m) return m[1];
  }
  return null;
}
function kgToDisplay(kg){ return state.settings.useLbs ? Math.round(kg*LB_PER_KG*10)/10 : kg; }
function displayToKg(val){ return state.settings.useLbs ? val/LB_PER_KG : val; }
function unitLabel(){ return state.settings.useLbs ? 'lb' : 'kg'; }

function toast(msg){
  const t = document.getElementById('toast');
  document.getElementById('toastText').textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(()=>t.classList.remove('show'), 2200);
}

/* ---------------- KCAL ESTIMATION ----------------
   Strength: kcal = MET * bodyWeightKg * (setTime_hr) — approximated using
   ~30s effective work time per set at moderate intensity.
   Cardio/incline walk: standard treadmill MET formula (ACSM walking) adjusted for grade.
------------------------------------------------- */
function estimateSetKcal(met, bodyWeightKg, seconds){
  // kcal = MET * 3.5 * weight(kg) / 200 * minutes
  const minutes = seconds/60;
  return met * 3.5 * bodyWeightKg / 200 * minutes;
}

function estimateStrengthExerciseKcal(exercise, sets, bodyWeightKg, restSeconds){
  const met = exercise.met || 4.5;
  // Count any set with logged weight or reps as one unit of work, not just
  // ones explicitly checked "done" — checking off a set is optional, so kcal
  // shouldn't depend on it.
  const completedSets = sets.filter(s=>s.done || s.weight || s.reps).length;
  // MET values for resistance training (per the Compendium of Physical
  // Activities) are measured across a full session INCLUDING rest between
  // sets, not just active lifting time — a "6.0 MET" barbell row already
  // has typical rest periods baked into that average. Applying the MET to
  // only ~30s of active time per set (ignoring the rest that comes with it)
  // understates real energy expenditure substantially. Use the session's
  // actual configured rest duration (falls back to 90s, the app default)
  // plus a representative ~30s of active lifting time per set.
  const activeSecondsPerSet = 30;
  const secondsPerSet = activeSecondsPerSet + (restSeconds!=null ? restSeconds : 90);
  const workSeconds = completedSets * secondsPerSet;
  return estimateSetKcal(met, bodyWeightKg, workSeconds);
}

// ACSM walking MET estimate: VO2 (ml/kg/min) = 0.1*speed(m/min) + 1.8*speed(m/min)*grade + 3.5
function estimateInclineWalkKcal(speedKmh, inclinePct, minutes, bodyWeightKg){
  const speedMmin = (speedKmh*1000)/60;
  const grade = inclinePct/100;
  const vo2 = 0.1*speedMmin + 1.8*speedMmin*grade + 3.5;
  const met = vo2/3.5;
  return estimateSetKcal(met, bodyWeightKg, minutes*60);
}

// General/daily walking (steps and/or distance, no treadmill incline or
// speed to go on). ~0.5 kcal per kg of bodyweight per km is a well-established
// rule of thumb for moderate-pace walking, cross-checked against the ACSM
// MET formula across several sources — it needs no pace/incline input,
// which suits a simple steps/km entry instead of a treadmill console.
const STEPS_PER_KM = 1300; // population-average stride (~0.77m); used only
                            // when distance isn't entered directly
function estimateGeneralWalkKcal(distanceKm, bodyWeightKg){
  return 0.5 * bodyWeightKg * distanceKm;
}
function stepsToKm(steps){
  return steps / STEPS_PER_KM;
}

function estimateCardioKcal(exercise, minutes, bodyWeightKg){
  return estimateSetKcal(exercise.met, bodyWeightKg, minutes*60);
}

function sessionTotalKcal(session){
  return session.kcal || 0;
}

/* ---------------- NAVIGATION ---------------- */
function showView(name){
  currentView = name;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.view===name);
  });

  const tabbar = document.querySelector('.tabbar');
  // Full-screen, tabbar-hidden views — 'workout' additionally gets the
  // in-progress-session chrome (finish bar etc.), 'shared-routine' is a
  // simple interstitial (preview/import a routine someone sent you) that
  // just needs the tabbar out of the way, nothing session-specific.
  if(name==='workout' || name==='shared-routine'){
    tabbar.classList.add('hidden');
  } else {
    tabbar.classList.remove('hidden');
  }
  if(name==='workout'){
    document.body.classList.add('workout-active');
    if(activeWorkout) ensureFinishBar();
  } else {
    document.body.classList.remove('workout-active');
    removeFinishBar();
  }
  syncFabState();

  if(name==='home') renderHome();
  if(name==='calendar') renderCalendar();
  if(name==='log') renderExerciseLibrary();
  if(name==='progress') renderProgressList();
  if(name==='templates') renderTemplatesFullList();
  if(name==='groups' && window.GymGroups) window.GymGroups.onShow();
  if(name==='shared-routine') renderSharedRoutineView();
  window.scrollTo(0,0);
}

function syncFabState(){
  const fab = document.getElementById('btnFabStart');
  if(!fab) return;
  fab.classList.toggle('active-session', !!activeWorkout);
  fab.setAttribute('aria-label', activeWorkout ? 'Resume session' : 'Start session');
}

document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    showView(btn.dataset.view);
  });
});

document.getElementById('btnFabStart').addEventListener('click', ()=>{
  pickerMode = 'session';
  startWorkout(todayISO());
});

document.getElementById('btnSettings').addEventListener('click', ()=>{
  showView('settings');
  loadSettingsIntoForm();
});

document.getElementById('btnDismissSharedRoutine').addEventListener('click', dismissSharedRoutine);

/* ---------------- HOME VIEW ---------------- */
function renderHome(){
  const now = new Date();
  document.getElementById('todayDateLabel').textContent = now.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'});

  const todaySession = state.sessions.find(s=>s.date===todayISO());
  document.getElementById('todayStatusLabel').textContent = todaySession
    ? `Logged: ${todaySession.exercises.length} exercise${todaySession.exercises.length!==1?'s':''}`
    : 'Ready when you are.';

  // streak
  const streak = computeStreak();
  document.getElementById('streakText').innerHTML = `<b>${streak}</b> day streak`;

  // week stats — calendar week (Mon-Sun), matching the M T W T F S S strip below.
  // A standalone walk log (steps/km, no exercises) contributes to kcal/wk but
  // is not itself a "session" for the sessions-per-week count or goal ring —
  // it's daily activity, not a workout you completed.
  const weekSessions = sessionsThisCalendarWeek();
  const weekWorkoutSessions = weekSessions.filter(s=>!(s.type==='walk' && s.exercises.length===0));
  const weekKcal = Math.round(weekSessions.reduce((a,s)=>a+sessionTotalKcal(s),0));
  document.getElementById('statWeekSessions').textContent = weekWorkoutSessions.length;
  document.getElementById('statWeekKcal').textContent = weekKcal;
  document.getElementById('statTotalSessions').textContent = state.sessions.length;

  // week ring
  const goal = state.settings.weeklyGoal || 4;
  const pct = Math.min(1, weekWorkoutSessions.length/goal);
  const circumference = 201;
  document.getElementById('weekRingFg').style.strokeDashoffset = circumference*(1-pct);
  document.getElementById('weekRingPct').textContent = Math.round(pct*100)+'%';

  // week days strip (Mon-Sun of current week) — tapping any day opens the
  // Calendar view (no longer its own bottom-nav tab) scrolled to that day's
  // month, since Progress took Calendar's slot in the tabbar.
  const strip = document.getElementById('weekDaysStrip');
  strip.innerHTML = '';
  const dow = ['M','T','W','T','F','S','S'];
  const monday = startOfWeek(now);
  for(let i=0;i<7;i++){
    const d = new Date(monday); d.setDate(monday.getDate()+i);
    const iso = fmtDateISO(d);
    const has = state.sessions.some(s=>s.date===iso);
    const el = document.createElement('div');
    el.className = 'week-day' + (has?' done':'') + (sameDay(d,now)?' today':'');
    el.textContent = dow[i];
    el.addEventListener('click', ()=>{
      calCursor = new Date(d);
      showView('calendar');
    });
    strip.appendChild(el);
  }

  renderRecentSessions();
  renderTemplatesQuickRow();
  renderTodayRoutineSuggestion();
}

function renderTodayRoutineSuggestion(){
  const wrap = document.getElementById('todayRoutineCard');
  const today = new Date();
  const todayIdx = (today.getDay()+6)%7; // 0=Mon, matches the app's existing convention
  const todayIso = todayISO();

  const scheduled = (state.templates||[])
    .filter(t=>t.scheduledDays && t.scheduledDays.includes(todayIdx))
    .filter(t=>!dismissedTodayRoutines.has(t.id));

  // Group challenges the person's group(s) have active today — sourced from
  // groups.js, which owns the live Firestore listeners this needs. Shown in
  // the same carousel as routine suggestions, visually distinguished (red)
  // rather than as a separate section. Dismiss key is per (group, challenge)
  // pair, not just group, since one group can have several active
  // challenges now — dismissing one shouldn't hide the others.
  const groupCards = ((window.GymGroups && window.GymGroups.getHomeChallengeCards)
    ? window.GymGroups.getHomeChallengeCards() : [])
    .filter(g=>!dismissedTodayRoutines.has(`group-${g.groupId}-${g.challengeId}`));

  if(scheduled.length===0 && groupCards.length===0){
    wrap.style.display = 'none';
    return;
  }

  const alreadyLogged = state.sessions.some(s=>s.date===todayIso);
  const totalSlides = scheduled.length + groupCards.length;

  wrap.style.display = 'block';
  wrap.innerHTML = `
    <div class="today-routine-carousel" id="todayRoutineCarousel">
      ${scheduled.map(t=>`
        <div class="today-routine-card">
          <button class="today-routine-dismiss" data-dismiss-today-routine="${t.id}" aria-label="Not today">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
          <div class="today-routine-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            Scheduled for today
          </div>
          <div class="today-routine-header" data-start-today-routine="${t.id}">
            <div class="template-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </div>
            <div class="today-routine-info">
              <div class="today-routine-name">${t.name}</div>
              <div class="today-routine-meta">${t.exIds.length} exercise${t.exIds.length!==1?'s':''}${alreadyLogged?' · Already logged today':''}</div>
            </div>
            <div class="today-routine-chevron">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
            </div>
          </div>
        </div>
      `).join('')}
      ${groupCards.map(g=>`
        <div class="today-routine-card group-challenge">
          <button class="today-routine-dismiss" data-dismiss-today-routine="group-${g.groupId}-${g.challengeId}" aria-label="Not today">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
          <div class="today-routine-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><circle cx="17" cy="7" r="3"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>
            Group challenge · ${escapeHtmlLocal(g.groupName)}
          </div>
          <div class="today-routine-header" data-open-group-challenge="${g.groupId}">
            <div class="template-icon" style="color:var(--danger); border-color:var(--danger-dim); background:var(--danger-dim);">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </div>
            <div class="today-routine-info">
              <div class="today-routine-name">${escapeHtmlLocal(g.title)}</div>
              <div class="today-routine-meta${g.doneToday?' done':''}">${g.doneToday ? '✓ Done today' : escapeHtmlLocal(g.targetLabel || 'Not done yet')}</div>
            </div>
            <div class="today-routine-chevron">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
    ${totalSlides>1 ? `<div class="routine-carousel-dots" id="todayRoutineDots">
      ${Array.from({length:totalSlides}).map((_,i)=>`<div class="routine-carousel-dot ${i===0?'active':''}" data-dot="${i}"></div>`).join('')}
    </div>` : ''}
  `;

  wrap.querySelectorAll('[data-start-today-routine]').forEach(el=>{
    el.addEventListener('click', ()=>{
      startWorkoutFromTemplate(el.dataset.startTodayRoutine);
    });
  });
  wrap.querySelectorAll('[data-dismiss-today-routine]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      dismissedTodayRoutines.add(btn.dataset.dismissTodayRoutine);
      renderTodayRoutineSuggestion();
    });
  });
  wrap.querySelectorAll('[data-open-group-challenge]').forEach(el=>{
    el.addEventListener('click', ()=>{
      if(window.GymGroups && window.GymGroups.openGroupFromHome){
        window.GymGroups.openGroupFromHome(el.dataset.openGroupChallenge);
      }
    });
  });

  if(totalSlides>1){
    const carousel = document.getElementById('todayRoutineCarousel');
    const dotsWrap = document.getElementById('todayRoutineDots');
    carousel.onscroll = ()=>{
      clearTimeout(carousel._scrollDebounce);
      carousel._scrollDebounce = setTimeout(()=>{
        const cardWidth = carousel.clientWidth;
        if(cardWidth===0) return;
        const activeIdx = Math.round(carousel.scrollLeft / cardWidth);
        dotsWrap.querySelectorAll('.routine-carousel-dot').forEach((dot,i)=>{
          dot.classList.toggle('active', i===activeIdx);
        });
      }, 60);
    };
  }
}

// Minimal HTML-escape for text sourced from group data (group/challenge
// names a group owner typed, not hardcoded template strings) before it's
// interpolated into innerHTML.
function escapeHtmlLocal(s){
  return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderTemplatesQuickRow(){
  const wrap = document.getElementById('templatesQuickRow');
  const carousel = document.getElementById('routineCarousel');
  const dotsWrap = document.getElementById('routineCarouselDots');
  if(!state.templates || state.templates.length===0){
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  const sorted = [...state.templates].sort((a,b)=>b.createdAt-a.createdAt);

  carousel.innerHTML = sorted.map(t=>`
    <div class="routine-card" data-template="${t.id}">
      <div class="template-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
      </div>
      <div class="template-info">
        <div class="template-title">${t.name}</div>
        <div class="template-meta">${t.exIds.length} exercise${t.exIds.length!==1?'s':''}</div>
      </div>
      <button class="template-delete" data-delete-template="${t.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
      </button>
    </div>
  `).join('');

  // dots only make sense (and only need showing) when there's more than one
  // routine to swipe between
  dotsWrap.style.display = sorted.length>1 ? 'flex' : 'none';
  dotsWrap.innerHTML = sorted.map((_,i)=>`<div class="routine-carousel-dot ${i===0?'active':''}" data-dot="${i}"></div>`).join('');

  carousel.querySelectorAll('[data-delete-template]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const id = e.currentTarget.dataset.deleteTemplate;
      const t = state.templates.find(x=>x.id===id);
      if(!t) return;
      const ok = await confirmDialog({
        title: 'Delete routine?',
        message: `"${t.name}" will be permanently deleted. This cannot be undone.`,
        confirmLabel: 'Delete routine'
      });
      if(ok){
        state.templates = state.templates.filter(x=>x.id!==id);
        saveState();
        renderTemplatesQuickRow();
        toast('Routine deleted');
      }
    });
  });
  carousel.querySelectorAll('.routine-card').forEach(item=>{
    item.addEventListener('click', ()=>{
      startWorkoutFromTemplate(item.dataset.template);
    });
  });

  // update active dot as the user swipes, based on which card is currently
  // most in view (scrollLeft / card width, rounded to nearest card)
  carousel.onscroll = ()=>{
    clearTimeout(carousel._scrollDebounce);
    carousel._scrollDebounce = setTimeout(()=>{
      const cardWidth = carousel.clientWidth;
      if(cardWidth===0) return;
      const activeIdx = Math.round(carousel.scrollLeft / cardWidth);
      dotsWrap.querySelectorAll('.routine-carousel-dot').forEach((dot,i)=>{
        dot.classList.toggle('active', i===activeIdx);
      });
    }, 60);
  };
}

function startWorkoutFromTemplate(templateId){
  const template = state.templates.find(t=>t.id===templateId);
  if(!template) return;
  if(!activeWorkout){
    activeWorkout = {startedAt: Date.now(), date: todayISO(), exercises:[], restDuration: 90};
    startWorkoutTimer();
  }
  template.exIds.forEach((exId,idx)=>{
    const def = findExercise(exId);
    if(!def) return; // exercise may have been removed since template was saved
    const restOverride = template.restSeconds && template.restSeconds[idx]!=null ? template.restSeconds[idx] : null;
    activeWorkout.exercises.push({
      exId: def.id,
      name: def.name,
      sets: [{weight:'', reps:'', difficulty:'medium', done:false}],
      notes:'',
      supersetGroup: (template.supersetGroups && template.supersetGroups[idx]) || null,
      restDuration: restOverride,
      restDurationCustomized: restOverride!=null
    });
  });
  toast(`Loaded "${template.name}"`);
  showView('workout');
  renderWorkoutView();
}

/* ---------------- TEMPLATES TAB (full management) ---------------- */
function renderTemplatesFullList(){
  const container = document.getElementById('templatesFullList');
  if(!state.templates || state.templates.length===0){
    container.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
      <p>No routines yet. Save one after finishing a session, or build one from scratch.</p>
    </div>`;
    return;
  }
  const sorted = [...state.templates].sort((a,b)=>b.createdAt-a.createdAt);
  container.innerHTML = sorted.map(t=>{
    const defs = t.exIds.map(id=>findExercise(id)).filter(Boolean);
    const names = defs.map(d=>d.name);
    const preview = names.slice(0,3).join(' · ');
    const more = names.length>3 ? ` +${names.length-3} more` : '';
    // Representative icon: the first exercise's emoji, falling back to a
    // generic routine glyph for an (unlikely) fully-empty routine.
    const cardIcon = defs.length ? defs[0].icon : '🏋️';
    return `<div class="routine-list-card" data-template-card="${t.id}">
      <div class="routine-list-top">
        <div class="template-icon routine-list-icon">${cardIcon}</div>
        <div class="ex-info" style="min-width:0;">
          <div class="ex-name">${t.name}</div>
          <div class="ex-meta">${names.length} exercise${names.length!==1?'s':''}${preview? ' · '+preview+more : ''}</div>
        </div>
        <div class="routine-list-actions">
          <button class="icon-btn" data-share-template="${t.id}" aria-label="Share routine" title="Share routine">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.6" x2="15.4" y2="6.4"/><line x1="8.6" y1="13.4" x2="15.4" y2="17.6"/></svg>
          </button>
          <button class="icon-btn" data-edit-template="${t.id}" aria-label="Edit routine" title="Edit routine">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
          </button>
        </div>
      </div>
      <button class="btn btn-primary btn-sm btn-block mt-12" data-start-template="${t.id}">Start</button>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-start-template]').forEach(btn=>{
    btn.addEventListener('click', ()=>startWorkoutFromTemplate(btn.dataset.startTemplate));
  });
  container.querySelectorAll('[data-edit-template]').forEach(btn=>{
    btn.addEventListener('click', ()=>openTemplateEditor(btn.dataset.editTemplate));
  });
  container.querySelectorAll('[data-share-template]').forEach(btn=>{
    btn.addEventListener('click', ()=>showShareRoutineSheet(btn.dataset.shareTemplate));
  });
}

let editingTemplateId = null; // null = creating a new template from scratch

document.getElementById('btnNewTemplate').addEventListener('click', ()=>{
  openTemplateEditor(null);
});

function openTemplateEditor(templateId){
  editingTemplateId = templateId;
  const template = templateId ? state.templates.find(t=>t.id===templateId) : null;
  // working copy of exercise ids so cancelling (closing without saving) doesn't mutate state
  editingTemplateExIds = template ? [...template.exIds] : [];
  // parallel array, same length/index as editingTemplateExIds: null = not
  // grouped, otherwise a shared group id string linking a superset together.
  // Kept as its own array (rather than merging into exId objects) so the
  // existing reorder/add/remove code above never needs to change.
  editingTemplateSupersetGroups = template && template.supersetGroups
    ? [...template.supersetGroups]
    : editingTemplateExIds.map(()=>null);
  // parallel array, same shape as above: null = "use the 90s session
  // default when this routine is started", otherwise a per-exercise rest
  // override in seconds, carried into activeWorkout when the routine loads.
  editingTemplateRestSeconds = template && template.restSeconds
    ? [...template.restSeconds]
    : editingTemplateExIds.map(()=>null);
  editingTemplateScheduledDays = template && template.scheduledDays ? [...template.scheduledDays] : [];
  refreshTemplateEditorSheet(template ? template.name : '');
  renderDayPicker();
  openSheet('sheetEditTemplate');
}

function renderDayPicker(){
  document.querySelectorAll('#editTemplateDayPicker .day-picker-chip').forEach(chip=>{
    const day = +chip.dataset.day;
    chip.classList.toggle('selected', editingTemplateScheduledDays.includes(day));
  });
}

document.getElementById('editTemplateDayPicker').addEventListener('click', (e)=>{
  const chip = e.target.closest('.day-picker-chip');
  if(!chip) return;
  const day = +chip.dataset.day;
  const idx = editingTemplateScheduledDays.indexOf(day);
  if(idx>=0){
    editingTemplateScheduledDays.splice(idx,1);
  } else {
    editingTemplateScheduledDays.push(day);
  }
  renderDayPicker();
});

function refreshTemplateEditorSheet(nameValue){
  document.getElementById('editTemplateTitle').textContent = editingTemplateId ? 'Edit template' : 'New template';
  if(nameValue !== undefined) document.getElementById('editTemplateNameInput').value = nameValue;
  document.getElementById('btnDeleteTemplateFromEditor').style.display = editingTemplateId ? 'flex' : 'none';
  renderTemplateEditorExerciseList();
}

let editingTemplateExIds = [];
let editingTemplateSupersetGroups = [];
let editingTemplateRestSeconds = [];
let editingTemplateScheduledDays = [];

// Returns the contiguous [start,end] index range that must move together
// as one block for the exercise at idx — a 2-element range if idx is part
// of a superset pair (supersets are always exactly 2 adjacent exercises),
// otherwise just [idx,idx].
function getExerciseUnitRange(idx){
  const groupId = editingTemplateSupersetGroups[idx];
  if(!groupId) return [idx, idx];
  if(idx>0 && editingTemplateSupersetGroups[idx-1]===groupId) return [idx-1, idx];
  if(idx<editingTemplateSupersetGroups.length-1 && editingTemplateSupersetGroups[idx+1]===groupId) return [idx, idx+1];
  return [idx, idx]; // group id set but no adjacent partner found — treat as solo
}

// Moves the exercise at idx up or down by one step, carrying its superset
// partner along as a single unit if it has one, so a pair can never be torn
// apart into non-adjacent positions by a reorder.
function moveExerciseUnit(idx, dir){
  const [unitStart, unitEnd] = getExerciseUnitRange(idx);
  const unitSize = unitEnd - unitStart + 1;

  if(dir==='up'){
    if(unitStart===0) return; // already at the top
    // the unit swaps places with whatever single item sits directly above it
    const aboveIdx = unitStart-1;
    const unitExIds = editingTemplateExIds.splice(unitStart, unitSize);
    const unitGroups = editingTemplateSupersetGroups.splice(unitStart, unitSize);
    const unitRest = editingTemplateRestSeconds.splice(unitStart, unitSize);
    editingTemplateExIds.splice(aboveIdx, 0, ...unitExIds);
    editingTemplateSupersetGroups.splice(aboveIdx, 0, ...unitGroups);
    editingTemplateRestSeconds.splice(aboveIdx, 0, ...unitRest);
  } else {
    if(unitEnd>=editingTemplateExIds.length-1) return; // already at the bottom
    const unitExIds = editingTemplateExIds.splice(unitStart, unitSize);
    const unitGroups = editingTemplateSupersetGroups.splice(unitStart, unitSize);
    const unitRest = editingTemplateRestSeconds.splice(unitStart, unitSize);
    // after removing the unit, the single item that was directly below it
    // has shifted into unitStart — reinsert the unit right after that item
    editingTemplateExIds.splice(unitStart + 1, 0, ...unitExIds);
    editingTemplateSupersetGroups.splice(unitStart + 1, 0, ...unitGroups);
    editingTemplateRestSeconds.splice(unitStart + 1, 0, ...unitRest);
  }
}

function renderTemplateEditorExerciseList(){
  const list = document.getElementById('editTemplateExerciseList');
  if(editingTemplateExIds.length===0){
    list.innerHTML = `<p class="text-sm text-faint" style="padding:8px 2px;">No exercises added yet.</p>`;
    return;
  }
  list.innerHTML = editingTemplateExIds.map((exId,idx)=>{
    const def = findExercise(exId);
    if(!def) return '';
    const isFirst = idx===0, isLast = idx===editingTemplateExIds.length-1;
    const groupId = editingTemplateSupersetGroups[idx];
    const isGrouped = !!groupId;
    // "linked with next" means this row and the very next row share a group —
    // only meaningful to show/offer between adjacent rows, which keeps the
    // interaction unambiguous (no arbitrary any-to-any picker needed)
    const linkedWithNext = !isLast && groupId && groupId===editingTemplateSupersetGroups[idx+1];
    // the "bottom" card of an existing pair: grouped, and the row above it
    // shares the same group. It gets no chain button of its own — the pair
    // is controlled from its top card only, so there's exactly one control
    // per pair rather than a confusing duplicate on both cards.
    const isBottomOfPair = isGrouped && idx>0 && editingTemplateSupersetGroups[idx-1]===groupId;
    // show the chain button on: any ungrouped row with a next row to offer
    // linking to, OR the top row of an existing pair (to offer unlinking)
    const showChainBtn = !isLast && !isBottomOfPair;
    const restVal = editingTemplateRestSeconds[idx];
    const restCustomized = restVal!=null;

    return `<div class="reorder-item ${isGrouped?'superset-grouped':''}" data-reorder-idx="${idx}">
      <div class="reorder-item-top">
        ${isBottomOfPair
          ? `<div class="reorder-handle reorder-handle-spacer" aria-hidden="true"></div>`
          : `<div class="reorder-handle" data-drag-handle="${idx}" aria-label="Drag to reorder${isGrouped?' (moves the superset pair together)':''}">
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
        </div>`}
        <div class="ex-icon">${def.icon}</div>
        <div class="ex-info">
          <div class="ex-name">${def.name}</div>
          <div class="ex-meta">${capitalize(def.muscle)}${isGrouped?' · Superset':''}</div>
        </div>
        <button class="template-delete" data-remove-template-ex="${idx}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
        </button>
      </div>
      <div class="reorder-item-actions">
        ${showChainBtn ? `
          <button class="superset-chain-btn ${linkedWithNext?'linked':''}" data-superset-link="${idx}" aria-label="${linkedWithNext?'Unlink superset':'Link as superset with next exercise'}" title="${linkedWithNext?'Unlink superset':'Link as superset'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7a4 4 0 0 1 4-4h1a4 4 0 0 1 0 8h-1M16 17a4 4 0 0 1-4 4h-1a4 4 0 0 1 0-8h1"/><line x1="9" y1="12" x2="15" y2="12"/></svg>
          </button>
        ` : ''}
        <button class="ex-action-btn ${restCustomized?'rest-customized':''}" data-template-rest-picker="${idx}" title="Rest after this exercise">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
          ${formatRestShort(restVal!=null ? restVal : 90)}
        </button>
        <div class="reorder-nudge-group">
          <button class="reorder-nudge-btn" data-nudge="${idx}:up" ${isFirst?'disabled':''} aria-label="Move up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
          </button>
          <button class="reorder-nudge-btn" data-nudge="${idx}:down" ${isLast?'disabled':''} aria-label="Move down">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </button>
        </div>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-remove-template-ex]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const idx = +e.currentTarget.dataset.removeTemplateEx;
      editingTemplateExIds.splice(idx,1);
      editingTemplateSupersetGroups.splice(idx,1);
      editingTemplateRestSeconds.splice(idx,1);
      renderTemplateEditorExerciseList();
    });
  });
  list.querySelectorAll('[data-template-rest-picker]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      openRestPicker('template:' + e.currentTarget.dataset.templateRestPicker);
    });
  });
  list.querySelectorAll('[data-nudge]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const [idxStr,dir] = e.currentTarget.dataset.nudge.split(':');
      const idx = +idxStr;
      moveExerciseUnit(idx, dir);
      renderTemplateEditorExerciseList();
    });
  });
  list.querySelectorAll('[data-drag-handle]').forEach(handle=>{
    handle.addEventListener('pointerdown', onReorderPointerDown);
  });
  list.querySelectorAll('[data-superset-link]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const idx = +e.currentTarget.dataset.supersetLink;
      const nextIdx = idx+1;
      const groupA = editingTemplateSupersetGroups[idx];
      const groupB = editingTemplateSupersetGroups[nextIdx];

      if(groupA && groupA===groupB){
        // already linked to each other — unlink this pair
        editingTemplateSupersetGroups[idx] = null;
        editingTemplateSupersetGroups[nextIdx] = null;
      } else if(groupA || groupB){
        // one side is already part of a different pair — supersets are
        // limited to pairs for now, so refuse rather than silently create
        // a confusing 3-way group
        toast('That exercise is already linked to another one');
        return;
      } else {
        const newGroup = uid();
        editingTemplateSupersetGroups[idx] = newGroup;
        editingTemplateSupersetGroups[nextIdx] = newGroup;
      }
      renderTemplateEditorExerciseList();
    });
  });
}

/* ---------------- DRAG TO REORDER (touch + mouse via Pointer Events) ----------------
   The dragged item's DOM node follows the pointer directly via a transform
   (no re-rendering mid-drag, so there's nothing to get out of sync). All
   other items in the list get a sibling transform to open/close a gap,
   purely visual. The underlying array is only mutated once, on release,
   then the whole list re-renders cleanly from that final order.
------------------------------------------------- */
let reorderDrag = null; // {startIdx, currentIdx, itemEl, siblings[], itemHeight, startY}

function onReorderPointerDown(e){
  const handle = e.currentTarget;
  const startIdx = +handle.dataset.dragHandle;
  const itemEl = handle.closest('.reorder-item');
  const listEl = document.getElementById('editTemplateExerciseList');
  if(!itemEl || !listEl) return;

  e.preventDefault();
  const itemRect = itemEl.getBoundingClientRect();
  const styles = getComputedStyle(itemEl);
  const itemHeight = itemRect.height + parseFloat(styles.marginBottom || 0);

  const siblings = Array.from(listEl.querySelectorAll('.reorder-item')).filter(el=>el!==itemEl);

  reorderDrag = {
    startIdx,
    currentIdx: startIdx,
    itemEl,
    siblings,
    itemHeight,
    startY: e.clientY
  };

  itemEl.classList.add('dragging');
  itemEl.style.width = itemRect.width + 'px';
  if(navigator.vibrate) navigator.vibrate(15);

  handle.setPointerCapture(e.pointerId);
  handle.addEventListener('pointermove', onReorderPointerMove);
  handle.addEventListener('pointerup', onReorderPointerUp);
  handle.addEventListener('pointercancel', onReorderPointerUp);
}

function onReorderPointerMove(e){
  if(!reorderDrag) return;
  const dy = e.clientY - reorderDrag.startY;
  reorderDrag.itemEl.style.transform = `translateY(${dy}px)`;

  const steps = Math.round(dy / reorderDrag.itemHeight);
  let targetIdx = reorderDrag.startIdx + steps;
  targetIdx = Math.max(0, Math.min(reorderDrag.siblings.length, targetIdx));

  if(targetIdx !== reorderDrag.currentIdx){
    if(navigator.vibrate) navigator.vibrate(8);
    reorderDrag.currentIdx = targetIdx;
  }

  // shift siblings to open a gap at targetIdx: items between the drag's
  // start slot and the current target slot slide by one item-height to
  // make visual room, everything else stays put
  reorderDrag.siblings.forEach((sib, sibIdx)=>{
    // sibIdx is the sibling's position among siblings only (dragged item excluded);
    // its "real" position in the full list is sibIdx if sibIdx<startIdx, else sibIdx+1
    const realIdx = sibIdx < reorderDrag.startIdx ? sibIdx : sibIdx+1;
    let shift = 0;
    if(realIdx > reorderDrag.startIdx && realIdx <= targetIdx){
      shift = -reorderDrag.itemHeight; // slides up to fill the gap the dragged item left
    } else if(realIdx < reorderDrag.startIdx && realIdx >= targetIdx){
      shift = reorderDrag.itemHeight; // slides down
    }
    sib.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

function onReorderPointerUp(e){
  if(!reorderDrag) return;
  const handle = e.currentTarget;
  handle.removeEventListener('pointermove', onReorderPointerMove);
  handle.removeEventListener('pointerup', onReorderPointerUp);
  handle.removeEventListener('pointercancel', onReorderPointerUp);
  try{ handle.releasePointerCapture(e.pointerId); }catch(err){}

  const { startIdx, currentIdx } = reorderDrag;
  reorderDrag = null;

  if(currentIdx !== startIdx){
    // The drag handle only ever appears on a solo exercise or the TOP card
    // of a superset pair (see showChainBtn/handle-hiding in the render
    // function), so startIdx here is never the bottom half of a pair.
    // Moving the unit (1 or 2 items) as a block keeps a superset from ever
    // being torn apart into non-adjacent slots by a drag.
    const [unitStart, unitEnd] = getExerciseUnitRange(startIdx);
    const unitSize = unitEnd - unitStart + 1;
    const unitExIds = editingTemplateExIds.splice(unitStart, unitSize);
    const unitGroups = editingTemplateSupersetGroups.splice(unitStart, unitSize);
    const unitRest = editingTemplateRestSeconds.splice(unitStart, unitSize);
    // currentIdx was computed against the pre-splice, single-item-tracking
    // pixel math; clamp it into the post-splice array bounds before
    // reinserting the (possibly 2-wide) unit there.
    const insertAt = Math.max(0, Math.min(editingTemplateExIds.length, currentIdx));
    editingTemplateExIds.splice(insertAt, 0, ...unitExIds);
    editingTemplateSupersetGroups.splice(insertAt, 0, ...unitGroups);
    editingTemplateRestSeconds.splice(insertAt, 0, ...unitRest);
  }
  renderTemplateEditorExerciseList(); // clean re-render clears all inline transforms/dragging state
}

document.getElementById('btnAddExerciseToTemplate').addEventListener('click', ()=>{
  // reuse the exercise library picker in "template" mode
  pickerMode = 'template';
  closeSheet('sheetEditTemplate');
  showView('log');
  renderExerciseLibrary();
});

document.getElementById('btnViewRoutineMuscles').addEventListener('click', ()=>{
  const highlights = computeMuscleIntensityFromExerciseIds(editingTemplateExIds);
  currentMuscleMapView = 'front';
  renderMuscleMapCard('routineMusclesMap', highlights, {
    title: 'Muscles worked',
    emptyMessage: 'Add exercises to see which muscles this routine works.'
  });
  document.getElementById('muscleMapModalBackdrop').classList.add('open');
  document.getElementById('muscleMapModal').classList.add('open');
});

function closeMuscleMapModal(){
  document.getElementById('muscleMapModalBackdrop').classList.remove('open');
  document.getElementById('muscleMapModal').classList.remove('open');
  if(currentMuscleMapInstance){
    currentMuscleMapInstance.destroy();
    currentMuscleMapInstance = null;
  }
}
document.getElementById('btnCloseMuscleMapModal').addEventListener('click', closeMuscleMapModal);
document.getElementById('muscleMapModalBackdrop').addEventListener('click', closeMuscleMapModal);

document.getElementById('btnSaveTemplateEdits').addEventListener('click', ()=>{
  const name = (document.getElementById('editTemplateNameInput').value||'').trim();
  if(!name){ toast('Enter a routine name'); return; }
  if(editingTemplateExIds.length===0){ toast('Add at least one exercise'); return; }

  if(editingTemplateId){
    const t = state.templates.find(x=>x.id===editingTemplateId);
    if(t){
      t.name = name;
      t.exIds = [...editingTemplateExIds];
      t.supersetGroups = [...editingTemplateSupersetGroups];
      t.restSeconds = [...editingTemplateRestSeconds];
      t.scheduledDays = [...editingTemplateScheduledDays];
    }
  } else {
    state.templates.push({
      id: uid(),
      name,
      exIds: [...editingTemplateExIds],
      supersetGroups: [...editingTemplateSupersetGroups],
      restSeconds: [...editingTemplateRestSeconds],
      scheduledDays: [...editingTemplateScheduledDays],
      createdAt: Date.now()
    });
  }
  saveState();
  closeSheet('sheetEditTemplate');
  toast(editingTemplateId ? 'Routine updated' : 'Routine created');
  renderTemplatesFullList();
  renderTemplatesQuickRow();
});

document.getElementById('btnDeleteTemplateFromEditor').addEventListener('click', async ()=>{
  if(!editingTemplateId) return;
  const t = state.templates.find(x=>x.id===editingTemplateId);
  if(!t) return;
  const ok = await confirmDialog({
    title: 'Delete routine?',
    message: `"${t.name}" will be permanently deleted. This cannot be undone.`,
    confirmLabel: 'Delete routine'
  });
  if(ok){
    state.templates = state.templates.filter(x=>x.id!==editingTemplateId);
    saveState();
    closeSheet('sheetEditTemplate');
    toast('Routine deleted');
    renderTemplatesFullList();
    renderTemplatesQuickRow();
  }
});

function startOfWeek(d){
  const date = new Date(d);
  const day = (date.getDay()+6)%7; // 0=Mon
  date.setDate(date.getDate()-day);
  date.setHours(0,0,0,0);
  return date;
}

function startOfMonth(d){
  const date = new Date(d);
  date.setDate(1);
  date.setHours(0,0,0,0);
  return date;
}

function sessionsThisCalendarWeek(){
  const weekStart = startOfWeek(new Date());
  return state.sessions.filter(s=>parseISO(s.date) >= weekStart);
}

function sessionsInLastNDays(n){
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-n); cutoff.setHours(0,0,0,0);
  return state.sessions.filter(s=>parseISO(s.date) >= cutoff);
}

function computeStreak(){
  // Standalone walk logs (steps/km, no exercises) shouldn't count toward or
  // extend a training streak — same reasoning as excluding them from
  // sessions/wk: this tracks gym consistency, not general daily activity.
  const workoutSessions = state.sessions.filter(s=>!(s.type==='walk' && s.exercises.length===0));
  if(workoutSessions.length===0) return 0;
  const dates = new Set(workoutSessions.map(s=>s.date));
  let streak = 0;
  let cursor = new Date(); cursor.setHours(0,0,0,0);
  // if no session today, check if yesterday continues streak (grace)
  if(!dates.has(fmtDateISO(cursor))){
    cursor.setDate(cursor.getDate()-1);
  }
  while(dates.has(fmtDateISO(cursor))){
    streak++;
    cursor.setDate(cursor.getDate()-1);
  }
  return streak;
}

function renderRecentSessions(){
  const list = document.getElementById('recentSessionsList');
  const sorted = [...state.sessions].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,10);
  if(sorted.length===0){
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 4v16M18 4v16M2 9h4M2 15h4M18 9h4M18 15h4M6 12h12"/></svg>
      <p>No sessions logged yet. Start your first session to begin building your log.</p>
    </div>`;
    return;
  }
  list.innerHTML = sorted.map(s=>{
    const d = parseISO(s.date);
    const isGeneralWalk = s.type==='walk' && s.exercises.length===0;

    if(isGeneralWalk){
      const parts = [];
      if(s.steps) parts.push(`${s.steps.toLocaleString()} steps`);
      if(s.distanceKm) parts.push(`${s.distanceKm}km`);
      return `<div class="session-item" data-session="${s.id}">
        <div class="session-date-badge">
          <div class="d num">${d.getDate()}</div>
          <div class="m">${d.toLocaleDateString(undefined,{month:'short'})}</div>
        </div>
        <div class="session-info">
          <div class="session-title">Walking</div>
          <div class="session-meta">${parts.join(' · ')}</div>
        </div>
        <div class="session-kcal num">${Math.round(sessionTotalKcal(s))} kcal</div>
      </div>`;
    }

    const exNames = s.exercises.slice(0,3).map(e=>e.name).join(', ');
    const more = s.exercises.length>3 ? ` +${s.exercises.length-3}` : '';
    return `<div class="session-item" data-session="${s.id}">
      <div class="session-date-badge">
        <div class="d num">${d.getDate()}</div>
        <div class="m">${d.toLocaleDateString(undefined,{month:'short'})}</div>
      </div>
      <div class="session-info">
        <div class="session-title">${s.exercises.length} exercise${s.exercises.length!==1?'s':''}${s.type==='walk'?' · Walk':''}</div>
        <div class="session-meta">${exNames}${more || (s.exercises.length===0?'Cardio session':'')}</div>
      </div>
      <div class="session-kcal num">${Math.round(sessionTotalKcal(s))} kcal</div>
    </div>`;
  }).join('');
}

/* ---------------- START SESSION / WORKOUT LOGGING ---------------- */
document.getElementById('btnStartSession').addEventListener('click', ()=>{
  startWorkout(todayISO());
});

function startWorkout(dateISO){
  if(!activeWorkout){
    activeWorkout = {
      startedAt: Date.now(),
      date: dateISO || todayISO(),
      exercises: [],
      restDuration: 90
    };
    startWorkoutTimer();
  }
  showView('workout');
  renderWorkoutView();
}

function startWorkoutTimer(){
  clearInterval(workoutTimerInterval);
  workoutTimerInterval = setInterval(()=>{
    if(!activeWorkout) return;
    const el = document.getElementById('workoutTimerLabel');
    if(el && activeWorkout.date===todayISO()) el.textContent = formatElapsed(Date.now()-activeWorkout.startedAt);
  }, 1000);
}

function formatElapsed(ms){
  const totalSec = Math.floor(ms/1000);
  const m = Math.floor(totalSec/60).toString().padStart(2,'0');
  const s = (totalSec%60).toString().padStart(2,'0');
  return `${m}:${s}`;
}

document.getElementById('btnAddExercise').addEventListener('click', ()=>{
  pickerMode = 'session';
  pendingSupersetSourceIdx = null;
  showView('log');
  renderExerciseLibrary();
});

function renderWorkoutView(){
  if(!activeWorkout){
    document.getElementById('workoutExerciseCards').innerHTML='';
    document.getElementById('workoutEmptyState').style.display='block';
    return;
  }
  persistActiveWorkout();
  document.getElementById('workoutExCount').textContent = `${activeWorkout.exercises.length} exercise${activeWorkout.exercises.length!==1?'s':''}`;

  const isToday = activeWorkout.date===todayISO();
  const timerEl = document.getElementById('workoutTimerLabel');
  if(isToday){
    timerEl.textContent = formatElapsed(Date.now()-activeWorkout.startedAt);
  } else {
    const d = parseISO(activeWorkout.date);
    timerEl.textContent = d.toLocaleDateString(undefined,{weekday:'short', month:'short', day:'numeric'});
  }

  const banner = document.getElementById('backdateBanner');
  banner.style.display = isToday ? 'none' : 'block';
  if(!isToday){
    const durInput = document.getElementById('backdateDuration');
    if(document.activeElement !== durInput){
      durInput.value = activeWorkout.manualDurationMin || '';
    }
    durInput.oninput = (e)=>{
      const v = parseInt(e.target.value);
      activeWorkout.manualDurationMin = isNaN(v) ? undefined : v;
      debouncedPersistActiveWorkout();
    };
  }

  renderSessionRestLabel();

  const wrap = document.getElementById('workoutExerciseCards');
  const empty = document.getElementById('workoutEmptyState');
  if(activeWorkout.exercises.length===0){
    wrap.innerHTML='';
    empty.style.display='block';
    // still need finish bar controls
    ensureFinishBar();
    return;
  }
  empty.style.display='none';

  const cardHtmlByIdx = activeWorkout.exercises.map((ex,exIdx)=>{
    const isWalk = ex.sets.length===1 && ex.sets[0].isWalk;

    if(isWalk){
      const w = ex.sets[0];
      const bw = state.settings.bodyWeightKg || 75;
      const kcal = Math.round(estimateInclineWalkKcal(w.speed, w.incline, w.duration, bw));
      return `<div class="logging-exercise-card" data-ex-idx="${exIdx}">
        <div class="logging-exercise-header">
          <h3>${ex.name}</h3>
          <button class="remove-ex-btn" data-remove-ex="${exIdx}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
          </button>
        </div>
        <div class="stat-grid" style="grid-template-columns:repeat(4,1fr); margin-bottom:0;">
          <div class="stat-box"><div class="v num">${w.speed}</div><div class="l">km/h</div></div>
          <div class="stat-box"><div class="v num">${w.incline}%</div><div class="l">Incline</div></div>
          <div class="stat-box"><div class="v num">${w.duration}</div><div class="l">Minutes</div></div>
          <div class="stat-box"><div class="v num" style="color:var(--positive);">${kcal}</div><div class="l">Kcal</div></div>
        </div>
      </div>`;
    }

    const exDef = findExercise(ex.exId) || {name:ex.name, met:4.5};
    const isAssisted = !!exDef.assisted;
    // A static hold (Plank, Side Plank) isn't a rep-based movement — "how
    // many reps" doesn't mean anything for it, what matters is how long it
    // was held. Reuses the same numeric field/column, just relabeled and
    // asking for seconds instead of a rep count, rather than adding a
    // whole parallel data field for what's still just one number per set.
    const isHoldBased = !!exDef.holdBased;
    const history = getExerciseHistory(ex.exId);
    const workingSets = ex.sets.filter(s=>!s.warmup);

    let isPR = false, best = 0, sparkPoints = [], oneRM = null, isOneRmPR = false;
    if(isAssisted){
      const bests = history.map(h=>h.minWeight);
      best = bests.length ? Math.min(...bests) : null;
      const currentAssistValues = workingSets.map(s=>parseFloat(s.weight)).filter(w=>!isNaN(w) && w>=0);
      const currentMin = currentAssistValues.length ? Math.min(...currentAssistValues) : null;
      isPR = best!==null && currentMin!==null && currentMin<best;
      sparkPoints = history.slice(-6).map(h=>h.minWeight);
    } else {
      best = history.length ? Math.max(...history.map(h=>h.maxWeight)) : 0;
      const currentMax = Math.max(0,...workingSets.map(s=>parseFloat(s.weight)||0));
      isPR = best>0 && currentMax>best;
      sparkPoints = history.slice(-6).map(h=>h.maxWeight);

      // 1RM estimate from the current session's heaviest working set
      const bestCurrentSet = workingSets.reduce((a,b)=>{
        const aw = parseFloat(a && a.weight)||0, bw = parseFloat(b.weight)||0;
        return bw>aw ? b : a;
      }, null);
      if(bestCurrentSet){
        oneRM = estimate1RM(parseFloat(bestCurrentSet.weight)||0, parseFloat(bestCurrentSet.reps)||0);
      }
      if(oneRM!==null && history.length){
        const historicalBest1RMs = history.map(h=>estimate1RM(h.bestSetWeight, h.bestSetReps)).filter(v=>v!==null);
        const best1RM = historicalBest1RMs.length ? Math.max(...historicalBest1RMs) : 0;
        isOneRmPR = best1RM>0 && oneRM>best1RM;
      }
    }

    const sparkline = sparkPoints.length>=2 ? buildSparkline(sparkPoints, isAssisted) : '';

    let lastTimeText = null;
    if(!isWalk && history.length){
      const last = history[history.length-1];
      if(last.bestSetWeight!=null && last.bestSetReps!=null){
        const assistLabel = isAssisted ? ' assist' : '';
        lastTimeText = isHoldBased
          ? `${last.bestSetReps}s held`
          : `${kgToDisplay(last.bestSetWeight)}${unitLabel()}${assistLabel} × ${last.bestSetReps}`;
      }
    }

    return `<div class="logging-exercise-card" data-ex-idx="${exIdx}">
      <div class="logging-exercise-header">
        <h3>${ex.name}</h3>
        <div class="logging-exercise-header-actions">
          <button class="ex-action-btn ${ex.supersetGroup?'linked':''}" data-superset-toggle="${exIdx}" title="${ex.supersetGroup?'Unlink superset':'Link as superset with next exercise'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7a4 4 0 0 1 4-4h1a4 4 0 0 1 0 8h-1M16 17a4 4 0 0 1-4 4h-1a4 4 0 0 1 0-8h1"/><line x1="9" y1="12" x2="15" y2="12"/></svg>
          </button>
          <button class="ex-action-btn ${ex.restDurationCustomized?'rest-customized':''}" data-rest-picker="exercise" data-ex-idx="${exIdx}" title="Rest for this exercise">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
            ${formatRestShort(ex.restDuration!=null ? ex.restDuration : (activeWorkout.restDuration||90))}
          </button>
          <button class="remove-ex-btn" data-remove-ex="${exIdx}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
          </button>
        </div>
      </div>
      ${isAssisted ? `<div class="pill" style="margin-bottom:10px; color:var(--cyan); border-color:#3ad6ff40; background:#3ad6ff14;">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
        Lower assistance is better
      </div>` : ''}
      ${lastTimeText ? `<div class="last-time-label">Last time: <span class="num">${lastTimeText}</span></div>` : ''}
      ${sparkline ? `<div class="sparkline-row">${sparkline}<span class="sparkline-label">last ${sparkPoints.length} sessions</span>${isPR?'<span class="pr-badge">PR</span>':''}${oneRM!==null?`<span class="one-rm-badge ${isOneRmPR?'is-pr':''}">~${kgToDisplay(Math.round(oneRM*10)/10)}${unitLabel()} 1RM</span>`:''}</div>` : ''}
      <div class="set-headers">
        <span>#</span><span>${unitLabel()}${isAssisted?' assist':''}</span><span>${isHoldBased?'Seconds':'Reps'}</span><span>Difficulty</span><span></span>
      </div>
      ${ex.sets.map((set,setIdx)=>`
        <div class="set-row ${set.warmup?'warmup':''}">
          <div class="set-num num" data-toggle-warmup="${exIdx}:${setIdx}" title="Tap to mark as warm-up">${set.warmup?'W':setIdx+1}</div>
          <input type="number" inputmode="decimal" placeholder="0" value="${set.weight===0?'0':(set.weight||'')}" data-set-field="weight" data-ex-idx="${exIdx}" data-set-idx="${setIdx}">
          <input type="number" inputmode="numeric" placeholder="${isHoldBased?'sec':'0'}" value="${set.reps||''}" data-set-field="reps" data-ex-idx="${exIdx}" data-set-idx="${setIdx}">
          <div class="difficulty-group" data-ex-idx="${exIdx}" data-set-idx="${setIdx}">
            <button type="button" class="difficulty-btn ${(set.difficulty||'medium')==='easy'?'active':''}" data-diff="easy">E</button>
            <button type="button" class="difficulty-btn ${(set.difficulty||'medium')==='medium'?'active':''}" data-diff="medium">M</button>
            <button type="button" class="difficulty-btn ${(set.difficulty||'medium')==='hard'?'active':''}" data-diff="hard">H</button>
          </div>
          <button class="set-check ${set.done?'checked':''}" data-toggle-done="${exIdx}:${setIdx}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          </button>
        </div>
      `).join('')}
      <button class="add-set-btn" data-add-set="${exIdx}">+ Add set</button>
      <textarea class="notes-input" rows="1" placeholder="Notes (optional)" data-notes-ex="${exIdx}">${ex.notes||''}</textarea>
    </div>`;
  });

  wrap.innerHTML = wrapSupersetPairs(activeWorkout.exercises, (ex,i)=>cardHtmlByIdx[i]);

  ensureFinishBar();
  attachWorkoutCardListeners();
}

// Shared by the live logging view and the session-detail view: renders each
// exercise via the given card-builder, then wraps any two ADJACENT entries
// that share a supersetGroup in a labeled bracket container. Cards are only
// ever grouped when consecutive AND matching, mirroring how the routine
// editor only allows linking neighboring exercises — so this should always
// hold, but the lookahead check keeps it safe even if data ever drifts
// (e.g. a superset partner was deleted, or an old/imported session).
function wrapSupersetPairs(exercises, buildCardHtml){
  const out = [];
  let i = 0;
  while(i < exercises.length){
    const ex = exercises[i];
    const next = exercises[i+1];
    const isPairStart = ex.supersetGroup && next && next.supersetGroup===ex.supersetGroup;
    if(isPairStart){
      out.push(`
        <div class="superset-pair">
          <div class="superset-pair-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12h6M13 6l6 6-6 6M11 18l-6-6 6-6"/></svg>
            Superset
          </div>
          ${buildCardHtml(ex, i)}
          ${buildCardHtml(next, i+1)}
        </div>
      `);
      i += 2;
    } else {
      out.push(buildCardHtml(ex, i));
      i += 1;
    }
  }
  return out.join('');
}

/* ---------------- REST DURATION PICKER ----------------
   One shared popover (not always-visible chips) used for both the
   session-wide default (top of the workout view) and each individual
   exercise's override. restPickerTarget tracks which one is currently being
   set: 'session', or the numeric index of an exercise in activeWorkout.
------------------------------------------------- */
let restPickerTarget = 'session';

function formatRestShort(seconds){
  // Only convert to a "Xm" label when it divides evenly — 90s becoming "2m"
  // (Math.round(90/60) rounds the .5 up) would misrepresent a very common
  // rest duration. Anything that isn't a clean multiple of 60 just stays in
  // seconds, which is unambiguous either way.
  return (seconds>=60 && seconds%60===0) ? `${seconds/60}m` : `${seconds}s`;
}

function renderSessionRestLabel(){
  if(!activeWorkout) return;
  const label = document.getElementById('sessionRestLabel');
  if(label) label.textContent = formatRestShort(activeWorkout.restDuration || 90);
}

function openRestPicker(target){
  restPickerTarget = target;
  const isSession = target==='session';
  const isTemplate = typeof target==='string' && target.startsWith('template:');
  const templateIdx = isTemplate ? +target.slice('template:'.length) : null;

  let current;
  if(isSession){
    document.getElementById('restPickerTitle').textContent = 'Rest between sets';
    current = activeWorkout.restDuration || 90;
  } else if(isTemplate){
    const def = findExercise(editingTemplateExIds[templateIdx]);
    document.getElementById('restPickerTitle').textContent = `Rest for ${def ? def.name : 'exercise'}`;
    current = editingTemplateRestSeconds[templateIdx]!=null ? editingTemplateRestSeconds[templateIdx] : 90;
  } else {
    document.getElementById('restPickerTitle').textContent = `Rest for ${activeWorkout.exercises[target].name}`;
    current = activeWorkout.exercises[target].restDuration!=null ? activeWorkout.exercises[target].restDuration : (activeWorkout.restDuration||90);
  }

  document.querySelectorAll('#restPickerOptions .rest-picker-option').forEach(btn=>{
    btn.classList.toggle('active', +btn.dataset.restValue===current);
  });

  document.getElementById('restPickerModalBackdrop').classList.add('open');
  document.getElementById('restPickerModal').classList.add('open');
}

function closeRestPicker(){
  document.getElementById('restPickerModalBackdrop').classList.remove('open');
  document.getElementById('restPickerModal').classList.remove('open');
}

document.getElementById('btnOpenRestPicker').addEventListener('click', ()=>openRestPicker('session'));
document.getElementById('btnCloseRestPicker').addEventListener('click', closeRestPicker);
document.getElementById('restPickerModalBackdrop').addEventListener('click', closeRestPicker);

document.getElementById('restPickerOptions').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-rest-value]');
  if(!btn) return;
  const seconds = +btn.dataset.restValue;
  const isTemplate = typeof restPickerTarget==='string' && restPickerTarget.startsWith('template:');

  if(isTemplate){
    const idx = +restPickerTarget.slice('template:'.length);
    editingTemplateRestSeconds[idx] = seconds;
    toast(`Rest set to ${formatRestShort(seconds)}`);
    closeRestPicker();
    renderTemplateEditorExerciseList();
    return;
  }

  if(!activeWorkout) return;

  if(restPickerTarget==='session'){
    activeWorkout.restDuration = seconds;
    // Setting the session-wide default applies it to every exercise that
    // hasn't been individually customized — an exercise the user already
    // set its own rest for keeps that override rather than being silently
    // overwritten, per how this is meant to work.
    activeWorkout.exercises.forEach(ex=>{
      if(!ex.restDurationCustomized){
        ex.restDuration = null; // null = "follow the session default", not a frozen copy of it
      }
    });
    renderSessionRestLabel();
    toast(`All exercises rest set to ${formatRestShort(seconds)}`);
  } else {
    const ex = activeWorkout.exercises[restPickerTarget];
    ex.restDuration = seconds;
    ex.restDurationCustomized = true;
    toast(`${ex.name} rest set to ${formatRestShort(seconds)}`);
  }

  persistActiveWorkout();
  closeRestPicker();
  renderWorkoutView();
});

/* ---------------- REST TIMER ----------------
   Starts automatically whenever a set is checked off. Runs independently
   of renderWorkoutView() re-renders (its own interval + DOM node) so
   typing in other fields or adding sets doesn't interrupt the countdown.
------------------------------------------------- */
let restTimer = {
  active: false,
  totalSeconds: 0,
  remainingSeconds: 0,
  intervalId: null,
  audioCtx: null,
  exerciseName: '',
  notifyIntervalId: null
};

// Decides whether completing a set should start the rest timer right now,
// or wait — for a superset pair, rest should only begin once BOTH exercises
// in the round have had a set completed, not after every individual set.
// The rest duration that actually applies to a given exercise: its own
// override if the user has set one, otherwise the session-wide default.
function effectiveRestDuration(ex){
  return ex.restDuration!=null ? ex.restDuration : (activeWorkout.restDuration || 90);
}

function maybeStartRestAfterSet(exIdx){
  const ex = activeWorkout.exercises[exIdx];
  const groupId = ex.supersetGroup;

  if(!groupId){
    startRestTimer(effectiveRestDuration(ex), ex.name);
    return;
  }

  // find the other exercise(s) sharing this group (pairs only, per the
  // routine editor's linking rule, but this loop tolerates more if that
  // ever changes)
  const partners = activeWorkout.exercises.filter((e,i)=>i!==exIdx && e.supersetGroup===groupId);
  if(partners.length===0){
    // group id present but no partner found in this session (e.g. the
    // paired exercise was removed mid-session) — behave as ungrouped
    startRestTimer(effectiveRestDuration(ex), ex.name);
    return;
  }

  const completedCount = ex.sets.filter(s=>s.done).length;
  const partnersReady = partners.every(p=>p.sets.filter(s=>s.done).length >= completedCount);

  if(partnersReady){
    const names = [ex, ...partners].map(e=>e.name).join(' + ');
    // For a superset pair, rest starts after whichever exercise finishes the
    // round last (this function only reaches here once that's true) — its
    // own rest setting governs the break, since that's the exercise the
    // lifter is standing at when the round completes.
    startRestTimer(effectiveRestDuration(ex), names);
  }
  // else: this exercise is ahead of its partner in the round — no rest yet,
  // the expectation is to move straight to the partner's matching set
}

function startRestTimer(seconds, exerciseName){
  stopRestTimer(); // clear any existing one first
  primeAudioContext(); // must happen inside this user-gesture call stack so the
                        // browser allows audio playback later when the timer fires
  restTimer.active = true;
  restTimer.totalSeconds = seconds;
  restTimer.remainingSeconds = seconds;
  restTimer.exerciseName = exerciseName || '';
  ensureRestTimerBar();
  renderRestTimerBar();
  restTimer.intervalId = setInterval(()=>{
    restTimer.remainingSeconds--;
    if(restTimer.remainingSeconds <= 0){
      restTimer.remainingSeconds = 0;
      renderRestTimerBar();
      onRestTimerComplete();
      return;
    }
    renderRestTimerBar();
  }, 1000);

  notifyRestStarted(seconds, restTimer.exerciseName);
}

function primeAudioContext(){
  try{
    if(!restTimer.audioCtx){
      restTimer.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if(restTimer.audioCtx.state === 'suspended') restTimer.audioCtx.resume();
  }catch(e){
    console.warn('Could not initialize audio context', e);
  }
}

function stopRestTimer(){
  if(restTimer.intervalId) clearInterval(restTimer.intervalId);
  if(restTimer.notifyIntervalId) clearInterval(restTimer.notifyIntervalId);
  restTimer.intervalId = null;
  restTimer.notifyIntervalId = null;
  restTimer.active = false;
  removeRestTimerBar();
}

function addRestTime(deltaSeconds){
  if(!restTimer.active) return;
  restTimer.remainingSeconds = Math.max(0, restTimer.remainingSeconds + deltaSeconds);
  restTimer.totalSeconds = Math.max(restTimer.totalSeconds, restTimer.remainingSeconds);
  renderRestTimerBar();
}

function onRestTimerComplete(){
  clearInterval(restTimer.intervalId);
  if(restTimer.notifyIntervalId) clearInterval(restTimer.notifyIntervalId);
  restTimer.intervalId = null;
  restTimer.notifyIntervalId = null;
  playRestTimerAlert();
  const bar = document.getElementById('restTimerBar');
  if(bar) bar.classList.add('done');
  const title = document.getElementById('restTimerTitle');
  if(title) title.textContent = 'Rest complete';
  const sub = document.getElementById('restTimerSub');
  if(sub) sub.textContent = 'Tap to dismiss';
  notifyRestComplete(restTimer.exerciseName);
  // auto-dismiss a few seconds after completion if the user doesn't interact
  setTimeout(()=>{
    if(restTimer.active && restTimer.remainingSeconds<=0) stopRestTimer();
  }, 6000);
}

function ensureRestTimerBar(){
  if(document.getElementById('restTimerBar')) return;
  const bar = document.createElement('div');
  bar.className = 'rest-timer-bar';
  bar.id = 'restTimerBar';
  bar.innerHTML = `
    <div class="rest-timer-ring">
      <svg width="48" height="48" viewBox="0 0 48 48">
        <circle class="bg-ring" cx="24" cy="24" r="20" fill="none" stroke-width="4"/>
        <circle class="fg-ring" id="restRingFg" cx="24" cy="24" r="20" fill="none" stroke-width="4" stroke-dasharray="126" stroke-dashoffset="0"/>
      </svg>
      <div class="rest-timer-ring-label num" id="restRingLabel">0:00</div>
    </div>
    <div class="rest-timer-info">
      <div class="rest-timer-title" id="restTimerTitle">Resting</div>
      <div class="rest-timer-sub" id="restTimerSub">Next set coming up</div>
    </div>
    <div class="rest-timer-actions">
      <button class="rest-timer-btn" id="btnRestMinus15" aria-label="Subtract 15 seconds">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>
      </button>
      <button class="rest-timer-btn" id="btnRestSkip" aria-label="Skip rest">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4l10 8-10 8V4zM19 5v14"/></svg>
      </button>
    </div>
  `;
  document.body.appendChild(bar);
  document.getElementById('btnRestMinus15').addEventListener('click', ()=>addRestTime(-15));
  document.getElementById('btnRestSkip').addEventListener('click', stopRestTimer);
  bar.addEventListener('click', (e)=>{
    // tapping the bar itself (not the action buttons) dismisses once complete
    if(restTimer.remainingSeconds<=0 && !restTimer.intervalId) stopRestTimer();
  });
}

function removeRestTimerBar(){
  const bar = document.getElementById('restTimerBar');
  if(bar) bar.remove();
}

function renderRestTimerBar(){
  const label = document.getElementById('restRingLabel');
  const ring = document.getElementById('restRingFg');
  if(!label || !ring) return;
  const m = Math.floor(restTimer.remainingSeconds/60);
  const s = (restTimer.remainingSeconds%60).toString().padStart(2,'0');
  label.textContent = `${m}:${s}`;
  const circumference = 126;
  const pct = restTimer.totalSeconds>0 ? restTimer.remainingSeconds/restTimer.totalSeconds : 0;
  ring.style.strokeDashoffset = circumference*(1-pct);
}

function playRestTimerAlert(){
  // vibration for haptic feedback, if supported
  if(navigator.vibrate) navigator.vibrate([200,100,200,100,300]);
  // Web Audio tone so it's audible over music without needing an audio
  // asset file; three ascending beeps, distinct from typical notification sounds.
  try{
    if(!restTimer.audioCtx){
      restTimer.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = restTimer.audioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const notes = [880, 1046.5, 1318.5]; // A5, C6, E6 — bright, cuts through mixes
    notes.forEach((freq, i)=>{
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const startTime = ctx.currentTime + i*0.18;
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.35, startTime+0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime+0.32);
      osc.connect(gain).connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime+0.35);
    });
  }catch(e){
    console.warn('Rest timer audio alert failed', e);
  }
}

/* ---------------- REST TIMER NOTIFICATIONS ----------------
   Free, local-only notifications via the Web Notifications API — no
   server, no push service, no cost. Works while the app/tab is open or
   briefly backgrounded (e.g. you switch to another app for a moment).
   They will NOT fire if the browser/PWA process is fully closed/killed —
   that requires a real push server, which is out of scope here.
------------------------------------------------- */
function notificationsEnabled(){
  return state.settings.notificationsEnabled && 'Notification' in window && Notification.permission==='granted';
}

async function requestNotificationPermission(){
  if(!('Notification' in window)){
    toast('Notifications are not supported in this browser');
    return false;
  }
  if(Notification.permission==='granted') return true;
  if(Notification.permission==='denied'){
    toast('Notifications are blocked — enable them in your browser/app settings');
    return false;
  }
  const result = await Notification.requestPermission();
  return result==='granted';
}

function fireNotification(title, body, tag){
  if(!notificationsEnabled()) return;
  // Route through the service worker registration when available so the
  // notification is more likely to survive brief backgrounding, falling
  // back to a plain Notification() if no SW registration is ready yet.
  const options = {
    body,
    tag,               // same tag = replaces the previous notification instead of stacking
    renotify: true,    // re-alert (vibrate/sound) even when replacing, so countdown updates are noticed
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    silent: false
  };
  if(navigator.serviceWorker && navigator.serviceWorker.ready){
    navigator.serviceWorker.ready.then(reg=>{
      reg.showNotification(title, options).catch(()=>{
        try{ new Notification(title, options); }catch(e){}
      });
    });
  } else {
    try{ new Notification(title, options); }catch(e){}
  }
}

function notifyRestStarted(seconds, exerciseName){
  if(!notificationsEnabled()) return;
  const label = exerciseName ? `Next: ${exerciseName}` : 'Get ready for your next set';
  fireNotification(`Resting — ${formatElapsed(seconds*1000)}`, label, 'rest-timer');

  // periodically refresh the notification with the remaining time, since a
  // one-shot notification can't show a live-ticking countdown on its own
  if(restTimer.notifyIntervalId) clearInterval(restTimer.notifyIntervalId);
  restTimer.notifyIntervalId = setInterval(()=>{
    if(!restTimer.active || restTimer.remainingSeconds<=0){
      clearInterval(restTimer.notifyIntervalId);
      restTimer.notifyIntervalId = null;
      return;
    }
    const sub = exerciseName ? `Next: ${exerciseName}` : 'Get ready for your next set';
    fireNotification(`Resting — ${formatElapsed(restTimer.remainingSeconds*1000)}`, sub, 'rest-timer');
  }, 15000); // refresh every 15s; frequent enough to feel live, gentle on battery/OS rate limits
}

function notifyRestComplete(exerciseName){
  if(!notificationsEnabled()) return;
  const body = exerciseName ? `Time to start: ${exerciseName}` : 'Time for your next set';
  fireNotification('Rest complete 💪', body, 'rest-timer');
}

function ensureFinishBar(){
  if(document.getElementById('finishBar')) return;
  const bar = document.createElement('div');
  bar.className = 'finish-bar';
  bar.id = 'finishBar';
  bar.innerHTML = `
    <button class="btn btn-ghost" id="btnCancelWorkout">Cancel</button>
    <button class="btn btn-primary" id="btnFinishWorkout">Finish session</button>
  `;
  document.body.appendChild(bar);
  document.getElementById('btnCancelWorkout').addEventListener('click', cancelWorkout);
  document.getElementById('btnFinishWorkout').addEventListener('click', finishWorkout);
}

function removeFinishBar(){
  const bar = document.getElementById('finishBar');
  if(bar) bar.remove();
}

function attachWorkoutCardListeners(){
  document.querySelectorAll('[data-set-field]').forEach(input=>{
    input.addEventListener('input', (e)=>{
      const exIdx = +e.target.dataset.exIdx, setIdx = +e.target.dataset.setIdx, field = e.target.dataset.setField;
      activeWorkout.exercises[exIdx].sets[setIdx][field] = e.target.value;
      debouncedPersistActiveWorkout();
    });
  });
  document.querySelectorAll('.difficulty-btn').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const group = e.currentTarget.closest('.difficulty-group');
      const exIdx = +group.dataset.exIdx, setIdx = +group.dataset.setIdx;
      activeWorkout.exercises[exIdx].sets[setIdx].difficulty = e.currentTarget.dataset.diff;
      group.querySelectorAll('.difficulty-btn').forEach(b=>b.classList.toggle('active', b===e.currentTarget));
      persistActiveWorkout();
    });
  });
  document.querySelectorAll('[data-toggle-warmup]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      const [exIdx,setIdx] = e.currentTarget.dataset.toggleWarmup.split(':').map(Number);
      const set = activeWorkout.exercises[exIdx].sets[setIdx];
      set.warmup = !set.warmup;
      renderWorkoutView();
    });
  });
  document.querySelectorAll('[data-toggle-done]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const [exIdx,setIdx] = e.currentTarget.dataset.toggleDone.split(':').map(Number);
      const ex = activeWorkout.exercises[exIdx];
      const set = ex.sets[setIdx];
      set.done = !set.done;
      if(set.done){
        maybeStartRestAfterSet(exIdx);
      }
      renderWorkoutView();
    });
  });
  document.querySelectorAll('[data-add-set]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const exIdx = +e.currentTarget.dataset.addSet;
      const sets = activeWorkout.exercises[exIdx].sets;
      const last = sets[sets.length-1];
      sets.push({weight:last?last.weight:'', reps:last?last.reps:'', difficulty:'medium', done:false});
      renderWorkoutView();
    });
  });
  document.querySelectorAll('[data-remove-ex]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const exIdx = +e.currentTarget.dataset.removeEx;
      const removed = activeWorkout.exercises[exIdx];
      // if the removed exercise was half of a superset pair, the remaining
      // half has no partner left to pair with — clear its grouping rather
      // than leaving it visually "linked" to nothing
      if(removed.supersetGroup){
        activeWorkout.exercises.forEach(ex=>{
          if(ex!==removed && ex.supersetGroup===removed.supersetGroup) ex.supersetGroup = null;
        });
      }
      activeWorkout.exercises.splice(exIdx,1);
      renderWorkoutView();
    });
  });
  document.querySelectorAll('[data-notes-ex]').forEach(ta=>{
    ta.addEventListener('input',(e)=>{
      activeWorkout.exercises[+e.target.dataset.notesEx].notes = e.target.value;
      debouncedPersistActiveWorkout();
    });
  });
  document.querySelectorAll('[data-rest-picker="exercise"]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      openRestPicker(+e.currentTarget.dataset.exIdx);
    });
  });
  document.querySelectorAll('[data-superset-toggle]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const exIdx = +e.currentTarget.dataset.supersetToggle;
      const ex = activeWorkout.exercises[exIdx];

      if(ex.supersetGroup){
        // unlink: clear the group from this exercise and whichever partner(s) shared it
        const groupId = ex.supersetGroup;
        activeWorkout.exercises.forEach(e2=>{ if(e2.supersetGroup===groupId) e2.supersetGroup = null; });
        persistActiveWorkout();
        toast('Superset unlinked');
        renderWorkoutView();
        return;
      }

      // Linking mid-session needs the user to pick WHICH other exercise to
      // pair with (unlike the routine editor, where "next in the list" is
      // unambiguous) — open the picker in superset mode instead of guessing.
      pendingSupersetSourceIdx = exIdx;
      pickerMode = 'superset';
      showView('log');
      renderExerciseLibrary();
    });
  });
}

let persistDebounceTimer = null;
function debouncedPersistActiveWorkout(){
  clearTimeout(persistDebounceTimer);
  persistDebounceTimer = setTimeout(persistActiveWorkout, 400);
}

function buildSparkline(points, invert){
  const w=90,h=26,pad=3;
  const min = Math.min(...points), max = Math.max(...points);
  const range = (max-min)||1;
  const stepX = (w-pad*2)/(points.length-1);
  const coords = points.map((p,i)=>{
    const x = pad+i*stepX;
    // normal: higher value draws higher on the chart (lower y).
    // inverted (assisted exercises): lower value draws higher, since less
    // assistance is the improvement direction.
    const normalized = invert ? (max-p)/range : (p-min)/range;
    const y = h-pad-normalized*(h-pad*2);
    return [x,y];
  });
  const path = coords.map((c,i)=>(i===0?'M':'L')+c[0].toFixed(1)+' '+c[1].toFixed(1)).join(' ');
  const lastPoint = coords[coords.length-1];
  const color = invert ? '#3ad6ff' : '#39ff9a';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${lastPoint[0]}" cy="${lastPoint[1]}" r="2.5" fill="${color}"/>
  </svg>`;
}

function getExerciseHistory(exId){
  const out = [];
  const exDef = findExercise(exId);
  const isAssisted = exDef && exDef.assisted;
  const sorted = [...state.sessions].sort((a,b)=>a.date.localeCompare(b.date));
  sorted.forEach(s=>{
    // A session can legitimately log the same exercise more than once (e.g.
    // repeated across superset rounds, or deliberately twice in a circuit).
    // Using .find() here would silently drop every set after the first
    // matching entry — flatMap all matches together so nothing is missed.
    const matchingEntries = s.exercises.filter(e=>e.exId===exId);
    if(matchingEntries.length===0) return;
    const allSets = matchingEntries.flatMap(e=>e.sets||[]);
    if(allSets.length){
      // warm-up sets don't count toward PRs, "best", or 1RM estimates
      const workingSets = allSets.filter(st=>!st.warmup);
      // For assisted exercises, 0kg assistance is a real, meaningful value
      // (full bodyweight, no help) so it must not be filtered out. For normal
      // lifts, 0 means "not entered" and should be excluded.
      const validSets = workingSets.filter(st=>{
        const w = parseFloat(st.weight);
        return !isNaN(w) && (isAssisted ? w>=0 : w>0);
      });
      if(validSets.length){
        const weights = validSets.map(st=>parseFloat(st.weight));
        const maxWeight = Math.max(...weights);
        const minWeight = Math.min(...weights);
        // best set = heaviest (or least-assisted) working set, used for 1RM
        const bestSet = isAssisted
          ? validSets.reduce((a,b)=> parseFloat(b.weight)<parseFloat(a.weight) ? b : a)
          : validSets.reduce((a,b)=> parseFloat(b.weight)>parseFloat(a.weight) ? b : a);
        out.push({
          date:s.date,
          maxWeight,
          minWeight,
          bestSetWeight: parseFloat(bestSet.weight),
          bestSetReps: parseFloat(bestSet.reps)||0
        });
      }
    }
  });
  return out;
}

// Epley formula: 1RM = weight × (1 + reps/30). Reps of 1 returns the weight
// itself; accuracy degrades past ~12 reps but it's the standard estimate.
function estimate1RM(weight, reps){
  if(!weight || !reps || reps<=0) return null;
  if(reps===1) return weight;
  return weight * (1 + reps/30);
}

// Short "last time" summary for the exercise picker, e.g. "100kg × 10" or,
// for incline walk, "8% @ 5.5km/h · 30min". Returns null if never logged.
function getLastPerformance(exId){
  const def = findExercise(exId);
  if(!def) return null;

  if(def.special==='incline_walk'){
    const sorted = [...state.sessions].sort((a,b)=>b.date.localeCompare(a.date));
    for(const s of sorted){
      const ex = s.exercises.find(e=>e.exId===exId && e.sets && e.sets[0] && e.sets[0].isWalk);
      if(ex){
        const w = ex.sets[0];
        return `${w.incline}% @ ${w.speed}km/h · ${w.duration}min`;
      }
    }
    return null;
  }

  const history = getExerciseHistory(exId);
  if(!history.length) return null;
  const last = history[history.length-1];
  if(last.bestSetWeight==null || last.bestSetReps==null) return null;
  const displayWeight = kgToDisplay(last.bestSetWeight);
  const assistLabel = def.assisted ? ' assist' : '';
  return `${displayWeight}${unitLabel()}${assistLabel} × ${last.bestSetReps}`;
}

async function cancelWorkout(){
  if(activeWorkout.exercises.length>0){
    const ok = await confirmDialog({
      title: 'Discard this session?',
      message: 'All logged sets will be lost. This cannot be undone.',
      confirmLabel: 'Discard session'
    });
    if(!ok) return;
  }
  activeWorkout = null;
  persistActiveWorkout();
  clearInterval(workoutTimerInterval);
  removeFinishBar();
  stopRestTimer();
  showView('home');
}

function finishWorkout(){
  if(activeWorkout.exercises.length===0){
    toast('Add at least one exercise first');
    return;
  }
  const isToday = activeWorkout.date===todayISO();
  const durationMin = isToday
    ? Math.max(1, Math.round((Date.now()-activeWorkout.startedAt)/60000))
    : (activeWorkout.manualDurationMin || 45);
  const bodyWeightKg = state.settings.bodyWeightKg || 75;

  let totalKcal = 0;
  const exercisesOut = activeWorkout.exercises.map(ex=>{
    const isWalk = ex.sets.length===1 && ex.sets[0].isWalk;

    if(isWalk){
      const w = ex.sets[0];
      const kcal = estimateInclineWalkKcal(w.speed, w.incline, w.duration, bodyWeightKg);
      totalKcal += kcal;
      return {
        exId: ex.exId,
        name: ex.name,
        sets: [{...w}],
        notes: ex.notes||'',
        supersetGroup: ex.supersetGroup || null
      };
    }

    const def = findExercise(ex.exId) || {met:4.5};
    const kcal = estimateStrengthExerciseKcal(def, ex.sets, bodyWeightKg, effectiveRestDuration(ex));
    totalKcal += kcal;
    return {
      exId: ex.exId,
      name: ex.name,
      sets: ex.sets.filter(s=>s.weight||s.reps||s.done).map(s=>({
        weight: displayToKgIfNeeded(s.weight),
        reps: s.reps||'',
        difficulty: s.difficulty||'medium',
        warmup: !!s.warmup,
        done: !!s.done
      })),
      notes: ex.notes||'',
      supersetGroup: ex.supersetGroup || null
    };
  }).filter(ex=>ex.sets.length>0);

  if(exercisesOut.length===0){
    toast('Log at least one set before finishing');
    return;
  }

  const session = {
    id: uid(),
    date: activeWorkout.date,
    exercises: exercisesOut,
    durationMin,
    kcal: Math.round(totalKcal),
    type: 'strength'
  };

  // merge with any existing session on that date, regardless of its type —
  // a day should only ever have one session record, whether it's strength,
  // walk, or (now) both combined
  const existingIdx = state.sessions.findIndex(s=>s.date===session.date);
  if(existingIdx>=0){
    const existing = state.sessions[existingIdx];
    existing.exercises = existing.exercises.concat(exercisesOut);
    existing.kcal += session.kcal;
    existing.durationMin += durationMin;
    // once a session includes strength work, label it as such rather than
    // leaving it tagged from whatever was logged first (e.g. an earlier walk)
    existing.type = 'strength';
  } else {
    state.sessions.push(session);
  }
  saveState();

  activeWorkout = null;
  persistActiveWorkout();
  clearInterval(workoutTimerInterval);
  removeFinishBar();
  stopRestTimer();
  showSessionSummary(session);
}

function displayToKgIfNeeded(val){
  if(val==='' || val==null) return val;
  const n = parseFloat(val);
  if(isNaN(n)) return val;
  return state.settings.useLbs ? Math.round((n/LB_PER_KG)*100)/100 : n;
}

let lastFinishedSession = null;

function showSessionSummary(session){
  lastFinishedSession = session;
  const content = document.getElementById('summaryContent');
  const totalSets = session.exercises.reduce((a,e)=>a+e.sets.length,0);
  const d = parseISO(session.date);
  const isToday = session.date===todayISO();
  content.innerHTML = `
    ${!isToday ? `<p class="text-sm text-muted mb-12">Logged for ${d.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'})}</p>` : ''}
    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr);">
      <div class="stat-box"><div class="v num">${session.exercises.length}</div><div class="l">Exercises</div></div>
      <div class="stat-box"><div class="v num">${totalSets}</div><div class="l">Sets</div></div>
      <div class="stat-box"><div class="v num" style="color:var(--positive);">${session.kcal}</div><div class="l">Kcal burned</div></div>
    </div>
    <div class="mt-16">
      ${session.exercises.map(e=>`<div class="row" style="padding:8px 2px; border-bottom:1px solid var(--border-soft);">
        <span class="text-sm">${e.name}</span>
        <span class="text-sm text-faint num">${e.sets.length} sets</span>
      </div>`).join('')}
    </div>
  `;
  document.getElementById('sheetSessionSummary').dataset.returnDate = session.date;
  currentMuscleMapView = 'front';
  renderMuscleMapCard('summaryMuscleMap', computeSessionMuscleIntensity(session), {title:'Muscles worked this session'});
  openSheet('sheetSessionSummary');
}

document.getElementById('btnCloseSummary').addEventListener('click', ()=>{
  closeSheet('sheetSessionSummary');
  const returnDate = document.getElementById('sheetSessionSummary').dataset.returnDate;
  if(returnDate && returnDate!==todayISO()){
    calCursor = parseISO(returnDate);
    showView('calendar');
  } else {
    showView('home');
  }
});

document.getElementById('btnSaveAsTemplate').addEventListener('click', ()=>{
  if(!lastFinishedSession) return;
  closeSheet('sheetSessionSummary');
  document.getElementById('templateNameInput').value = suggestTemplateName();
  openSheet('sheetSaveTemplate');
});

function suggestTemplateName(){
  if(!lastFinishedSession) return '';
  const d = parseISO(lastFinishedSession.date);
  const weekday = d.toLocaleDateString(undefined,{weekday:'long'});
  return `${weekday} session`;
}

document.getElementById('btnConfirmSaveTemplate').addEventListener('click', ()=>{
  if(!lastFinishedSession) return;
  const name = (document.getElementById('templateNameInput').value||'').trim();
  if(!name){ toast('Enter a routine name'); return; }

  // dedupe exercise IDs while preserving order; skip walk-type entries
  // since they capture live session data (speed/incline/duration), not a
  // repeatable set structure.
  const exIds = [];
  lastFinishedSession.exercises.forEach(ex=>{
    const isWalk = ex.sets.length===1 && ex.sets[0].isWalk;
    if(isWalk) return;
    if(!exIds.includes(ex.exId)) exIds.push(ex.exId);
  });

  if(exIds.length===0){
    toast('Nothing to save — no strength exercises in this session');
    closeSheet('sheetSaveTemplate');
    return;
  }

  state.templates.push({
    id: uid(),
    name,
    exIds,
    scheduledDays: [],
    createdAt: Date.now()
  });
  saveState();
  closeSheet('sheetSaveTemplate');
  toast(`Routine "${name}" saved`);
  showView('home');
});

/* ---------------- EXERCISE LIBRARY (picker) ---------------- */
let activeMuscleFilter = 'all';

function renderMuscleFilters(){
  const wrap = document.getElementById('muscleFilterScroll');
  wrap.innerHTML = MUSCLE_GROUPS.map(g=>
    `<button class="chip ${g.id===activeMuscleFilter?'active':''}" data-muscle="${g.id}">${g.label}</button>`
  ).join('');
  wrap.querySelectorAll('.chip').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      activeMuscleFilter = chip.dataset.muscle;
      renderExerciseLibrary();
    });
  });
}

function renderExerciseLibrary(){
  renderMuscleFilters();
  const barWrap = document.getElementById('activeSessionBarWrap');
  if(pickerMode==='template'){
    barWrap.innerHTML = `<div class="pill pill-accent mb-12">Building routine — tap an exercise to add it</div>`;
  } else if(pickerMode==='superset'){
    const sourceName = (pendingSupersetSourceIdx!=null && activeWorkout && activeWorkout.exercises[pendingSupersetSourceIdx])
      ? activeWorkout.exercises[pendingSupersetSourceIdx].name
      : 'your exercise';
    barWrap.innerHTML = `<div class="pill pill-cyan mb-12">Adding a superset exercise — pairs with ${sourceName}</div>`;
  } else {
    barWrap.innerHTML = activeWorkout ? `<div class="pill pill-accent mb-12">Session active — adding to current workout</div>` : '';
  }

  const query = (document.getElementById('exerciseSearchInput').value||'').toLowerCase().trim();
  let list = allExercises().filter(e=>{
    const matchesMuscle = activeMuscleFilter==='all' || e.muscle===activeMuscleFilter;
    const matchesQuery = !query || e.name.toLowerCase().includes(query);
    // incline walk has no meaningful set structure, so exclude it from template building
    if(pickerMode==='template' && e.special==='incline_walk') return false;
    return matchesMuscle && matchesQuery;
  });

  const container = document.getElementById('exerciseLibraryList');
  if(list.length===0){
    container.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <p>No exercises match "${query}".</p>
    </div>`;
    return;
  }

  container.innerHTML = list.map(e=>{
    const lastPerf = getLastPerformance(e.id);
    return `
    <div class="exercise-list-item" data-ex-id="${e.id}">
      <div class="ex-tap-area" data-view-ex="${e.id}">
        <div class="ex-icon">${e.icon}</div>
        <div class="ex-info">
          <div class="ex-name">${e.name}${e.assisted ? ' <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#3ad6ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:1px;"><path d="M12 5v14M5 12l7 7 7-7"/></svg>' : ''}</div>
          <div class="ex-meta">${capitalize(e.muscle)} · ${capitalize(e.type)}${e.assisted ? ' · Assisted' : ''}</div>
          ${lastPerf ? `<div class="ex-last-perf num">Last: ${lastPerf}</div>` : ''}
        </div>
      </div>
      <button class="ex-add-btn" data-add-ex="${e.id}" aria-label="Add ${e.name}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  `;
  }).join('');

  const handleTap = (exId)=>{
    if(pickerMode==='template'){
      addExerciseToTemplateDraft(exId);
    } else {
      addExerciseToWorkout(exId);
    }
  };
  container.querySelectorAll('[data-add-ex]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      handleTap(btn.dataset.addEx);
    });
  });
  container.querySelectorAll('[data-view-ex]').forEach(item=>{
    item.addEventListener('click', ()=>{
      openExercisePickerDetail(item.dataset.viewEx);
    });
  });
}

function addExerciseToTemplateDraft(exId){
  const def = findExercise(exId);
  if(!def) return;
  if(editingTemplateExIds.includes(exId)){
    toast(`${def.name} already in routine`);
    return;
  }
  editingTemplateExIds.push(exId);
  editingTemplateSupersetGroups.push(null);
  editingTemplateRestSeconds.push(null);
  toast(`Added ${def.name}`);
  pickerMode = 'session';
  showView('templates');
  refreshTemplateEditorSheet(); // preserves name input, since nameValue is undefined
  renderDayPicker();
  openSheet('sheetEditTemplate');
}

function capitalize(s){ return s.charAt(0).toUpperCase()+s.slice(1); }

function addExerciseToWorkout(exId){
  const def = findExercise(exId);
  if(!def) return;
  if(def.special==='incline_walk'){
    openWalkSheet();
    return;
  }
  if(!activeWorkout){
    activeWorkout = {startedAt: Date.now(), date: todayISO(), exercises:[], restDuration: 90};
    startWorkoutTimer();
  }

  const newExercise = {
    exId: def.id,
    name: def.name,
    sets: [{weight:'', reps:'', difficulty:'medium', done:false}],
    notes:'',
    supersetGroup: null
  };

  if(pickerMode==='superset' && pendingSupersetSourceIdx!=null && activeWorkout.exercises[pendingSupersetSourceIdx]){
    const source = activeWorkout.exercises[pendingSupersetSourceIdx];
    if(source.exId===exId){
      toast('Pick a different exercise to pair with');
      pickerMode = 'session';
      pendingSupersetSourceIdx = null;
      showView('workout');
      return;
    }
    const groupId = source.supersetGroup || uid();
    source.supersetGroup = groupId;
    newExercise.supersetGroup = groupId;
    // Superset pairs must be adjacent in the array for the bracket-grouping
    // display (wrapSupersetPairs) to pick them up — insert the new exercise
    // directly after its partner rather than unshifting to the front.
    activeWorkout.exercises.splice(pendingSupersetSourceIdx+1, 0, newExercise);
    toast(`Linked ${source.name} + ${def.name} as a superset`);
    pickerMode = 'session';
    pendingSupersetSourceIdx = null;
  } else {
    activeWorkout.exercises.unshift(newExercise);
    toast(`Added ${def.name}`);
  }

  showView('workout');
  renderWorkoutView();
}

document.getElementById('exerciseSearchInput').addEventListener('input', renderExerciseLibrary);

/* ---------------- QUICK WALK LOGGING ---------------- */

function openWalkSheet(){
  document.getElementById('walkDuration').value = 30;
  document.getElementById('walkSpeed').value = 5.5;
  document.getElementById('walkIncline').value = 8;
  updateWalkPreview();
  openSheet('sheetQuickWalk');
}

['walkDuration','walkSpeed','walkIncline'].forEach(id=>{
  document.getElementById(id).addEventListener('input', updateWalkPreview);
});

function updateWalkPreview(){
  const dur = parseFloat(document.getElementById('walkDuration').value)||0;
  const speed = parseFloat(document.getElementById('walkSpeed').value)||0;
  const incline = parseFloat(document.getElementById('walkIncline').value)||0;
  const bw = state.settings.bodyWeightKg || 75;
  const kcal = estimateInclineWalkKcal(speed, incline, dur, bw);
  document.getElementById('walkKcalPreview').textContent = Math.round(kcal);
}

// This sheet is only ever reached from inside an active session now (adding
// "Incline Treadmill Walk" as an exercise mid-workout) — the standalone
// Home-screen "Log walk" button opens sheetGeneralWalk instead, a separate,
// simpler steps/km flow with its own save handler below.
document.getElementById('btnSaveWalk').addEventListener('click', ()=>{
  const dur = parseFloat(document.getElementById('walkDuration').value)||0;
  const speed = parseFloat(document.getElementById('walkSpeed').value)||0;
  const incline = parseFloat(document.getElementById('walkIncline').value)||0;
  if(dur<=0){ toast('Enter a duration'); return; }
  const bw = state.settings.bodyWeightKg || 75;
  const kcal = Math.round(estimateInclineWalkKcal(speed, incline, dur, bw));

  const walkExercise = {
    exId: 'incline-walk',
    name: `Incline Walk (${incline}% @ ${speed} km/h)`,
    sets: [{weight:incline, reps:dur, done:true, isWalk:true, speed, incline, duration:dur}],
    notes: ''
  };

  if(!activeWorkout){
    activeWorkout = {startedAt: Date.now(), date: todayISO(), exercises:[], restDuration: 90};
    startWorkoutTimer();
  }
  activeWorkout.exercises.unshift(walkExercise);
  closeSheet('sheetQuickWalk');
  toast(`Added · ${kcal} kcal`);
  showView('workout');
  renderWorkoutView();
});

/* ---------------- STANDALONE WALK LOG (steps/km) ----------------
   The Home screen's "Log walk" button. A distinct, simpler flow from the
   incline-treadmill exercise above — no speed/incline to enter, just steps
   and/or distance, since this represents an ordinary daily walk rather than
   a specific treadmill workout. Saved as its own type:'walk' session that
   counts toward weekly kcal but NOT toward "sessions/wk" (see
   sessionsThisCalendarWeek, which filters these out on purpose).
------------------------------------------------- */
function openGeneralWalkSheet(){
  document.getElementById('genWalkSteps').value = '';
  document.getElementById('genWalkDistance').value = '';
  document.getElementById('genWalkDistUnit').textContent = state.settings.useLbs ? 'mi' : 'km'; // reuses the imperial/metric setting as a stand-in for unit preference
  updateGeneralWalkPreview();
  openSheet('sheetGeneralWalk');
}

document.getElementById('btnQuickWalk').addEventListener('click', openGeneralWalkSheet);

// Distance in miles isn't something the rest of the app models (weights use
// lbs/kg, not a separate distance-unit setting) — keep the walk math itself
// always in km internally, and only relabel the field for lb-unit users
// rather than building a whole second unit system for this one screen.
function generalWalkDistanceKm(){
  const stepsVal = parseFloat(document.getElementById('genWalkSteps').value);
  const distVal = parseFloat(document.getElementById('genWalkDistance').value);
  if(!isNaN(distVal) && distVal>0) return distVal;
  if(!isNaN(stepsVal) && stepsVal>0) return stepsToKm(stepsVal);
  return 0;
}

function updateGeneralWalkPreview(){
  const km = generalWalkDistanceKm();
  const bw = state.settings.bodyWeightKg || 75;
  const kcal = estimateGeneralWalkKcal(km, bw);
  document.getElementById('genWalkKcalPreview').textContent = Math.round(kcal);

  const stepsVal = parseFloat(document.getElementById('genWalkSteps').value);
  const distVal = parseFloat(document.getElementById('genWalkDistance').value);
  const hint = document.getElementById('genWalkDistanceHint');
  if(!isNaN(stepsVal) && stepsVal>0 && isNaN(distVal)){
    hint.textContent = `≈ ${km.toFixed(1)} km based on steps`;
  } else {
    hint.textContent = '';
  }
}

['genWalkSteps','genWalkDistance'].forEach(id=>{
  document.getElementById(id).addEventListener('input', updateGeneralWalkPreview);
});

document.getElementById('btnSaveGeneralWalk').addEventListener('click', ()=>{
  const stepsVal = parseFloat(document.getElementById('genWalkSteps').value);
  const km = generalWalkDistanceKm();
  if(km<=0){
    toast('Enter steps or a distance');
    return;
  }
  const bw = state.settings.bodyWeightKg || 75;
  const kcal = Math.round(estimateGeneralWalkKcal(km, bw));
  const steps = !isNaN(stepsVal) && stepsVal>0 ? Math.round(stepsVal) : null;

  const session = {
    id: uid(),
    date: todayISO(),
    exercises: [],
    durationMin: 0,
    kcal,
    type: 'walk',
    steps,
    distanceKm: Math.round(km*10)/10
  };

  // A day can have at most one standalone walk log — logging again the same
  // day adds to the existing entry (matching how a second gym session that
  // day merges into one record) rather than creating a second walk card.
  const existingIdx = state.sessions.findIndex(s=>s.date===session.date && s.type==='walk' && s.exercises.length===0);
  if(existingIdx>=0){
    const existing = state.sessions[existingIdx];
    existing.steps = (existing.steps||0) + (steps||0);
    existing.distanceKm = Math.round((existing.distanceKm + km)*10)/10;
    existing.kcal += kcal;
  } else {
    state.sessions.push(session);
  }
  saveState();
  closeSheet('sheetGeneralWalk');
  toast(`Saved · ${kcal} kcal`);
  renderHome();
});

/* ---------------- CALENDAR VIEW ---------------- */
function renderCalendar(){
  const year = calCursor.getFullYear(), month = calCursor.getMonth();
  document.getElementById('calMonthLabel').textContent = calCursor.toLocaleDateString(undefined,{month:'long', year:'numeric'});

  const dowRow = document.getElementById('calDowRow');
  dowRow.innerHTML = ['M','T','W','T','F','S','S'].map(d=>`<div class="cal-dow">${d}</div>`).join('');

  const grid = document.getElementById('calGrid');
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay()+6)%7; // Monday=0
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const today = new Date();

  let cells = [];
  for(let i=0;i<startOffset;i++) cells.push(null);
  for(let d=1; d<=daysInMonth; d++) cells.push(d);

  const sessionDatesInMonth = {};
  state.sessions.forEach(s=>{
    const sd = parseISO(s.date);
    if(sd.getFullYear()===year && sd.getMonth()===month){
      sessionDatesInMonth[sd.getDate()] = (sessionDatesInMonth[sd.getDate()]||0) + sessionTotalKcal(s);
    }
  });

  grid.innerHTML = cells.map(d=>{
    if(d===null) return `<div class="cal-cell empty"></div>`;
    const trained = sessionDatesInMonth[d]!==undefined;
    const cellDate = new Date(year,month,d);
    const isToday = sameDay(cellDate, today);
    const iso = fmtDateISO(cellDate);
    return `<div class="cal-cell ${trained?'trained':''} ${isToday?'today':''}" data-day="${d}" data-date="${iso}">
      <span class="num">${d}</span>
      ${trained?'<span class="dot"></span>':''}
    </div>`;
  }).join('');
  grid.querySelectorAll('.cal-cell[data-date]').forEach(cell=>{
    cell.addEventListener('click', ()=>onCalendarDayTap(cell.dataset.date));
  });

  // month summary — a standalone walk log (steps/km, no exercises) counts
  // toward the month's kcal total but not its session count, same principle
  // already applied to the weekly stats and streak on Home.
  const monthSessions = state.sessions.filter(s=>{
    const sd = parseISO(s.date);
    return sd.getFullYear()===year && sd.getMonth()===month;
  });
  const monthWorkoutSessions = monthSessions.filter(s=>!(s.type==='walk' && s.exercises.length===0));
  document.getElementById('monthSessions').textContent = monthWorkoutSessions.length;
  document.getElementById('monthKcal').textContent = Math.round(monthSessions.reduce((a,s)=>a+sessionTotalKcal(s),0));

  const list = document.getElementById('calSessionsList');
  if(monthSessions.length===0){
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
      <p>No sessions logged this month yet.</p>
    </div>`;
  } else {
    const sorted = [...monthSessions].sort((a,b)=>b.date.localeCompare(a.date));
    list.innerHTML = sorted.map(s=>{
      const d = parseISO(s.date);
      const isGeneralWalk = s.type==='walk' && s.exercises.length===0;
      if(isGeneralWalk){
        const parts = [];
        if(s.steps) parts.push(`${s.steps.toLocaleString()} steps`);
        if(s.distanceKm) parts.push(`${s.distanceKm}km`);
        return `<div class="session-item" data-session="${s.id}">
          <div class="session-date-badge">
            <div class="d num">${d.getDate()}</div>
            <div class="m">${d.toLocaleDateString(undefined,{weekday:'short'})}</div>
          </div>
          <div class="session-info">
            <div class="session-title">Walking</div>
            <div class="session-meta">${parts.join(' · ')}</div>
          </div>
          <div class="session-kcal num">${Math.round(sessionTotalKcal(s))} kcal</div>
        </div>`;
      }
      return `<div class="session-item" data-session="${s.id}">
        <div class="session-date-badge">
          <div class="d num">${d.getDate()}</div>
          <div class="m">${d.toLocaleDateString(undefined,{weekday:'short'})}</div>
        </div>
        <div class="session-info">
          <div class="session-title">${s.exercises.length} exercise${s.exercises.length!==1?'s':''}${s.type==='walk'?' · Walk':''}</div>
          <div class="session-meta">${s.durationMin} min</div>
        </div>
        <div class="session-kcal num">${Math.round(sessionTotalKcal(s))} kcal</div>
      </div>`;
    }).join('');
  }
}

document.getElementById('calPrevMonth').addEventListener('click', ()=>{
  calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth()-1, 1);
  renderCalendar();
});
document.getElementById('calNextMonth').addEventListener('click', ()=>{
  calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth()+1, 1);
  renderCalendar();
});

function onCalendarDayTap(dateISO){
  const daySessions = state.sessions.filter(s=>s.date===dateISO);
  if(daySessions.length>0){
    // multiple sessions possible (strength + walk) — show the first, user can
    // also tap individual rows in the "Sessions this month" list below.
    showSessionDetail(daySessions[0]);
    return;
  }
  openAddPastSessionPrompt(dateISO);
}

function openAddPastSessionPrompt(dateISO){
  const d = parseISO(dateISO);
  const isFuture = d > new Date(new Date().setHours(23,59,59,999));
  const label = d.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric', year:'numeric'});
  // clear the fixed header/footer regions since this simple prompt doesn't use them
  document.getElementById('exerciseDetailHeader').innerHTML = '';
  document.getElementById('exerciseDetailFooter').innerHTML = '';
  const content = document.getElementById('exerciseDetailContent');
  content.innerHTML = `
    <div class="sheet-title">${label}</div>
    <p class="text-sm text-muted mb-12">${isFuture ? 'No session logged yet.' : 'Nothing logged for this day.'}</p>
    <button class="btn btn-primary btn-block" id="btnStartPastSession">+ Log a session for this day</button>
  `;
  openSheet('sheetExerciseDetail');
  document.getElementById('btnStartPastSession').addEventListener('click', ()=>{
    closeSheet('sheetExerciseDetail');
    startWorkout(dateISO);
  });
}

/* ---------------- PROGRESS VIEW ---------------- */
function renderProgressSummary(){
  const container = document.getElementById('progressSummary');
  const totalSessions = state.sessions.length;
  const streak = computeStreak();

  // total volume = sum of weight x reps across all working, non-assisted sets
  // (assisted-exercise "weight" is assistance, not resistance, so it doesn't
  // belong in a volume total the same way)
  let totalVolumeKg = 0;
  let totalSets = 0;
  state.sessions.forEach(s=>{
    s.exercises.forEach(ex=>{
      if(!ex.sets || !ex.sets.length || ex.sets[0].isWalk) return;
      const exDef = findExercise(ex.exId);
      if(exDef && exDef.assisted) return;
      ex.sets.forEach(st=>{
        if(st.warmup) return;
        const w = parseFloat(st.weight)||0, r = parseFloat(st.reps)||0;
        if(w>0 && r>0){ totalVolumeKg += w*r; totalSets++; }
      });
    });
  });

  const thisMonthKcal = state.sessions
    .filter(s=>{
      const d = parseISO(s.date), now = new Date();
      return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
    })
    .reduce((a,s)=>a+sessionTotalKcal(s),0);

  const displayVolume = kgToDisplay(Math.round(totalVolumeKg));

  container.innerHTML = `
    <h2 class="section-label">Overview</h2>
    <div class="progress-summary-grid">
      <div class="progress-summary-box">
        <div class="v accent num">${totalSessions}</div>
        <div class="l">Total sessions</div>
      </div>
      <div class="progress-summary-box">
        <div class="v accent num">${streak}</div>
        <div class="l">Day streak</div>
      </div>
      <div class="progress-summary-box">
        <div class="v num">${displayVolume.toLocaleString()}${unitLabel()}</div>
        <div class="l">Total volume lifted</div>
      </div>
      <div class="progress-summary-box">
        <div class="v num">${Math.round(thisMonthKcal).toLocaleString()}</div>
        <div class="l">Kcal this month</div>
      </div>
    </div>
  `;
}

function renderVolumeChart(){
  const container = document.getElementById('progressVolumeChart');
  const weeks = 8;
  const now = new Date();
  const thisWeekStart = startOfWeek(now);

  const buckets = []; // oldest to newest
  for(let i=weeks-1; i>=0; i--){
    const weekStart = new Date(thisWeekStart);
    weekStart.setDate(weekStart.getDate() - i*7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate()+7);
    buckets.push({start:weekStart, end:weekEnd, volume:0});
  }

  state.sessions.forEach(s=>{
    const d = parseISO(s.date);
    const bucket = buckets.find(b=>d>=b.start && d<b.end);
    if(!bucket) return;
    s.exercises.forEach(ex=>{
      if(!ex.sets || !ex.sets.length || ex.sets[0].isWalk) return;
      const exDef = findExercise(ex.exId);
      if(exDef && exDef.assisted) return;
      ex.sets.forEach(st=>{
        if(st.warmup) return;
        const w = parseFloat(st.weight)||0, r = parseFloat(st.reps)||0;
        if(w>0 && r>0) bucket.volume += w*r;
      });
    });
  });

  const hasAnyData = buckets.some(b=>b.volume>0);
  if(!hasAnyData){
    container.innerHTML = '';
    return;
  }

  const maxVolume = Math.max(...buckets.map(b=>b.volume), 1);

  container.innerHTML = `
    <div class="progress-chart-card">
      <div class="progress-chart-title">
        <h3>Weekly volume</h3>
        <span class="sub">last ${weeks} weeks</span>
      </div>
      <div class="volume-bar-chart">
        ${buckets.map((b,i)=>{
          const pct = Math.max(3, Math.round((b.volume/maxVolume)*100));
          const isCurrent = i===buckets.length-1;
          return `<div class="volume-bar-col">
            <div class="volume-bar ${isCurrent?'current-week':''}" style="height:${pct}%" title="${Math.round(kgToDisplay(b.volume))}${unitLabel()}"></div>
          </div>`;
        }).join('')}
      </div>
      <div class="volume-bar-labels">
        ${buckets.map(b=>`<div class="volume-bar-label">${b.start.getDate()}/${b.start.getMonth()+1}</div>`).join('')}
      </div>
    </div>
  `;
}

// Computes a 0-100 intensity per body-highlighter muscle group for one
// session, weighted by volume (weight x reps), same weighting already used
// elsewhere for the all-time muscle-group chart. An exercise that maps to
// several groups (e.g. deadlift -> lower_back, glutes, hamstrings, lats)
// contributes its full volume to each — it genuinely worked all of them,
// this isn't meant to be a zero-sum split across groups.
function computeSessionMuscleIntensity(session){
  const rawVolume = {}; // group -> total weight*reps

  session.exercises.forEach(ex=>{
    if(!ex.sets || !ex.sets.length || ex.sets[0].isWalk) return;
    const def = findExercise(ex.exId);
    if(!def || !def.bodyMap || def.bodyMap.length===0) return;

    let exVolume = 0;
    ex.sets.forEach(s=>{
      if(s.warmup) return;
      const w = parseFloat(s.weight)||0, r = parseFloat(s.reps)||0;
      if(w>0 && r>0) exVolume += w*r;
      else if(r>0) exVolume += r; // bodyweight exercises: reps alone still count as real work
    });
    if(exVolume<=0) return;

    def.bodyMap.forEach(group=>{
      rawVolume[group] = (rawVolume[group]||0) + exVolume;
    });
  });

  const maxVolume = Math.max(...Object.values(rawVolume), 0);
  if(maxVolume===0) return [];

  // Normalize to 0-100 relative to this session's own hardest-worked group,
  // with a floor so a lightly-touched muscle still shows a faint tint rather
  // than being visually indistinguishable from "not worked at all".
  return Object.entries(rawVolume).map(([group,vol])=>({
    group,
    intensity: Math.max(12, Math.round((vol/maxVolume)*100))
  }));
}

let currentMuscleMapInstance = null;
let currentMuscleMapView = 'front';

// Routines have no logged sets yet, so there's no volume to weight by —
// every exercise in the list simply counts as "this muscle group gets
// worked", equally. Kept as a separate function from the session-volume
// version above rather than overloading one function with an "estimate
// mode" flag, since the two have genuinely different inputs (session with
// real sets vs. a flat list of exercise ids) and conflating them risks
// subtle bugs later if either one's logic changes.
function computeMuscleIntensityFromExerciseIds(exIds){
  const rawCount = {}; // group -> number of exercises touching it

  exIds.forEach(exId=>{
    const def = findExercise(exId);
    if(!def || !def.bodyMap || def.bodyMap.length===0) return;
    def.bodyMap.forEach(group=>{
      rawCount[group] = (rawCount[group]||0) + 1;
    });
  });

  const maxCount = Math.max(...Object.values(rawCount), 0);
  if(maxCount===0) return [];

  return Object.entries(rawCount).map(([group,count])=>({
    group,
    intensity: Math.max(12, Math.round((count/maxCount)*100))
  }));
}

// Generic renderer used by the session summary, session detail, and routine
// editor muscle-map views. `containerId` is the element the whole card gets
// injected into; canvas/toggle ids are derived from it so multiple call
// sites never collide even if more than one happened to exist in the DOM.
function renderMuscleMapCard(containerId, highlights, opts={}){
  const container = document.getElementById(containerId);
  if(!container) return;
  const title = opts.title || 'Muscles worked';
  const canvasId = `${containerId}Canvas`;
  const toggleId = `${containerId}Toggle`;

  if(highlights.length===0){
    container.innerHTML = opts.emptyMessage
      ? `<p class="text-sm text-faint" style="padding:4px 2px;">${opts.emptyMessage}</p>`
      : '';
    return;
  }

  if(!window.GymMuscleMap){
    // The muscle-map engine loads as an ES module in parallel with this
    // classic script; on a slow load it may not be ready the instant this
    // is first called. Retry briefly rather than silently showing nothing.
    container.innerHTML = '';
    setTimeout(()=>renderMuscleMapCard(containerId, highlights, opts), 100);
    return;
  }

  container.innerHTML = `
    <div class="muscle-map-card">
      <div class="muscle-map-title">${title}</div>
      <div class="progress-toggle" id="${toggleId}">
        <button class="progress-toggle-btn ${currentMuscleMapView==='front'?'active':''}" data-map-view="front">Front</button>
        <button class="progress-toggle-btn ${currentMuscleMapView==='back'?'active':''}" data-map-view="back">Back</button>
      </div>
      <div class="muscle-map-canvas" id="${canvasId}"></div>
      <div class="muscle-map-legend">
        <span class="muscle-map-legend-label">Light</span>
        <div class="muscle-map-legend-gradient"></div>
        <span class="muscle-map-legend-label">Heavy</span>
      </div>
    </div>
  `;

  mountMuscleMap(canvasId, highlights);

  document.getElementById(toggleId).addEventListener('click', (e)=>{
    const btn = e.target.closest('[data-map-view]');
    if(!btn) return;
    currentMuscleMapView = btn.dataset.mapView;
    document.querySelectorAll(`#${toggleId} .progress-toggle-btn`).forEach(b=>{
      b.classList.toggle('active', b===btn);
    });
    mountMuscleMap(canvasId, highlights);
  });
}

function mountMuscleMap(canvasId, highlights){
  const canvas = document.getElementById(canvasId);
  if(!canvas) return;
  canvas.innerHTML = '';

  if(currentMuscleMapInstance){
    currentMuscleMapInstance.destroy();
    currentMuscleMapInstance = null;
  }

  currentMuscleMapInstance = new window.GymMuscleMap(canvas, {
    view: currentMuscleMapView,
    gender: 'male',
    theme: 'dark',
    bodySrc: { front: './body/male-front-dark.webp', back: './body/male-back-dark.webp' },
    color: '#ff3b3b',
    hoverHighlight: false,
    highlights: highlights.map(h=>({ group: h.group, intensity: h.intensity })),
  });
}

let muscleBreakdownRange = 'all'; // 'all' -> 'monthly' -> 'weekly' -> 'all'

function renderMuscleBreakdown(){
  const container = document.getElementById('progressMuscleBreakdown');
  const now = new Date();
  const rangeStart = muscleBreakdownRange==='weekly' ? startOfWeek(now)
    : muscleBreakdownRange==='monthly' ? startOfMonth(now)
    : null; // 'all' has no lower bound

  const counts = {};
  state.sessions.forEach(s=>{
    if(rangeStart && parseISO(s.date) < rangeStart) return;
    s.exercises.forEach(ex=>{
      if(!ex.sets || !ex.sets.length || ex.sets[0].isWalk) return;
      const workingSets = ex.sets.filter(st=>!st.warmup && (st.weight||st.reps||st.done));
      if(!workingSets.length) return;
      const exDef = findExercise(ex.exId);
      const muscle = exDef ? exDef.muscle : 'other';
      counts[muscle] = (counts[muscle]||0) + workingSets.length;
    });
  });

  const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const rangeLabel = {all:'all time', monthly:'this month', weekly:'this week'}[muscleBreakdownRange];

  if(entries.length===0){
    // Still show the header (with a working toggle) even when the selected
    // range has no data, rather than hiding the whole card — otherwise
    // switching to "this week" on a rest day looks like the feature broke.
    container.innerHTML = `
      <div class="progress-chart-card">
        <div class="progress-chart-title">
          <h3>Sets by muscle group</h3>
          <span class="sub muscle-range-toggle" id="muscleBreakdownRangeToggle">${rangeLabel}</span>
        </div>
        <p class="text-sm text-faint" style="padding:2px 0;">No sets logged ${rangeLabel==='all time'?'yet':rangeLabel}.</p>
      </div>
    `;
    document.getElementById('muscleBreakdownRangeToggle').addEventListener('click', cycleMuscleBreakdownRange);
    return;
  }
  const maxCount = Math.max(...entries.map(e=>e[1]));

  container.innerHTML = `
    <div class="progress-chart-card">
      <div class="progress-chart-title">
        <h3>Sets by muscle group</h3>
        <span class="sub muscle-range-toggle" id="muscleBreakdownRangeToggle">${rangeLabel}</span>
      </div>
      ${entries.map(([muscle,count])=>{
        const pct = Math.max(4, Math.round((count/maxCount)*100));
        return `<div class="muscle-bar-row">
          <div class="muscle-bar-label">${capitalize(muscle)}</div>
          <div class="muscle-bar-track"><div class="muscle-bar-fill" style="width:${pct}%"></div></div>
          <div class="muscle-bar-count num">${count}</div>
        </div>`;
      }).join('')}
    </div>
  `;
  document.getElementById('muscleBreakdownRangeToggle').addEventListener('click', cycleMuscleBreakdownRange);
}

function cycleMuscleBreakdownRange(){
  muscleBreakdownRange = muscleBreakdownRange==='all' ? 'monthly' : muscleBreakdownRange==='monthly' ? 'weekly' : 'all';
  renderMuscleBreakdown();
}

function renderBodyWeightCard(){
  const container = document.getElementById('bodyWeightCard');
  const logs = [...(state.bodyWeightLogs||[])].sort((a,b)=>a.date.localeCompare(b.date));

  if(logs.length===0){
    container.innerHTML = `
      <div class="progress-chart-card">
        <div class="progress-chart-title">
          <h3>Body weight</h3>
        </div>
        <p class="text-sm text-faint mb-12">No weigh-ins logged yet. A weekly check-in is plenty to see a trend.</p>
        <button class="btn btn-secondary btn-block" id="btnOpenWeightLog">+ Log weigh-in</button>
      </div>
    `;
    document.getElementById('btnOpenWeightLog').addEventListener('click', openWeightLogSheet);
    return;
  }

  const latest = logs[logs.length-1];
  const first = logs[0];
  const latestDisplay = kgToDisplay(latest.weightKg);
  const changeKg = latest.weightKg - first.weightKg;
  const changeDisplay = kgToDisplay(Math.abs(changeKg));
  const changeSign = changeKg>0 ? '+' : (changeKg<0 ? '−' : '');
  const changeColor = changeKg===0 ? 'var(--text-faint)' : (changeKg>0 ? 'var(--accent)' : 'var(--cyan)');

  const points = logs.map(l=>kgToDisplay(l.weightKg));
  const chart = points.length>=2 ? buildBigProgressChart(points, false) : '';
  const chartDates = logs.slice(-12).map(l=>{
    const d = parseISO(l.date);
    return `${d.getDate()}/${d.getMonth()+1}`;
  });

  container.innerHTML = `
    <div class="progress-chart-card">
      <div class="progress-chart-title">
        <h3>Body weight</h3>
        <span class="sub">${logs.length} weigh-in${logs.length!==1?'s':''}</span>
      </div>
      <div class="body-weight-current">
        <div>
          <div class="body-weight-current-value num">${latestDisplay}<span class="body-weight-unit">${unitLabel()}</span></div>
          <div class="body-weight-current-date">Last logged ${parseISO(latest.date).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</div>
        </div>
        ${logs.length>1 ? `<div class="body-weight-change" style="color:${changeColor};">${changeSign}${changeDisplay}${unitLabel()}<span class="body-weight-change-label">since first log</span></div>` : ''}
      </div>
      ${chart ? `<div class="ex-progress-big-chart">
        ${chart}
        <div class="ex-progress-chart-labels">
          ${chartDates.length ? `<span>${chartDates[0]}</span><span>${chartDates[chartDates.length-1]}</span>` : ''}
        </div>
      </div>` : ''}
      <div class="row" style="gap:8px;">
        <button class="btn btn-secondary" style="flex:1;" id="btnViewAllWeightLogs">View all entries</button>
        <button class="btn btn-secondary" style="flex:1;" id="btnOpenWeightLog">+ Log weigh-in</button>
      </div>
    </div>
  `;
  document.getElementById('btnOpenWeightLog').addEventListener('click', openWeightLogSheet);
  document.getElementById('btnViewAllWeightLogs').addEventListener('click', openWeightLogListModal);
}

function openWeightLogListModal(){
  renderWeightLogList();
  document.getElementById('weightLogListModalBackdrop').classList.add('open');
  document.getElementById('weightLogListModal').classList.add('open');
}

function closeWeightLogListModal(){
  document.getElementById('weightLogListModalBackdrop').classList.remove('open');
  document.getElementById('weightLogListModal').classList.remove('open');
}

document.getElementById('btnCloseWeightLogListModal').addEventListener('click', closeWeightLogListModal);
document.getElementById('weightLogListModalBackdrop').addEventListener('click', closeWeightLogListModal);

function renderWeightLogList(){
  const container = document.getElementById('weightLogListContent');
  const logs = [...(state.bodyWeightLogs||[])].sort((a,b)=>b.date.localeCompare(a.date)); // newest first

  if(logs.length===0){
    container.innerHTML = `<p class="text-sm text-faint" style="padding:8px 2px;">No weigh-ins logged yet.</p>`;
    closeWeightLogListModal();
    return;
  }

  container.innerHTML = logs.map(l=>{
    const d = parseISO(l.date);
    return `<div class="weight-log-row">
      <div class="weight-log-date">
        <div class="d num">${d.getDate()}</div>
        <div class="m">${d.toLocaleDateString(undefined,{month:'short', year:'2-digit'})}</div>
      </div>
      <div class="weight-log-value num">${kgToDisplay(l.weightKg)}${unitLabel()}</div>
      <button class="weight-log-delete" data-delete-weight-log="${l.id}" aria-label="Delete this entry">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
      </button>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-delete-weight-log]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.deleteWeightLog;
      const ok = await confirmDialog({
        title: 'Delete this entry?',
        message: 'This cannot be undone.',
        confirmLabel: 'Delete entry'
      });
      if(!ok) return;
      state.bodyWeightLogs = state.bodyWeightLogs.filter(l=>l.id!==id);
      saveState();
      renderWeightLogList(); // refresh the open list — closes itself if now empty
      renderBodyWeightCard(); // refresh the summary card (current value, trend, chart) behind it
      toast('Entry deleted');
    });
  });
}

function openWeightLogSheet(){
  document.getElementById('logWeightUnitLabel').textContent = unitLabel();
  const currentDisplay = kgToDisplay(state.settings.bodyWeightKg || 75);
  document.getElementById('logWeightInput').value = currentDisplay || '';
  document.getElementById('logWeightDate').value = todayISO();
  openSheet('sheetLogWeight');
}

document.getElementById('btnSaveWeightLog').addEventListener('click', ()=>{
  const rawValue = parseFloat(document.getElementById('logWeightInput').value);
  const dateVal = document.getElementById('logWeightDate').value || todayISO();
  if(isNaN(rawValue) || rawValue<=0){
    toast('Enter a valid weight');
    return;
  }
  const weightKg = displayToKgIfNeeded(rawValue);

  if(!state.bodyWeightLogs) state.bodyWeightLogs = [];
  // one entry per date — logging again on the same day updates it rather
  // than creating a duplicate point on the trend chart
  const existingIdx = state.bodyWeightLogs.findIndex(l=>l.date===dateVal);
  if(existingIdx>=0){
    state.bodyWeightLogs[existingIdx].weightKg = weightKg;
  } else {
    state.bodyWeightLogs.push({id:uid(), date:dateVal, weightKg});
  }
  saveState();
  closeSheet('sheetLogWeight');
  toast('Weigh-in saved');
  renderBodyWeightCard();
});

function renderProgressList(){
  renderProgressSummary();
  renderVolumeChart();
  renderMuscleBreakdown();
  renderBodyWeightCard();

  const query = (document.getElementById('progressSearchInput').value||'').toLowerCase().trim();

  // build map of exId -> {name, sessions[]}
  const map = {};
  state.sessions.forEach(s=>{
    s.exercises.forEach(ex=>{
      if(!ex.sets || !ex.sets.length) return;
      if(ex.sets[0].isWalk) return; // walks tracked separately, not in strength progression
      const exDef = findExercise(ex.exId);
      const isAssisted = !!(exDef && exDef.assisted);
      if(!map[ex.exId]) map[ex.exId] = {name:ex.name, entries:[], assisted:isAssisted};
      // warm-up sets don't count toward best/PR/1RM tracking
      const workingSets = ex.sets.filter(st=>!st.warmup);
      // for assisted exercises 0kg assistance is a real, meaningful value
      // (no help at all) and must not be filtered out like a blank entry.
      const validSets = workingSets.filter(st=>{
        const w = parseFloat(st.weight);
        return !isNaN(w) && (isAssisted ? w>=0 : w>0);
      });
      const weights = validSets.map(st=>parseFloat(st.weight));
      const maxW = weights.length ? Math.max(...weights) : null;
      const minW = weights.length ? Math.min(...weights) : null;
      const bestSet = validSets.length
        ? (isAssisted
            ? validSets.reduce((a,b)=> parseFloat(b.weight)<parseFloat(a.weight) ? b : a)
            : validSets.reduce((a,b)=> parseFloat(b.weight)>parseFloat(a.weight) ? b : a))
        : null;
      const totalReps = workingSets.reduce((a,st)=>a+(parseFloat(st.reps)||0),0);
      map[ex.exId].entries.push({
        date:s.date, maxWeight:maxW, minWeight:minW,
        bestSetWeight: bestSet ? parseFloat(bestSet.weight) : null,
        bestSetReps: bestSet ? (parseFloat(bestSet.reps)||0) : null,
        sets:workingSets.length, totalReps
      });
    });
  });

  let entries = Object.entries(map);
  if(query){
    entries = entries.filter(([id,v])=>v.name.toLowerCase().includes(query));
  }
  entries.sort((a,b)=>b[1].entries.length-a[1].entries.length);

  const container = document.getElementById('progressList');
  if(entries.length===0){
    container.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3v18h18"/><path d="M18 8l-5 5-3-3-4 4"/></svg>
      <p>${query? 'No matching exercises logged yet.' : 'Log a few sessions to see your strength progress here.'}</p>
    </div>`;
    return;
  }

  container.innerHTML = entries.map(([exId,v])=>{
    const sorted = v.entries.sort((a,b)=>a.date.localeCompare(b.date));
    const isAssisted = v.assisted;
    const points = isAssisted
      ? sorted.map(e=>e.minWeight).filter(w=>w!==null)
      : sorted.map(e=>e.maxWeight).filter(w=>w!==null && w>0);
    const best = points.length ? (isAssisted ? Math.min(...points) : Math.max(...points)) : null;
    const displayBest = best!==null ? kgToDisplay(best) : null;
    const bestLabel = isAssisted ? 'least assist' : 'best';

    return `<div class="progress-ex-card" data-progress-ex="${exId}">
      <div class="progress-ex-card-info">
        <div class="progress-ex-header">
          <h3>${v.name}</h3>
        </div>
        <div class="progress-ex-preview-row">
          <span class="progress-ex-preview-stat">${sorted.length} session${sorted.length!==1?'s':''}</span>
          ${displayBest!==null ? `<span class="progress-ex-preview-stat"><b class="num">${displayBest}${unitLabel()}</b> ${bestLabel}</span>` : ''}
        </div>
      </div>
      <div class="progress-ex-chevron">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-progress-ex]').forEach(card=>{
    card.addEventListener('click', ()=>{
      openExerciseProgressDetail(card.dataset.progressEx);
    });
  });
}

document.getElementById('progressSearchInput').addEventListener('input', renderProgressList);

/* ---------------- OVERVIEW / EXERCISES TOGGLE ---------------- */
document.getElementById('progressToggle').addEventListener('click', (e)=>{
  const btn = e.target.closest('.progress-toggle-btn');
  if(!btn) return;
  const tab = btn.dataset.progressTab;
  document.querySelectorAll('.progress-toggle-btn').forEach(b=>b.classList.toggle('active', b===btn));
  document.getElementById('progressPanelOverview').style.display = tab==='overview' ? 'block' : 'none';
  document.getElementById('progressPanelExercises').style.display = tab==='exercises' ? 'flex' : 'none';
});

/* ---------------- EXERCISE PROGRESS DETAIL SHEET ----------------
   Shared by the Progress tab (informational only) and the exercise picker
   (adds a "Watch tutorial" button when a video exists, plus an Add button
   in the footer to add the exercise straight from this sheet).
------------------------------------------------- */
function openExerciseProgressDetail(exId, fromPicker){
  const exDef = findExercise(exId);
  if(!exDef) return;
  const isAssisted = !!exDef.assisted;
  const history = getExerciseHistory(exId); // sorted oldest -> newest, {date, maxWeight, minWeight, bestSetWeight, bestSetReps}

  const content = document.getElementById('exerciseProgressContent');
  const footer = document.getElementById('exerciseProgressFooter');
  const videoId = getYouTubeId(exDef.videoUrl);

  const videoButtonHtml = videoId ? `
    <button class="btn btn-secondary btn-block mb-12" id="btnWatchTutorial" data-video-url="${exDef.videoUrl}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px; vertical-align:-2px;"><path d="M8 5v14l11-7z"/></svg>
      Watch tutorial
    </button>
  ` : '';

  if(history.length===0){
    content.innerHTML = `
      <div class="ex-progress-header">
        <div class="ex-progress-title">${exDef.name}</div>
        <div class="ex-progress-subtitle">${capitalize(exDef.muscle)}${isAssisted?' · Assisted':''}</div>
      </div>
      ${videoButtonHtml}
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3v18h18"/><path d="M18 8l-5 5-3-3-4 4"/></svg>
        <p>No history for this exercise yet.</p>
      </div>
    `;
    footer.innerHTML = fromPicker ? `<button class="btn btn-primary btn-block" id="btnAddFromDetail" data-add-ex="${exId}">+ ${pickerMode==='template'?'Add to routine':'Add to session'}</button>` : '';
    wireExerciseDetailButtons(exId, fromPicker);
    openSheet('sheetExerciseProgress');
    return;
  }

  const points = isAssisted ? history.map(h=>h.minWeight) : history.map(h=>h.maxWeight).filter(w=>w>0);
  const best = points.length ? (isAssisted ? Math.min(...points) : Math.max(...points)) : null;
  const latest = history[history.length-1];

  let best1RM = null;
  if(!isAssisted){
    const oneRMs = history.map(h=>estimate1RM(h.bestSetWeight, h.bestSetReps)).filter(v=>v!==null);
    best1RM = oneRMs.length ? Math.max(...oneRMs) : null;
  }

  const bigChart = points.length>=2 ? buildBigProgressChart(history.map(h=>isAssisted?h.minWeight:h.maxWeight), isAssisted) : '';
  const chartDates = history.slice(-12).map(h=>{
    const d = parseISO(h.date);
    return `${d.getDate()}/${d.getMonth()+1}`;
  });

  content.innerHTML = `
    <div class="ex-progress-header">
      <div class="ex-progress-title">${exDef.name}</div>
      <div class="ex-progress-subtitle">${capitalize(exDef.muscle)} · ${history.length} session${history.length!==1?'s':''} logged</div>
    </div>
    ${videoButtonHtml}
    ${isAssisted ? `<div class="pill mb-12" style="color:var(--cyan); border-color:#3ad6ff40; background:#3ad6ff14;">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
      Lower assistance is better
    </div>` : ''}
    ${bigChart ? `<div class="ex-progress-big-chart">
      ${bigChart}
      <div class="ex-progress-chart-labels">
        ${chartDates.length ? `<span>${chartDates[0]}</span><span>${chartDates[chartDates.length-1]}</span>` : ''}
      </div>
    </div>` : ''}
    <div class="ex-progress-stat-grid">
      <div class="stat-box"><div class="v num">${best!==null?kgToDisplay(best):'–'}${unitLabel()}</div><div class="l">${isAssisted?'Least assist':'Best'}</div></div>
      <div class="stat-box"><div class="v num">${best1RM!==null?'~'+kgToDisplay(Math.round(best1RM*10)/10):'–'}${best1RM!==null?unitLabel():''}</div><div class="l">Est. 1RM</div></div>
      <div class="stat-box"><div class="v num">${latest.bestSetReps||'–'}</div><div class="l">Last reps</div></div>
    </div>
    <h2 class="section-label">Session history</h2>
    <div class="card" style="padding:2px 14px;">
      ${[...history].reverse().map(h=>{
        const d = parseISO(h.date);
        const weightVal = isAssisted ? h.minWeight : h.maxWeight;
        const displayW = weightVal!=null ? kgToDisplay(weightVal) : null;
        return `<div class="ex-history-row">
          <div class="ex-history-date">
            <div class="d num">${d.getDate()}</div>
            <div class="m">${d.toLocaleDateString(undefined,{month:'short'})}</div>
          </div>
          <div class="ex-history-sets">${h.bestSetWeight!=null?`${kgToDisplay(h.bestSetWeight)}${unitLabel()}${isAssisted?' assist':''} × ${h.bestSetReps}`:'–'}</div>
          ${displayW!==null ? `<div class="ex-history-best num">${displayW}${unitLabel()}</div>` : ''}
        </div>`;
      }).join('')}
    </div>
  `;
  footer.innerHTML = fromPicker ? `<button class="btn btn-primary btn-block" id="btnAddFromDetail" data-add-ex="${exId}">+ ${pickerMode==='template'?'Add to routine':'Add to session'}</button>` : '';
  wireExerciseDetailButtons(exId, fromPicker);
  openSheet('sheetExerciseProgress');
}

function wireExerciseDetailButtons(exId, fromPicker){
  const videoBtn = document.getElementById('btnWatchTutorial');
  if(videoBtn){
    videoBtn.addEventListener('click', ()=>{
      openVideoModal(videoBtn.dataset.videoUrl);
    });
  }
  const addBtn = document.getElementById('btnAddFromDetail');
  if(addBtn){
    addBtn.addEventListener('click', ()=>{
      closeSheet('sheetExerciseProgress');
      if(pickerMode==='template'){
        addExerciseToTemplateDraft(exId);
      } else {
        addExerciseToWorkout(exId);
      }
    });
  }
}

// Entry point from the exercise picker specifically — kept as a distinct
// name so the picker's tap handler reads clearly at the call site.
function openExercisePickerDetail(exId){
  openExerciseProgressDetail(exId, true);
}

// Larger progress-page version of the sparkline: same up-good/down-good
// inversion logic as buildSparkline, sized for the detail sheet.
function buildBigProgressChart(points, invert){
  const w=340, h=110, pad=8;
  const min = Math.min(...points), max = Math.max(...points);
  const range = (max-min)||1;
  const trimmed = points.slice(-12); // keep the chart readable, most recent 12 sessions
  const stepX = trimmed.length>1 ? (w-pad*2)/(trimmed.length-1) : 0;
  const coords = trimmed.map((p,i)=>{
    const x = pad+i*stepX;
    const normalized = invert ? (max-p)/range : (p-min)/range;
    const y = h-pad-normalized*(h-pad*2);
    return [x,y];
  });
  const path = coords.map((c,i)=>(i===0?'M':'L')+c[0].toFixed(1)+' '+c[1].toFixed(1)).join(' ');
  const areaPath = path + ` L${coords[coords.length-1][0].toFixed(1)} ${h-pad} L${coords[0][0].toFixed(1)} ${h-pad} Z`;
  const color = invert ? '#3ad6ff' : '#39ff9a';
  const lastPoint = coords[coords.length-1];
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    <defs>
      <linearGradient id="progressChartFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${areaPath}" fill="url(#progressChartFade)" stroke="none"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${coords.map((c,i)=>i===coords.length-1
      ? `<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="4" fill="${color}"/>`
      : `<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="2" fill="${color}" opacity="0.5"/>`
    ).join('')}
  </svg>`;
}

/* ---------------- SETTINGS ---------------- */
function loadSettingsIntoForm(){
  document.getElementById('settingBodyWeight').value = state.settings.bodyWeightKg;
  document.getElementById('settingWeeklyGoal').value = state.settings.weeklyGoal;
  document.getElementById('toggleUnits').classList.toggle('on', state.settings.useLbs);
  refreshNotificationsToggleUI();
  updateLastBackupLabel();
  const versionEl = document.getElementById('appVersionLabel');
  if(versionEl) versionEl.textContent = APP_VERSION;
}

function refreshNotificationsToggleUI(){
  const toggle = document.getElementById('toggleNotifications');
  const sub = document.getElementById('notificationsStatusSub');
  if(!toggle) return;
  const supported = 'Notification' in window;
  const isOn = state.settings.notificationsEnabled && supported && Notification.permission==='granted';
  toggle.classList.toggle('on', isOn);
  if(!supported){
    sub.textContent = 'Not supported in this browser';
  } else if(Notification.permission==='denied'){
    sub.textContent = 'Blocked — enable in your browser/app settings';
  } else {
    sub.textContent = 'Get notified when rest starts and ends';
  }
}

/* ---------------- CLOUD SYNC (Firebase) ---------------- */
function initCloudSync(){
  if(!window.GymSync) return; // firebase-sync.js not loaded yet or not configured
  window.GymSync.init(handleAuthChange, handleRemoteChange);
}

function handleAuthChange({signedIn, user, remoteState}){
  const signedOutCard = document.getElementById('syncSignedOutCard');
  const signedInCard = document.getElementById('syncSignedInCard');
  if(!signedOutCard || !signedInCard) return; // settings view not in DOM yet, fine

  if(signedIn){
    signedOutCard.style.display = 'none';
    signedInCard.style.display = 'block';
    document.getElementById('syncUserName').textContent = user.name || user.email || 'Signed in';
    document.getElementById('syncUserPhoto').src = user.photo || '';
    document.getElementById('syncStatusLabel').textContent = 'Synced';

    if(remoteState){
      // merge remote into local by id, additive and non-destructive, same
      // strategy as manual backup import so no data is silently dropped
      mergeState(remoteState);
      if(remoteState.settings){
        state.settings = Object.assign({}, state.settings, remoteState.settings);
      }
      saveState();
      renderHome();
      loadSettingsIntoForm();
    } else {
      // first time this account has synced — push current local data up
      saveState();
    }
    toast('Signed in — syncing across devices');
  } else {
    signedOutCard.style.display = 'block';
    signedInCard.style.display = 'none';
  }
}

function handleRemoteChange(remoteState){
  // fired when another device pushes changes; merge additively and re-render
  if(!remoteState) return;
  mergeState(remoteState);
  if(remoteState.settings){
    state.settings = Object.assign({}, state.settings, remoteState.settings);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); // local write only, don't re-push
  if(currentView==='home') renderHome();
  if(currentView==='calendar') renderCalendar();
  if(currentView==='progress') renderProgressList();
  if(currentView==='templates') renderTemplatesFullList();
  loadSettingsIntoForm();
  toast('Synced from another device');
}

document.getElementById('btnGoogleSignIn').addEventListener('click', ()=>{
  if(window.GymSync) window.GymSync.signIn();
});
document.getElementById('btnGoogleSignOut').addEventListener('click', ()=>{
  if(window.GymSync) window.GymSync.signOut();
});

document.getElementById('settingBodyWeight').addEventListener('input', (e)=>{
  const v = parseFloat(e.target.value);
  if(!isNaN(v) && v>0){ state.settings.bodyWeightKg = v; saveState(); }
});
document.getElementById('settingWeeklyGoal').addEventListener('input', (e)=>{
  const v = parseInt(e.target.value);
  if(!isNaN(v) && v>0){ state.settings.weeklyGoal = v; saveState(); }
});
document.getElementById('toggleUnits').addEventListener('click', (e)=>{
  state.settings.useLbs = !state.settings.useLbs;
  e.target.classList.toggle('on', state.settings.useLbs);
  saveState();
  toast(state.settings.useLbs ? 'Switched to lbs' : 'Switched to kg');
});

document.getElementById('toggleNotifications').addEventListener('click', async ()=>{
  const wantsOn = !state.settings.notificationsEnabled;
  if(wantsOn){
    openSheet('sheetNotificationsExplainer');
    return; // actual permission request happens after the user taps Continue
  }
  state.settings.notificationsEnabled = false;
  toast('Rest timer notifications off');
  saveState();
  refreshNotificationsToggleUI();
});

document.getElementById('btnNotificationsExplainerCancel').addEventListener('click', ()=>{
  closeSheet('sheetNotificationsExplainer');
});

document.getElementById('btnNotificationsExplainerContinue').addEventListener('click', async ()=>{
  closeSheet('sheetNotificationsExplainer');
  const granted = await requestNotificationPermission();
  state.settings.notificationsEnabled = granted;
  if(granted) toast('Rest timer notifications on');
  saveState();
  refreshNotificationsToggleUI();
});

function updateLastBackupLabel(){
  const el = document.getElementById('lastBackupLabel');
  if(state.settings.lastBackupAt){
    const d = new Date(state.settings.lastBackupAt);
    el.textContent = `Last backup exported ${d.toLocaleDateString()} at ${d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
  } else {
    el.textContent = 'No backup exported yet.';
  }
}

/* ---------------- BACKUP / RESTORE ---------------- */
document.getElementById('btnExportBackup').addEventListener('click', ()=>{
  const payload = {
    app: 'gym-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: state
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = todayISO();
  a.href = url;
  a.download = `gym-tracker-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  state.settings.lastBackupAt = Date.now();
  saveState();
  updateLastBackupLabel();
  toast('Backup exported');
});

document.getElementById('btnImportBackup').addEventListener('click', ()=>{
  document.getElementById('fileImportInput').click();
});

document.getElementById('fileImportInput').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async (evt)=>{
    try{
      const parsed = JSON.parse(evt.target.result);
      const incoming = parsed.data || parsed; // support raw state too
      if(!incoming.sessions || !Array.isArray(incoming.sessions)){
        toast('Invalid backup file');
        return;
      }
      const choice = await confirmDialog3Way({
        title: 'Restore backup',
        message: `This backup contains ${incoming.sessions.length} session${incoming.sessions.length!==1?'s':''}. Choose how to apply it to this device.`,
        options: [
          {label:'Merge with current data', value:'merge'},
          {label:'Replace current data entirely', value:'replace', danger:true},
          {label:'Cancel', value:null}
        ]
      });
      if(choice===null) return;
      if(choice==='merge'){
        mergeState(incoming);
      } else {
        state = Object.assign(defaultState(), incoming, {
          settings: Object.assign(defaultState().settings, incoming.settings||{})
        });
      }
      saveState();
      toast('Backup restored');
      renderHome();
      loadSettingsIntoForm();
    }catch(err){
      console.error(err);
      toast('Could not read backup file');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

function mergeState(incoming){
  const existingIds = new Set(state.sessions.map(s=>s.id));
  incoming.sessions.forEach(s=>{
    if(!existingIds.has(s.id)){
      state.sessions.push(s);
    }
  });
  if(incoming.customExercises){
    const existingCustomIds = new Set(state.customExercises.map(e=>e.id));
    incoming.customExercises.forEach(e=>{
      if(!existingCustomIds.has(e.id)) state.customExercises.push(e);
    });
  }
  if(incoming.templates){
    if(!state.templates) state.templates = [];
    const existingTemplateIds = new Set(state.templates.map(t=>t.id));
    incoming.templates.forEach(t=>{
      if(!existingTemplateIds.has(t.id)) state.templates.push(t);
    });
  }
  if(incoming.bodyWeightLogs){
    if(!state.bodyWeightLogs) state.bodyWeightLogs = [];
    // one entry per date (same rule as logging a weigh-in normally) — an
    // incoming log for a date that already exists here updates it rather
    // than being silently dropped or creating a duplicate point on the chart
    const existingByDate = new Map(state.bodyWeightLogs.map(l=>[l.date,l]));
    incoming.bodyWeightLogs.forEach(l=>{
      if(existingByDate.has(l.date)){
        existingByDate.get(l.date).weightKg = l.weightKg;
      } else {
        state.bodyWeightLogs.push(l);
      }
    });
  }
}

document.getElementById('btnResetAll').addEventListener('click', async ()=>{
  const ok = await confirmDialog({
    title: 'Erase all data?',
    message: 'This permanently deletes every session, routine, and setting on this device. Consider exporting a backup first — this cannot be undone.',
    confirmLabel: 'Erase everything',
    danger: true
  });
  if(!ok) return;
  state = defaultState();
  saveState();
  toast('All data erased');
  showView('home');
});

/* ---------------- CONFIRM DIALOG ----------------
   Replaces native confirm() with a styled, in-app modal. Promise-based so
   call sites read like `if(await confirmDialog({...})) { ... }`, the same
   shape as the confirm() calls it replaces. Backdrop tap counts as cancel,
   matching how a native dialog's Esc key behaves — there's no X button,
   since a confirmation should resolve to an explicit choice between the
   two buttons rather than offer a third silent-dismiss path.
------------------------------------------------- */
function confirmDialog({title, message, confirmLabel='Confirm', cancelLabel='Cancel', danger=true}={}){
  return new Promise(resolve=>{
    document.getElementById('confirmModalTitle').textContent = title || 'Are you sure?';
    document.getElementById('confirmModalMessage').textContent = message || '';
    document.getElementById('confirmModalIcon').classList.toggle('neutral', !danger);

    const actions = document.getElementById('confirmModalActions');
    actions.className = 'confirm-modal-actions';
    actions.innerHTML = `
      <button class="btn ${danger?'btn-danger':'btn-primary'} btn-block" id="btnConfirmModalYes">${confirmLabel}</button>
      <button class="btn btn-secondary btn-block" id="btnConfirmModalNo">${cancelLabel}</button>
    `;

    const backdrop = document.getElementById('confirmModalBackdrop');
    const modal = document.getElementById('confirmModal');

    const finish = (result)=>{
      backdrop.classList.remove('open');
      modal.classList.remove('open');
      backdrop.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onCancel = ()=>finish(false);

    document.getElementById('btnConfirmModalYes').addEventListener('click', ()=>finish(true), {once:true});
    document.getElementById('btnConfirmModalNo').addEventListener('click', onCancel, {once:true});
    backdrop.addEventListener('click', onCancel);

    backdrop.classList.add('open');
    modal.classList.add('open');
  });
}

// Three-way variant for the backup-restore flow (merge / replace / cancel)
// — not a yes/no question, so it gets its own button layout rather than
// forcing that choice through confirmDialog's two-button shape.
function confirmDialog3Way({title, message, options}={}){
  return new Promise(resolve=>{
    document.getElementById('confirmModalTitle').textContent = title || '';
    document.getElementById('confirmModalMessage').textContent = message || '';
    document.getElementById('confirmModalIcon').classList.add('neutral');

    const actions = document.getElementById('confirmModalActions');
    actions.className = 'confirm-modal-actions';
    actions.innerHTML = options.map((opt,i)=>
      `<button class="btn ${opt.danger?'btn-danger':(i===0?'btn-primary':'btn-secondary')} btn-block" data-opt="${i}">${opt.label}</button>`
    ).join('');

    const backdrop = document.getElementById('confirmModalBackdrop');
    const modal = document.getElementById('confirmModal');

    const finish = (result)=>{
      backdrop.classList.remove('open');
      modal.classList.remove('open');
      backdrop.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onCancel = ()=>finish(null);

    actions.querySelectorAll('[data-opt]').forEach(btn=>{
      btn.addEventListener('click', ()=>finish(options[+btn.dataset.opt].value), {once:true});
    });
    backdrop.addEventListener('click', onCancel);

    backdrop.classList.add('open');
    modal.classList.add('open');
  });
}

/* ---------------- SHEETS ---------------- */
function openSheet(id){
  document.getElementById('sheetBackdrop').classList.add('open');
  document.getElementById(id).classList.add('open');
  document.body.classList.add('sheet-open');
}
function closeSheet(id){
  document.getElementById('sheetBackdrop').classList.remove('open');
  document.getElementById(id).classList.remove('open');
  document.body.classList.remove('sheet-open');
  // Any sheet that might contain a mounted muscle map (summary, session
  // detail, routine editor) should stop rendering it once hidden — a single
  // check here covers every close path (buttons, swipe-dismiss, backdrop
  // tap) instead of needing to remember it at each call site.
  if(currentMuscleMapInstance){
    currentMuscleMapInstance.destroy();
    currentMuscleMapInstance = null;
  }
}
document.getElementById('sheetBackdrop').addEventListener('click', ()=>{
  document.querySelectorAll('.sheet.open').forEach(s=>s.classList.remove('open'));
  document.getElementById('sheetBackdrop').classList.remove('open');
  document.body.classList.remove('sheet-open');
  if(currentMuscleMapInstance){
    currentMuscleMapInstance.destroy();
    currentMuscleMapInstance = null;
  }
});

/* ---------------- VIDEO TUTORIAL MODAL ----------------
   Opens above whatever sheet is currently showing (session detail, etc.)
   without closing it, so dismissing the video returns right back to where
   the user was. Uses YouTube's iframe embed — no API key needed.
------------------------------------------------- */
function openVideoModal(videoUrl){
  const videoId = getYouTubeId(videoUrl);
  if(!videoId) return;
  const iframe = document.getElementById('videoModalIframe');
  // youtube-nocookie.com instead of youtube.com: on Android (especially
  // inside a TWA), Chrome/WebView has a registered app-link intent for
  // youtube.com and will hand the embed off to the YouTube app instead of
  // rendering it inline, even inside an iframe. The nocookie domain isn't
  // covered by that intent filter, so it stays in-page as intended.
  // playsinline=1 reinforces the same "don't take over" behavior on iOS.
  iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&playsinline=1`;
  document.getElementById('videoModalBackdrop').classList.add('open');
  document.getElementById('videoModal').classList.add('open');
}

function closeVideoModal(){
  document.getElementById('videoModalBackdrop').classList.remove('open');
  document.getElementById('videoModal').classList.remove('open');
  // clear the iframe so playback actually stops (removing/hiding alone would
  // leave audio playing in the background); about:blank is the correct way
  // to do this — setting src='' resolves to the current page URL instead.
  document.getElementById('videoModalIframe').src = 'about:blank';
}

document.getElementById('btnCloseVideoModal').addEventListener('click', closeVideoModal);
document.getElementById('videoModalBackdrop').addEventListener('click', closeVideoModal);

/* ---------------- SWIPE-DOWN-TO-DISMISS (generic, works on any .sheet via its handle) ---------------- */
let sheetSwipe = null; // {sheetEl, startY, lastY, lastT, velocity}

function initSheetSwipeToDismiss(){
  document.querySelectorAll('.sheet-handle-hitarea').forEach(handle=>{
    handle.addEventListener('pointerdown', onSheetSwipeStart);
  });
}

function onSheetSwipeStart(e){
  const sheetEl = e.currentTarget.closest('.sheet');
  if(!sheetEl) return;
  e.preventDefault();

  sheetSwipe = {
    sheetEl,
    startY: e.clientY,
    lastY: e.clientY,
    lastT: performance.now(),
    velocity: 0
  };
  sheetEl.classList.add('dragging');

  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  handle.addEventListener('pointermove', onSheetSwipeMove);
  handle.addEventListener('pointerup', onSheetSwipeEnd);
  handle.addEventListener('pointercancel', onSheetSwipeEnd);
}

function onSheetSwipeMove(e){
  if(!sheetSwipe) return;
  const dy = e.clientY - sheetSwipe.startY;
  const clamped = Math.max(0, dy); // only allow dragging downward, not past the open position
  sheetSwipe.sheetEl.style.transform = `translate(-50%, ${clamped}px)`;

  const now = performance.now();
  const dt = now - sheetSwipe.lastT;
  if(dt>0){
    sheetSwipe.velocity = (e.clientY - sheetSwipe.lastY) / dt; // px/ms, positive = moving down
  }
  sheetSwipe.lastY = e.clientY;
  sheetSwipe.lastT = now;
}

function onSheetSwipeEnd(e){
  if(!sheetSwipe) return;
  const handle = e.currentTarget;
  handle.removeEventListener('pointermove', onSheetSwipeMove);
  handle.removeEventListener('pointerup', onSheetSwipeEnd);
  handle.removeEventListener('pointercancel', onSheetSwipeEnd);
  try{ handle.releasePointerCapture(e.pointerId); }catch(err){}

  const { sheetEl, velocity } = sheetSwipe;
  const draggedDown = Math.max(0, e.clientY - sheetSwipe.startY);
  const sheetHeight = sheetEl.getBoundingClientRect().height;
  const pastThreshold = draggedDown > sheetHeight*0.25 || draggedDown > 120;
  const fastFlick = velocity > 0.6; // quick downward flick, even if short distance

  sheetEl.classList.remove('dragging');
  sheetEl.style.transform = ''; // let the CSS class-driven transform (open/closed) take back over

  if(pastThreshold || fastFlick){
    sheetEl.classList.remove('open');
    // if no other sheet is open, also hide the shared backdrop
    if(!document.querySelector('.sheet.open')){
      document.getElementById('sheetBackdrop').classList.remove('open');
      document.body.classList.remove('sheet-open');
    }
    if(currentMuscleMapInstance){
      currentMuscleMapInstance.destroy();
      currentMuscleMapInstance = null;
    }
  }
  // else: removing the inline transform naturally snaps it back to .open's translateY(0)

  sheetSwipe = null;
}

initSheetSwipeToDismiss();

/* ---------------- SESSION DETAIL (tap from list) ---------------- */
document.addEventListener('click', (e)=>{
  const item = e.target.closest('[data-session]');
  if(!item) return;
  const session = state.sessions.find(s=>s.id===item.dataset.session);
  if(!session) return;
  showSessionDetail(session);
});

function showSessionDetail(session){
  const d = parseISO(session.date);
  const isToday = session.date===todayISO();
  const isGeneralWalk = session.type==='walk' && session.exercises.length===0;

  if(isGeneralWalk){
    document.getElementById('exerciseDetailHeader').innerHTML = `
      <div class="session-detail-hero">
        <div>
          <div class="session-detail-date">${d.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'})}</div>
          <div class="session-detail-type">Walk${isToday?' · Today':''}</div>
        </div>
      </div>
      <div class="session-detail-stat-grid">
        <div class="stat-box"><div class="v num">${session.steps ? session.steps.toLocaleString() : '–'}</div><div class="l">Steps</div></div>
        <div class="stat-box"><div class="v num">${session.distanceKm || '–'}</div><div class="l">Km</div></div>
        <div class="stat-box"><div class="v num" style="color:var(--positive);">${Math.round(sessionTotalKcal(session))}</div><div class="l">Kcal</div></div>
      </div>
    `;
    document.getElementById('exerciseDetailContent').innerHTML = '';
    document.getElementById('exerciseDetailFooter').innerHTML = `
      <button class="btn btn-danger btn-block" id="btnDeleteSession" data-del="${session.id}">Delete this walk</button>
    `;
    openSheet('sheetExerciseDetail');
    document.getElementById('btnDeleteSession').addEventListener('click', async (e)=>{
      const ok = await confirmDialog({
        title: 'Delete this walk?',
        message: 'This cannot be undone.',
        confirmLabel: 'Delete walk'
      });
      if(ok){
        state.sessions = state.sessions.filter(s=>s.id!==e.target.dataset.del);
        saveState();
        closeSheet('sheetExerciseDetail');
        renderHome();
        renderCalendar();
        toast('Walk deleted');
      }
    });
    return;
  }

  document.getElementById('exerciseDetailHeader').innerHTML = `
    <div class="session-detail-hero">
      <div>
        <div class="session-detail-date">${d.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'})}</div>
        <div class="session-detail-type">${session.type==='walk'?'Walk session':'Strength session'}${isToday?' · Today':''}</div>
      </div>
    </div>
    <div class="session-detail-stat-grid">
      <div class="stat-box"><div class="v num">${session.exercises.length}</div><div class="l">Exercises</div></div>
      <div class="stat-box"><div class="v num">${session.durationMin}</div><div class="l">Minutes</div></div>
      <div class="stat-box"><div class="v num" style="color:var(--positive);">${Math.round(sessionTotalKcal(session))}</div><div class="l">Kcal</div></div>
    </div>
    <button class="btn btn-secondary btn-block mb-16" id="btnViewSessionMuscles">
      <i class="fa-solid fa-dumbbell"></i>
      View muscles worked
    </button>
  `;

  const content = document.getElementById('exerciseDetailContent');
  content.innerHTML = wrapSupersetPairs(session.exercises, ex=>renderSessionExerciseCard(ex));

  document.getElementById('exerciseDetailFooter').innerHTML = `
    <button class="btn btn-danger btn-block" id="btnDeleteSession" data-del="${session.id}">Delete this session</button>
  `;

  openSheet('sheetExerciseDetail');

  document.getElementById('btnViewSessionMuscles').addEventListener('click', ()=>{
    const highlights = computeSessionMuscleIntensity(session);
    currentMuscleMapView = 'front';
    renderMuscleMapCard('routineMusclesMap', highlights, {
      title: 'Muscles worked this session',
      emptyMessage: 'No strength exercises with tracked muscles in this session.'
    });
    document.getElementById('muscleMapModalBackdrop').classList.add('open');
    document.getElementById('muscleMapModal').classList.add('open');
  });

  content.querySelectorAll('[data-video-thumb]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      openVideoModal(el.dataset.videoThumb);
    });
  });

  document.getElementById('btnDeleteSession').addEventListener('click', async (e)=>{
    const ok = await confirmDialog({
      title: 'Delete this session?',
      message: 'This cannot be undone.',
      confirmLabel: 'Delete session'
    });
    if(ok){
      state.sessions = state.sessions.filter(s=>s.id!==e.target.dataset.del);
      saveState();
      closeSheet('sheetExerciseDetail');
      renderHome();
      renderCalendar();
      toast('Session deleted');
    }
  });
}

function renderSessionExerciseCard(ex){
  const exDef = findExercise(ex.exId);
  const isAssisted = !!(exDef && exDef.assisted);
  const isHoldBased = !!(exDef && exDef.holdBased);
  const isWalk = ex.sets.length===1 && ex.sets[0].isWalk;
  const icon = exDef ? exDef.icon : '🏋️';

  const videoId = exDef ? getYouTubeId(exDef.videoUrl) : null;
  const thumbHtml = videoId ? `
    <div class="session-ex-video-thumb" data-video-thumb="${exDef.videoUrl}" title="Watch tutorial">
      <img src="https://img.youtube.com/vi/${videoId}/hqdefault.jpg" alt="" loading="lazy">
      <div class="play-badge"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
    </div>
  ` : '';

  if(isWalk){
    const w = ex.sets[0];
    return `<div class="session-ex-card">
      <div class="session-ex-card-header">
        <div class="session-ex-card-icon">🚶</div>
        <div class="session-ex-card-name">${ex.name}</div>
      </div>
      <div class="session-walk-summary">
        <div class="session-walk-stat"><div class="v num">${w.speed}</div><div class="l">km/h</div></div>
        <div class="session-walk-stat"><div class="v num">${w.incline}%</div><div class="l">Incline</div></div>
        <div class="session-walk-stat"><div class="v num">${w.duration}</div><div class="l">Minutes</div></div>
      </div>
    </div>`;
  }

  const rows = ex.sets.map((s,i)=>{
    const wNum = parseFloat(s.weight);
    const w = kgToDisplay(isNaN(wNum) ? 0 : wNum);
    const wDisplay = (s.weight===0 || s.weight==='0' || w>0) ? w : '–';
    const diffKey = s.difficulty || 'medium';
    const diffLabel = {easy:'Easy', medium:'Med', hard:'Hard'}[diffKey] || 'Med';
    return `<tr class="${s.warmup?'warmup-row':''}">
      <td class="set-num-cell num">${s.warmup?'W':i+1}</td>
      <td class="num">${wDisplay}</td>
      <td class="num">${s.reps ? (isHoldBased ? `${s.reps}s` : s.reps) : '–'}</td>
      <td><span class="session-set-diff-badge ${diffKey}">${diffLabel}</span></td>
    </tr>`;
  }).join('');

  return `<div class="session-ex-card">
    <div class="session-ex-card-header">
      <div class="session-ex-card-icon">${icon}</div>
      <div class="session-ex-card-name">${ex.name}${isAssisted?'<span class="assist-tag">Assisted — lower is better</span>':''}</div>
      ${thumbHtml}
    </div>
    <table class="session-set-grid">
      <colgroup>
        <col class="col-num"><col class="col-weight"><col class="col-reps"><col class="col-effort">
      </colgroup>
      <thead><tr><th>#</th><th>${unitLabel()}${isAssisted?' assist':''}</th><th>${isHoldBased?'Seconds':'Reps'}</th><th>Effort</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${ex.notes ? `<div class="session-ex-notes">"${ex.notes}"</div>` : ''}
  </div>`;
}

/* ---------------- SERVICE WORKER / PWA ----------------
   The fetch handler in sw.js is already network-first for app files, so a
   fresh deploy is normally just one reload away — the actual pain point
   this session kept running into wasn't stale file *content*, it was the
   browser not noticing a new service worker exists promptly, and even
   once it did, an already-open tab just kept running whatever JS it had
   already loaded into memory until someone manually closed and reopened
   the app (sometimes twice). Two changes address that directly:
   1. Proactively ask the browser to check for a new sw.js — on load, then
      again whenever the tab becomes visible (a PWA left open in the
      background for a while, which is the common case on a phone, would
      otherwise just wait on Chrome's own internal throttled check).
   2. The moment a new service worker actually takes control (controllerchange),
      reload automatically instead of leaving the update installed-but-unused
      until the person happens to reopen the app. Safe to do — the active
      workout is already persisted to localStorage independently of this,
      so a reload mid-session doesn't lose in-progress sets. */
if('serviceWorker' in navigator){
  let swRegistration = null;
  let reloadingForUpdate = false;

  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js')
      .then(reg=>{ swRegistration = reg; })
      .catch(err=>console.warn('SW registration failed', err));
  });

  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState==='visible' && swRegistration){
      swRegistration.update().catch(()=>{});
    }
  });

  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    if(reloadingForUpdate) return; // guards against a reload loop if this somehow fires more than once
    reloadingForUpdate = true;
    toast('Updating to the latest version…');
    setTimeout(()=>location.reload(), 800);
  });
}

/* ---------------- INIT ---------------- */
function init(){
  const restored = loadActiveWorkout();
  if(restored){
    activeWorkout = restored;
    startWorkoutTimer();
  }
  // A shared-routine link lands as #routine=<payload> — decode it and open
  // the preview/import view directly rather than going to Home first.
  if(location.hash.startsWith('#routine=')){
    const b64 = decodeURIComponent(location.hash.slice('#routine='.length));
    history.replaceState(null, '', location.pathname + location.search);
    try{
      pendingSharedRoutine = decodeShareableRoutine(b64);
    }catch(e){
      console.error('Failed to decode shared routine', e);
      pendingSharedRoutine = null;
    }
  }
  showView(pendingSharedRoutine ? 'shared-routine' : 'home');
  loadSettingsIntoForm();
  waitForGymSyncThenInit();
}

function waitForGymSyncThenInit(attempts){
  attempts = attempts || 0;
  if(window.GymSync){
    initCloudSync();
    return;
  }
  if(attempts > 100) return; // give up after ~10s, sync module likely failed to load
  setTimeout(()=>waitForGymSyncThenInit(attempts+1), 100);
}

init();

// Exposes a small set of pure, side-effect-free functions for the automated
// test suite (see /tests) to call directly — nothing here changes app
// behavior; it's purely a read-only window onto functions that already
// exist above, so tests exercise the real implementation instead of a copy
// that could silently drift out of sync with it.
// Small shared-UI hooks so independent modules (groups.js) can reuse the
// app's existing toast/confirm/sheet/nav primitives instead of duplicating
// them — keeps group-challenge UI visually and behaviorally consistent with
// the rest of the app without coupling groups.js to app.js's internals.
if(typeof window !== 'undefined'){
  window.GymUI = {
    toast,
    confirmDialog,
    openSheet,
    closeSheet,
    showView,
    fmtDateISO,
    parseISO,
    todayISO,
    // Lets groups.js ask for a home-screen repaint when its live challenge
    // data changes, without needing to know app.js's internal view state —
    // a no-op if the person isn't currently looking at Home.
    refreshHomeChallengesIfVisible(){
      if(currentView==='home') renderTodayRoutineSuggestion();
    }
  };
}

if(typeof window !== 'undefined'){
  window.__gymTrackerTestHooks = {
    estimateSetKcal,
    estimateStrengthExerciseKcal,
    estimateInclineWalkKcal,
    estimateGeneralWalkKcal,
    stepsToKm,
    estimate1RM,
    startOfWeek,
    startOfMonth,
    parseISO,
    fmtDateISO,
    kgToDisplay,
    displayToKgIfNeeded,
    formatRestShort
  };
}

})();
