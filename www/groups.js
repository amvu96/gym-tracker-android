/* ============================================================
   GROUP CHALLENGES
   Shared, multi-writer group data — separate from the single-user
   localStorage/Firestore blob the rest of the app uses. Requires sign-in
   (there's no meaningful "offline group"), reuses the same Firebase app
   instance firebase-sync.js already created (via window.GymSync.getDb()/
   getAuth()), and reuses app.js's toast/confirm/sheet primitives (via
   window.GymUI) so it looks and behaves like the rest of the app.

   Data model (Firestore):
   groups/{groupId}
     name, ownerUid, ownerName, inviteCode, createdAt, memberUids:[uid,...]
   groups/{groupId}/members/{uid}
     uid, displayName, photoURL, color, colorIndex, joinedAt
   groups/{groupId}/challenges/{challengeId}
     title, targetLabel, startDate, endDate, createdBy, createdAt, active
   groups/{groupId}/challenges/{challengeId}/completions/{date_uid}
     uid, date, displayName, color, completedAt, reactions:{uid:emoji}
   ============================================================ */
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, onSnapshot, runTransaction, serverTimestamp, limit, deleteField, arrayRemove, arrayUnion
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

(function(){
  'use strict';

  const MAX_MEMBERS = 8;
  // Distinct, colorblind-considerate palette, chosen for contrast against
  // the app's dark panel background.
  const PALETTE = [
    '#39ff9a', '#3ad6ff', '#ff5f6d', '#ffb84d',
    '#c792ff', '#ff7ad9', '#ffe45e', '#7cf7c9'
  ];

  let db = null, auth = null;
  let currentUser = null;
  let myGroups = []; // [{id, ...data}]
  let myGroupsUnsub = null;

  // Detail-view state for whichever group is currently open
  let activeGroupId = null;
  let activeGroup = null;
  let activeMembers = []; // [{uid, displayName, color, ...}]
  let activeChallenges = []; // all currently-active (not-yet-ended) challenges for this group
  let selectedCalendarChallengeId = null; // which active challenge the calendar below is showing
  let challengeCompletions = {}; // challengeId -> {byDate:{date:[{uid,displayName,color,date}]}, seenKeys, notified, unsub, loadedOnce}
  // Gates the very first render of the group screen behind "all three initial
  // loads (members, challenges, each active challenge's completions) have
  // landed at least once" — otherwise each Firestore listener resolving on
  // its own schedule pops sections in one at a time (member row, then empty
  // challenge cards, then cards filling in with progress) which reads as
  // jitter. Live updates *after* this initial reveal apply immediately as
  // normal; this only smooths the first paint.
  let groupDetailReady = false;
  let membersLoadedOnce = false;
  let challengesLoadedOnce = false;
  let membersUnsub = null;
  let challengeUnsub = null;
  let calCursor = new Date();
  let selectedChallengeFreq = 'daily'; // working selection in the "New challenge" sheet
  let requirePhotoOn = false; // working selection for the "New challenge" sheet's photo-requirement toggle
  let requireLocationOn = false; // working selection — only ever meaningful alongside requirePhotoOn
  let activityFeedItems = []; // merged, cached feed for the currently-open group
  let activityLogItems = []; // live "transparency log" — rename/join/leave/kick/etc, no reactions
  let activityLogUnsub = null;

  /* ---------------- small local date helpers (kept independent of app.js) ---------------- */
  function fmtISO(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function todayISO(){ return fmtISO(new Date()); }
  function parseISO(iso){ const [y,m,d]=iso.split('-').map(Number); return new Date(y,m-1,d); }

  function ui(){ return window.GymUI || {}; }
  function toast(msg){ if(ui().toast) ui().toast(msg); else console.log(msg); }

  /* ---------------- init / auth wiring ---------------- */
  function init(){
    if(!window.GymSync || !window.GymSync.isConfigured()){
      // Cloud sync not configured — groups view will show a static message.
      return;
    }
    db = window.GymSync.getDb();
    auth = window.GymSync.getAuth();
    window.GymSync.onAuthChange((user)=>{
      currentUser = user;
      teardownMyGroupsListener();
      if(user){
        listenToMyGroups();
      } else {
        myGroups = [];
        teardownAllHomeChallengeListeners();
        notifyHomeRefresh();
        if(document.getElementById('view-groups').classList.contains('active')) renderRoot();
      }
      // If the invite-landing panel is open (e.g. they just tapped
      // "Sign in with Google" from it), refresh it so the Accept button
      // appears now that we know who they are — signing in and accepting
      // are two distinct, explicit steps, not one auto-join.
      if(pendingInviteGroup) renderInvitePanel();
    });

    // Deep-link join: #join=CODE
    if(location.hash.startsWith('#join=')){
      const code = decodeURIComponent(location.hash.slice(6));
      history.replaceState(null, '', location.pathname + location.search);
      pendingJoinCode = code;
    }

    bindStaticUI();

    // A join link can land while the app boots straight to Home — jump to
    // the Groups tab ourselves instead of leaving the code stranded until
    // the person happens to tap the tab manually.
    if(pendingJoinCode && ui().showView){
      ui().showView('groups');
    }
  }

  let pendingJoinCode = null;
  let pendingInviteGroup = null; // {id, name, ownerUid, memberUids, inviteCode} once looked up

  function onShow(){
    // Called by app.js's showView('groups')
    if(pendingJoinCode){
      const code = pendingJoinCode; pendingJoinCode = null;
      handleJoinDeepLink(code);
      return;
    }
    if(pendingInviteGroup){
      renderInvitePanel();
      return;
    }
    if(activeGroupId){
      renderDetail();
    } else {
      renderRoot();
    }
  }

  // Re-render the currently open group's detail panel (used when returning
  // to the Groups tab without a pending join code, e.g. Home → Groups →
  // back). Listeners already keep the data fresh; this just re-shows the
  // right panel and repaints from state already in memory.
  function renderDetail(){
    document.getElementById('groupsPanelList').style.display = 'none';
    document.getElementById('groupsPanelInvite').style.display = 'none';
    document.getElementById('groupsPanelDetail').style.display = '';
    document.getElementById('groupDetailName').textContent = activeGroup ? activeGroup.name : '—';
    // Listeners are still running from before (we never actually left the
    // group), so data's already loaded — just show it directly rather than
    // flashing the loading skeleton again.
    document.getElementById('groupDetailSkeleton').style.display = groupDetailReady ? 'none' : '';
    document.getElementById('groupDetailBody').style.display = groupDetailReady ? '' : 'none';
    renderMembersRow();
    renderChallengesList();
    renderCalendarChallengeSelector();
    renderGroupCalendar();
  }

  // Looks the group up by its invite code (allowed unauthenticated — see
  // firestore.rules) and shows the invite-landing panel rather than joining
  // immediately, so the person always sees what they're accepting first.
  async function handleJoinDeepLink(code){
    if(!db){ toast('Cloud sync isn\'t configured — groups need it.'); renderRoot(); return; }
    try{
      const q = query(collection(db, 'groups'), where('inviteCode', '==', code.toUpperCase()), limit(1));
      const snap = await getDocs(q);
      if(snap.empty){ toast('That invite link is invalid or expired'); renderRoot(); return; }
      const gDoc = snap.docs[0];
      pendingInviteGroup = {id: gDoc.id, ...gDoc.data()};
      renderInvitePanel();
    }catch(e){
      console.error(e);
      toast('Could not load that invite');
      renderRoot();
    }
  }

  function renderInvitePanel(){
    document.getElementById('groupsPanelList').style.display = 'none';
    document.getElementById('groupsPanelDetail').style.display = 'none';
    document.getElementById('groupsPanelInvite').style.display = '';
    document.getElementById('inviteGroupName').textContent = pendingInviteGroup.name;

    const signInBtn = document.getElementById('btnInviteSignIn');
    const acceptBtn = document.getElementById('btnInviteAccept');
    const statusEl = document.getElementById('inviteStatusText');
    signInBtn.style.display = 'none';
    acceptBtn.style.display = 'none';
    statusEl.style.display = 'none';
    statusEl.textContent = '';

    const memberUids = pendingInviteGroup.memberUids || [];
    const alreadyMember = !!(currentUser && memberUids.includes(currentUser.uid));
    const isFull = memberUids.length >= MAX_MEMBERS;

    if(!currentUser){
      signInBtn.style.display = '';
    } else if(alreadyMember){
      statusEl.textContent = "You're already in that group.";
      statusEl.style.display = '';
      acceptBtn.textContent = 'Open group';
      acceptBtn.style.display = '';
    } else if(isFull){
      statusEl.textContent = 'This group is full (8/8 members).';
      statusEl.style.display = '';
    } else {
      acceptBtn.textContent = 'Accept';
      acceptBtn.style.display = '';
    }
  }

  function clearPendingInvite(){
    pendingInviteGroup = null;
    document.getElementById('groupsPanelInvite').style.display = 'none';
  }

  async function onInviteSignIn(){
    if(!db){ toast('Cloud sync isn\'t configured — groups need it.'); return; }
    try{
      await window.GymSync.signIn();
    }catch(e){ /* handled inside signIn() itself */ }
    // onAuthStateChanged can land a beat after the popup promise resolves —
    // poll briefly rather than assuming it's already landed.
    for(let i=0; i<20 && !currentUser; i++){
      await new Promise(r=>setTimeout(r, 100));
      currentUser = window.GymSync.getCurrentUser();
    }
    if(pendingInviteGroup) renderInvitePanel();
  }

  async function onInviteAccept(){
    if(!pendingInviteGroup || !currentUser) return;
    const memberUids = pendingInviteGroup.memberUids || [];
    if(memberUids.includes(currentUser.uid)){
      const id = pendingInviteGroup.id;
      clearPendingInvite();
      openGroup(id);
      return;
    }
    const ok = await joinGroupById(pendingInviteGroup.id);
    if(ok){
      const id = pendingInviteGroup.id;
      clearPendingInvite();
      toast('Joined group');
      openGroup(id);
    }
  }

  function requireSignedIn(msg){
    if(!db){ toast('Cloud sync isn\'t configured — groups need it.'); return false; }
    if(!currentUser){
      toast(msg || 'Sign in to continue');
      if(window.GymSync) window.GymSync.signIn();
      return false;
    }
    return true;
  }

  /* ---------------- my groups list ---------------- */
  function teardownMyGroupsListener(){
    if(myGroupsUnsub){ myGroupsUnsub(); myGroupsUnsub = null; }
  }

  function listenToMyGroups(){
    const q = query(collection(db, 'groups'), where('memberUids', 'array-contains', currentUser.uid));
    myGroupsUnsub = onSnapshot(q, (snap)=>{
      myGroups = snap.docs.map(d=>({id:d.id, ...d.data()}));
      if(document.getElementById('view-groups').classList.contains('active') && !activeGroupId){
        renderRoot();
      }
      syncHomeChallengeListeners();
    }, (err)=>{ console.error('groups listen failed', err); });
  }

  /* ---------------- home-screen "today" challenge cards ----------------
     Tracked independently of whichever group is open in the Groups tab —
     the home carousel needs every group's active-and-in-range challenge
     plus this user's own "done today" status, live, regardless of which
     screen they're on. Each group gets a cheap challenge listener plus,
     only while it has a live in-range challenge, a single-document listener
     on today's own completion doc (not the whole completions collection). */
  let homeChallengeState = {}; // groupId -> {groupName, challengeUnsub, challenges: {challengeId: {challenge, doneToday, completionUnsub}}}

  function syncHomeChallengeListeners(){
    const currentIds = new Set(myGroups.map(g=>g.id));
    Object.keys(homeChallengeState).forEach(gid=>{
      if(!currentIds.has(gid)){
        teardownHomeChallengeEntry(gid);
        delete homeChallengeState[gid];
      }
    });
    myGroups.forEach(g=>{
      if(!homeChallengeState[g.id]){
        homeChallengeState[g.id] = {groupName:g.name, challengeUnsub:null, challenges:{}};
        attachHomeChallengeListener(g.id);
      } else {
        homeChallengeState[g.id].groupName = g.name;
      }
    });
    notifyHomeRefresh();
  }

  function teardownHomeChallengeEntry(groupId){
    const entry = homeChallengeState[groupId];
    if(!entry) return;
    if(entry.challengeUnsub) entry.challengeUnsub();
    Object.values(entry.challenges).forEach(c=>{ if(c.completionUnsub) c.completionUnsub(); });
  }

  // Tracks every active, in-range challenge for a group (not just one) —
  // each gets its own single-document listener on today's completion doc
  // (cheap: one doc, not the whole collection, since Home only needs
  // "done today", unlike the group-detail cards which also need period
  // totals for weekly/monthly challenges).
  function attachHomeChallengeListener(groupId){
    const q = query(collection(db, 'groups', groupId, 'challenges'), where('active','==',true));
    const unsub = onSnapshot(q, (snap)=>{
      const entry = homeChallengeState[groupId];
      if(!entry) return; // group was left/torn down mid-flight

      const today = todayISO();
      const newChallenges = snap.docs
        .map(d=>({id:d.id, ...d.data()}))
        .filter(ch=>today >= ch.startDate && today <= ch.endDate);
      const newIds = new Set(newChallenges.map(c=>c.id));

      // Drop tracking (and its completion listener) for anything no longer
      // active/in-range.
      Object.keys(entry.challenges).forEach(cid=>{
        if(!newIds.has(cid)){
          if(entry.challenges[cid].completionUnsub) entry.challenges[cid].completionUnsub();
          delete entry.challenges[cid];
        }
      });

      newChallenges.forEach(ch=>{
        if(entry.challenges[ch.id]){
          entry.challenges[ch.id].challenge = ch; // refresh in case title/target edited later
          return;
        }
        const compRef = doc(db, 'groups', groupId, 'challenges', ch.id, 'completions', `${today}_${currentUser.uid}`);
        entry.challenges[ch.id] = {
          challenge: ch, doneToday: false,
          completionUnsub: onSnapshot(compRef, (compSnap)=>{
            if(!entry.challenges[ch.id]) return;
            entry.challenges[ch.id].doneToday = compSnap.exists();
            notifyHomeRefresh();
          }, (err)=>console.error('home completion listen failed', err))
        };
      });

      notifyHomeRefresh();
    }, (err)=>console.error('home challenge listen failed', err));
    homeChallengeState[groupId].challengeUnsub = unsub;
  }

  function teardownAllHomeChallengeListeners(){
    Object.keys(homeChallengeState).forEach(teardownHomeChallengeEntry);
    homeChallengeState = {};
  }

  function notifyHomeRefresh(){
    if(window.GymUI && window.GymUI.refreshHomeChallengesIfVisible) window.GymUI.refreshHomeChallengesIfVisible();
  }

  // Called by app.js's home-screen carousel to get this user's active,
  // in-range group challenges — now one card per (group, challenge) pair,
  // since a group can have several running at once. Pure data — app.js owns
  // the actual markup so group cards render identically to routine cards.
  function getHomeChallengeCards(){
    const cards = [];
    Object.entries(homeChallengeState).forEach(([groupId,e])=>{
      Object.values(e.challenges).forEach(c=>{
        cards.push({
          groupId,
          groupName: e.groupName,
          challengeId: c.challenge.id,
          title: c.challenge.title,
          targetLabel: c.challenge.targetLabel,
          doneToday: !!c.doneToday
        });
      });
    });
    return cards;
  }

  // Called when a home-screen group-challenge card is tapped — switches to
  // the Groups tab and opens that specific group.
  function openGroupFromHome(groupId){
    if(window.GymUI && window.GymUI.showView) window.GymUI.showView('groups');
    openGroup(groupId);
  }

  function renderRoot(){
    document.getElementById('groupsPanelDetail').style.display = 'none';
    document.getElementById('groupsPanelInvite').style.display = 'none';
    document.getElementById('groupsPanelList').style.display = '';

    const container = document.getElementById('groupsListContainer');
    if(!db){
      container.innerHTML = `<div class="empty-state">
        <p>Group challenges need cloud sync configured for this app.</p>
      </div>`;
      return;
    }
    if(!currentUser){
      container.innerHTML = `<div class="empty-state">
        <p>Sign in to create or join a group challenge with friends.</p>
      </div>`;
      return;
    }
    if(myGroups.length===0){
      container.innerHTML = `<div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><circle cx="17" cy="7" r="3"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>
        <p>No groups yet. Create one or join with an invite link.</p>
      </div>`;
      return;
    }
    container.innerHTML = myGroups.map(g=>{
      const count = (g.memberUids||[]).length;
      return `<div class="card group-list-item" data-group="${g.id}" style="cursor:pointer; margin-bottom:10px;">
        <div class="row">
          <div style="min-width:0;">
            <div class="settings-row-label">${escapeHtml(g.name)}</div>
            <div class="settings-row-sub">${count}/${MAX_MEMBERS} members</div>
          </div>
        </div>
      </div>`;
    }).join('');
    container.querySelectorAll('[data-group]').forEach(el=>{
      el.addEventListener('click', ()=>openGroup(el.dataset.group));
    });
  }

  // Keeps the "Also share location" control in sync with "Require photo" —
  // it can only ever be enabled when photo is both required AND turned on,
  // since location is sent alongside the photo rather than on its own.
  function updateLocationToggleAvailability(){
    const locToggle = document.getElementById('challengeRequireLocationToggle');
    const locNote = document.getElementById('challengeRequireLocationNote');
    locToggle.disabled = !requirePhotoOn;
    locNote.textContent = requirePhotoOn
      ? 'Also attaches an approximate Google Maps link to the Telegram message when a member checks in. Denying the location prompt still lets them send the photo alone.'
      : 'Turn on "Require photo" first — location is shared alongside the photo, never on its own.';
  }

  function bindStaticUI(){
    document.getElementById('btnNewGroup').addEventListener('click', ()=>{
      if(!requireSignedIn()) return;
      document.getElementById('newGroupNameInput').value = '';
      ui().openSheet('sheetCreateGroup');
    });
    document.getElementById('btnConfirmCreateGroup').addEventListener('click', createGroup);

    document.getElementById('btnJoinGroup').addEventListener('click', ()=>{
      if(!requireSignedIn()) return;
      document.getElementById('joinGroupCodeInput').value = '';
      ui().openSheet('sheetJoinGroup');
    });
    document.getElementById('btnConfirmJoinGroup').addEventListener('click', ()=>{
      const code = document.getElementById('joinGroupCodeInput').value.trim();
      if(!code){ toast('Enter an invite code'); return; }
      joinByCode(code);
    });

    document.getElementById('btnBackToGroups').addEventListener('click', closeGroup);
    document.getElementById('btnInviteMembers').addEventListener('click', showInviteSheet);
    document.getElementById('btnOpenTelegramGroup').addEventListener('click', ()=>{
      if(activeGroup && activeGroup.telegramGroupLink){
        window.open(activeGroup.telegramGroupLink, '_blank', 'noopener');
      }
    });
    document.getElementById('btnNtfySettings').addEventListener('click', showNtfySettingsSheet);
    document.getElementById('btnLeaveGroup').addEventListener('click', leaveActiveGroup);

    document.getElementById('btnInviteSignIn').addEventListener('click', onInviteSignIn);
    document.getElementById('btnInviteAccept').addEventListener('click', onInviteAccept);
    document.getElementById('btnInviteCancel').addEventListener('click', ()=>{
      clearPendingInvite();
      renderRoot();
    });

    document.getElementById('btnNewChallenge').addEventListener('click', ()=>{
      document.getElementById('challengeTitleInput').value = '';
      document.getElementById('challengeTargetInput').value = '';
      document.getElementById('challengeFreqCountInput').value = 3;
      selectedChallengeFreq = 'daily';
      document.querySelectorAll('.challenge-freq-chip').forEach(c=>c.classList.toggle('selected', c.dataset.freq==='daily'));
      document.getElementById('challengeFreqCountField').style.display = 'none';
      const t = new Date();
      document.getElementById('challengeStartInput').value = fmtISO(t);
      const end = new Date(t); end.setDate(end.getDate()+29);
      document.getElementById('challengeEndInput').value = fmtISO(end);

      // "Require photo" only makes sense — and is only enabled — once the
      // group actually has somewhere to send photos to. The control stays
      // visible either way (just disabled), with the note underneath
      // explaining why, rather than disappearing entirely — a vanished
      // control with no visible explanation just looks like a bug.
      const telegramReady = !!(activeGroup && activeGroup.telegramWorkerUrl);
      requirePhotoOn = false;
      requireLocationOn = false;
      const photoToggle = document.getElementById('challengeRequirePhotoToggle');
      const photoState = document.getElementById('challengeRequirePhotoState');
      photoState.classList.remove('on');
      photoState.textContent = 'Off';
      photoToggle.disabled = !telegramReady;
      document.getElementById('challengeRequirePhotoNote').textContent = telegramReady
        ? "Members capture a live camera photo (no gallery uploads) each time they mark this challenge done — it's sent to your Telegram group along with the usual nudge."
        : 'Set up Telegram integration in Moderation first — this needs somewhere to send the photos.';
      updateLocationToggleAvailability();

      ui().openSheet('sheetNewChallenge');
    });
    document.getElementById('challengeRequirePhotoToggle').addEventListener('click', (e)=>{
      if(e.currentTarget.disabled) return;
      requirePhotoOn = !requirePhotoOn;
      const stateEl = document.getElementById('challengeRequirePhotoState');
      stateEl.classList.toggle('on', requirePhotoOn);
      stateEl.textContent = requirePhotoOn ? 'On' : 'Off';
      // Location only ever makes sense alongside a required photo — if
      // photo just got turned off, location can't stay on either.
      if(!requirePhotoOn && requireLocationOn){
        requireLocationOn = false;
        const locState = document.getElementById('challengeRequireLocationState');
        locState.classList.remove('on');
        locState.textContent = 'Off';
      }
      updateLocationToggleAvailability();
    });
    document.getElementById('challengeRequireLocationToggle').addEventListener('click', (e)=>{
      if(e.currentTarget.disabled) return;
      requireLocationOn = !requireLocationOn;
      const stateEl = document.getElementById('challengeRequireLocationState');
      stateEl.classList.toggle('on', requireLocationOn);
      stateEl.textContent = requireLocationOn ? 'On' : 'Off';
    });
    document.getElementById('btnConfirmNewChallenge').addEventListener('click', createChallenge);

    document.getElementById('btnCameraClose').addEventListener('click', closeCameraCapture);
    document.getElementById('btnCameraFlip').addEventListener('click', flipCameraFacing);
    document.getElementById('btnCameraMirror').addEventListener('click', toggleCameraMirror);
    document.getElementById('btnCameraZoomOut').addEventListener('click', ()=>applyZoom(currentZoom - zoomStepSize()));
    document.getElementById('btnCameraZoomIn').addEventListener('click', ()=>applyZoom(currentZoom + zoomStepSize()));
    document.getElementById('btnCameraShutter').addEventListener('click', captureCameraFrame);
    document.getElementById('btnCameraRetake').addEventListener('click', retakeCameraPhoto);
    document.getElementById('btnCameraConfirm').addEventListener('click', confirmCameraPhoto);
    document.querySelectorAll('.challenge-freq-chip').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        selectedChallengeFreq = chip.dataset.freq;
        document.querySelectorAll('.challenge-freq-chip').forEach(c=>c.classList.toggle('selected', c===chip));
        const countField = document.getElementById('challengeFreqCountField');
        const countLabel = document.getElementById('challengeFreqCountLabel');
        const countInput = document.getElementById('challengeFreqCountInput');
        if(selectedChallengeFreq==='daily'){
          countField.style.display = 'none';
        } else {
          countField.style.display = '';
          countLabel.textContent = selectedChallengeFreq==='weekly' ? 'Times per week' : 'Times per month';
          // A week can only ever contain 7 days — one completion per day is
          // the hard cap set elsewhere in the app — so any weekly target
          // above 7 would be mathematically impossible to ever complete.
          // Monthly gets a generous but still finite ceiling.
          const cap = selectedChallengeFreq==='weekly' ? 7 : 31;
          countInput.max = String(cap);
          if(+countInput.value > cap) countInput.value = cap;
        }
      });
    });
    document.getElementById('challengeFreqCountInput').addEventListener('change', (e)=>{
      const cap = +e.target.max || 31;
      const val = Math.min(cap, Math.max(1, +e.target.value || 1));
      e.target.value = val;
    });

    document.getElementById('btnChallengeHistory').addEventListener('click', showChallengeHistorySheet);
    document.getElementById('btnActivityFeed').addEventListener('click', showActivityFeedSheet);
    document.getElementById('btnLeaderboard').addEventListener('click', showLeaderboardSheet);
    document.getElementById('btnGroupMenu').addEventListener('click', ()=>toggleGroupMenu(true));
    document.getElementById('groupMenuBackdrop').addEventListener('click', ()=>toggleGroupMenu(false));
    // Any actual menu item (not just the backdrop) should also close the
    // dropdown after firing its own action — the specific click handlers
    // for each item (History, Moderation, etc.) are wired separately below;
    // this is purely about closing the menu, via event delegation so it
    // doesn't matter which item was tapped.
    document.getElementById('groupMenuDropdown').addEventListener('click', (e)=>{
      if(e.target.closest('.group-menu-item')) toggleGroupMenu(false);
    });
    document.getElementById('btnModeration').addEventListener('click', showModerationSheet);
    document.getElementById('btnModSaveName').addEventListener('click', saveGroupRename);
    document.getElementById('btnModRegenerateInvite').addEventListener('click', regenerateInviteCode);
    document.getElementById('btnModSaveTelegram').addEventListener('click', saveTelegramSettings);
    document.getElementById('btnModTestTelegram').addEventListener('click', testTelegramMessage);
    document.getElementById('btnModDeleteGroup').addEventListener('click', deleteGroupEntirely);

    document.getElementById('calGroupPrevMonth').addEventListener('click', ()=>{
      calCursor.setMonth(calCursor.getMonth()-1); renderGroupCalendar();
    });
    document.getElementById('calGroupNextMonth').addEventListener('click', ()=>{
      calCursor.setMonth(calCursor.getMonth()+1); renderGroupCalendar();
    });
  }

  /* ---------------- create / join ---------------- */
  function randomCode(len=6){
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    let out = '';
    for(let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
    return out;
  }

  // Deterministic-prefix, random-suffix ntfy topic, generated once per group
  // at creation and never editable afterward — e.g.
  // "gymnullvaulteu-morning-crew-a1b2c3". The prefix identifies it as
  // belonging to this app (so it doesn't collide with unrelated public
  // topics on ntfy.sh), the slug keeps it human-recognizable, and the
  // random suffix keeps it unguessable enough to act as ntfy's de facto
  // access gate (ntfy topics have no real auth by default).
  function slugify(s){
    return String(s||'')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'group';
  }
  function randomNtfyTopic(groupName){
    const suffix = Array.from({length:8}, ()=>'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random()*36)]).join('');
    return `gymnullvaulteu-${slugify(groupName)}-${suffix}`;
  }

  async function createGroup(){
    const name = document.getElementById('newGroupNameInput').value.trim();
    if(!name){ toast('Give the group a name'); return; }
    if(!requireSignedIn()) return;
    try{
      const inviteCode = randomCode();
      const groupRef = await addDoc(collection(db, 'groups'), {
        name,
        ownerUid: currentUser.uid,
        ownerName: currentUser.name || 'Owner',
        inviteCode,
        ntfyTopic: randomNtfyTopic(name),
        createdAt: Date.now(),
        memberUids: [currentUser.uid]
      });
      await setDoc(doc(db, 'groups', groupRef.id, 'members', currentUser.uid), {
        uid: currentUser.uid,
        displayName: currentUser.name || 'Member',
        photoURL: currentUser.photo || '',
        color: PALETTE[0],
        colorIndex: 0,
        joinedAt: Date.now()
      });
      ui().closeSheet('sheetCreateGroup');
      toast('Group created');
      openGroup(groupRef.id);
    }catch(e){
      console.error(e);
      toast('Could not create group: ' + (e.message||e.code||''));
    }
  }

  async function joinByCode(code){
    if(!requireSignedIn()) return;
    try{
      const q = query(collection(db, 'groups'), where('inviteCode', '==', code.toUpperCase()), limit(1));
      const snap = await getDocs(q);
      if(snap.empty){ toast('No group found with that code'); return; }
      const groupId = snap.docs[0].id;

      const memberRef = doc(db, 'groups', groupId, 'members', currentUser.uid);
      const existing = await getDoc(memberRef);
      if(existing.exists()){
        ui().closeSheet('sheetJoinGroup');
        openGroup(groupId);
        return;
      }

      const ok = await joinGroupById(groupId);
      if(ok){
        ui().closeSheet('sheetJoinGroup');
        toast('Joined group');
        openGroup(groupId);
      }
    }catch(e){
      console.error(e);
      toast(e.message || 'Could not join group');
    }
  }

  // Shared join transaction, used both by the code-entry sheet and the
  // invite-landing page's Accept button. Atomically checks capacity and
  // claims the next free color, so two people accepting at the same moment
  // can't both grab the same color or push the group past MAX_MEMBERS.
  // Returns true on success, false (after toasting) on failure.
  async function joinGroupById(groupId){
    let joined = false, groupName = null, groupTopic = null, myColor = null;
    try{
      await runTransaction(db, async (tx)=>{
        const gRef = doc(db, 'groups', groupId);
        const gSnap = await tx.get(gRef);
        if(!gSnap.exists()) throw new Error('Group no longer exists');
        const data = gSnap.data();
        groupName = data.name;
        groupTopic = data.ntfyTopic;
        const memberUids = data.memberUids || [];
        if(memberUids.includes(currentUser.uid)) return; // already a member
        if(memberUids.length >= MAX_MEMBERS) throw new Error('This group is full (8/8 members)');

        // We can't read the whole members subcollection inside a transaction
        // against an arbitrary-length list cheaply, so colorIndex is derived
        // from position in memberUids, which we already have transactionally.
        const colorIndex = memberUids.length % PALETTE.length;
        myColor = PALETTE[colorIndex];

        tx.update(gRef, { memberUids: [...memberUids, currentUser.uid] });
        tx.set(doc(db, 'groups', groupId, 'members', currentUser.uid), {
          uid: currentUser.uid,
          displayName: currentUser.name || 'Member',
          photoURL: currentUser.photo || '',
          color: myColor,
          colorIndex,
          joinedAt: Date.now()
        });
        joined = true;
      });
      if(joined){
        logGroupEvent(groupId, 'joined the group', myColor);
        if(groupTopic){
          publishNtfy(groupTopic, {
            title: groupName,
            message: `${firstName(currentUser.name)} joined the group`,
            tags: ['wave']
          });
        }
      }
      return true;
    }catch(e){
      console.error(e);
      toast(e.message || 'Could not join group');
      return false;
    }
  }

  async function leaveActiveGroup(){
    if(!activeGroupId || !currentUser) return;
    const amOwner = activeGroup && activeGroup.ownerUid === currentUser.uid;
    // Best-guess successor for the confirm-dialog copy only — whoever's
    // been in the group longest, besides me. Recomputed against fresh data
    // at write time below, so a stale guess here can't cause a bad write.
    const guessedSuccessor = amOwner
      ? activeMembers.filter(m=>m.uid!==currentUser.uid).sort((a,b)=>(a.joinedAt||0)-(b.joinedAt||0))[0]
      : null;

    const message = !amOwner
      ? 'You\'ll stop seeing this group\'s challenge and calendar.'
      : guessedSuccessor
        ? `You're the owner — ${firstName(guessedSuccessor.displayName)} will become the new owner when you leave.`
        : 'You\'re the only member — leaving will leave this group with no members.';

    const ok = ui().confirmDialog ? await ui().confirmDialog({
      title:'Leave group?', message, confirmLabel:'Leave', danger:true
    }) : confirm('Leave this group?');
    if(!ok) return;

    try{
      const gRef = doc(db, 'groups', activeGroupId);
      const gSnap = await getDoc(gRef);
      let newOwnerMember = null;
      let groupDeleted = false;

      if(gSnap.exists()){
        const data = gSnap.data();
        const remainingUids = (data.memberUids||[]).filter(u=>u!==currentUser.uid);
        const iAmOwner = data.ownerUid===currentUser.uid;

        if(iAmOwner && remainingUids.length===0){
          // Last member leaving — nobody left to hand off to, and nobody
          // left to ever see this group again, so remove it entirely
          // rather than leaving an empty, permanently-orphaned husk.
          await cascadeDeleteGroupData(activeGroupId);
          groupDeleted = true;
        } else {
          const updatePayload = { memberUids: remainingUids };
          // Only the group's actual current owner (per fresh server data,
          // not our possibly-stale local copy) triggers a hand-off, and
          // only to someone still genuinely in remainingUids — so the
          // group is never left ownerless even if things changed since
          // the dialog opened.
          if(iAmOwner && remainingUids.length>0){
            const candidates = activeMembers.filter(m=>remainingUids.includes(m.uid))
              .sort((a,b)=>(a.joinedAt||0)-(b.joinedAt||0));
            const newOwnerUid = candidates.length ? candidates[0].uid : remainingUids[0];
            updatePayload.ownerUid = newOwnerUid;
            newOwnerMember = candidates.find(m=>m.uid===newOwnerUid) || null;
          }
          await updateDoc(gRef, updatePayload);
          // Log while we're still a recognized member — the activity log's
          // write rule requires that — then remove our own membership doc.
          await logGroupEvent(activeGroupId, newOwnerMember
            ? `left the group — ownership passed to ${newOwnerMember.displayName}`
            : 'left the group');
          await deleteDoc(doc(db, 'groups', activeGroupId, 'members', currentUser.uid));
        }
      }
      if(!groupDeleted && activeGroup && activeGroup.ntfyTopic){
        publishNtfy(activeGroup.ntfyTopic, {
          title: activeGroup.name,
          message: newOwnerMember
            ? `${firstName(currentUser.name)} left the group — ${firstName(newOwnerMember.displayName)} is now the owner`
            : `${firstName(currentUser.name)} left the group`,
          tags: ['wave']
        });
      }
      toast(groupDeleted
        ? 'Left group — it had no other members, so it was deleted'
        : (newOwnerMember ? `Left group — ownership passed to ${firstName(newOwnerMember.displayName)}` : 'Left group'));
      closeGroup();
    }catch(e){
      console.error(e);
      toast('Could not leave group');
    }
  }

  /* ---------------- invite sheet (link + QR) ---------------- */
  function showInviteSheet(){
    if(!activeGroup) return;
    const link = `${location.origin}${location.pathname}#join=${activeGroup.inviteCode}`;
    document.getElementById('inviteLinkText').textContent = link;
    document.getElementById('inviteCodeText').textContent = activeGroup.inviteCode;
    ui().openSheet('sheetInvite');
    renderQr(link);

    document.getElementById('btnCopyInviteLink').onclick = async ()=>{
      try{ await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch(e){ toast('Could not copy — long-press to copy manually'); }
    };
    document.getElementById('btnShareInviteLink').onclick = async ()=>{
      if(navigator.share){
        try{ await navigator.share({title:`Join ${activeGroup.name}`, url:link}); }
        catch(e){ /* user cancelled share sheet — no action needed */ }
      } else {
        try{ await navigator.clipboard.writeText(link); toast('Link copied'); }
        catch(e){ toast(link); }
      }
    };
  }

  function renderQr(text, elId='inviteQrCanvas'){
    const el = document.getElementById(elId);
    if(!el) return;
    el.innerHTML = '';
    if(window.QRCode){
      new window.QRCode(el, { text, width:180, height:180, colorDark:'#0a0e0f', colorLight:'#d7e5e2' });
    } else {
      el.innerHTML = '<p class="text-sm text-muted">QR code unavailable offline — share the link instead.</p>';
    }
  }

  /* ---------------- ntfy.sh push notifications ----------------
     Fully client-side, no backend of ours needed. Each group gets one
     fixed topic, generated once at creation time (see randomNtfyTopic())
     and stored on the group doc — not owner-editable, no server/token
     fields. Whichever member checks in POSTs a message straight to
     https://ntfy.sh/<topic>; anyone subscribed (via the ntfy app, or just
     ntfy.sh in a browser with background notifications enabled — no app
     install required either way) gets a real push, even with this app
     fully closed. That's the one thing the in-app Firestore-listener
     notifications above can't do. */
  function ntfySubscribeLink(topic){
    return `https://ntfy.sh/${encodeURIComponent(topic)}`;
  }

  async function publishNtfy(topic, {title, message, tags, priority=4}){
    if(!topic) return;
    try{
      await fetch('https://ntfy.sh/', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ topic, title, message, tags: tags||[], priority })
      });
    }catch(e){
      // Never block/interrupt the check-in flow over a notification
      // delivery failure — the completion itself already saved.
      console.error('ntfy publish failed', e);
    }
  }

  function showNtfySettingsSheet(){
    if(!activeGroup) return;
    ui().openSheet('sheetNtfySettings');
    renderNtfySettingsSheet();
  }

  function renderNtfySettingsSheet(){
    const isOwner = currentUser && activeGroup && activeGroup.ownerUid === currentUser.uid;
    const content = document.getElementById('ntfySettingsContent');
    const topic = activeGroup ? activeGroup.ntfyTopic : null;
    const link = topic ? ntfySubscribeLink(topic) : null;
    // The ntfy Android app registers the ntfy:// scheme and, per ntfy's own
    // docs, ntfy://<host>/<topic> opens straight to that topic's detail
    // view and subscribes automatically if not already subscribed — no
    // typing the topic name in by hand. Shown unconditionally rather than
    // gated on a user-agent sniff — that check is unreliable inside a TWA
    // wrapper anyway. Elsewhere it just won't resolve to anything, same as
    // tapping any link for an app that isn't installed.
    const androidAppLink = topic ? `ntfy://ntfy.sh/${encodeURIComponent(topic)}?display=${encodeURIComponent(activeGroup.name)}` : null;

    if(!topic){
      // Every group created going forward gets a topic automatically; this
      // only shows for groups created before this feature existed.
      content.innerHTML = `<p class="text-sm text-muted">Push notifications aren't available for this group — it was created before this feature existed.</p>`;
      return;
    }

    content.innerHTML = `
      <p class="text-sm text-muted mb-16">Get a real push notification — even with this app closed — whenever a teammate completes today's challenge. No app install required: open this group's ntfy page and tap <b>Subscribe</b>, then enable <b>background notifications</b> right there in the browser. (The <a href="https://ntfy.sh" target="_blank" rel="noopener" style="color:var(--accent);">ntfy app</a> works too, if you'd rather use it.)</p>
      <div class="invite-qr-wrap"><div id="ntfySubscribeQr"></div></div>
      <div class="invite-link-box">${escapeHtml(link)}</div>
      <button class="btn btn-primary btn-block mb-8" id="btnOpenNtfyAndroidApp">Open in ntfy Android app</button>
      <button class="btn btn-secondary btn-block mb-8" id="btnOpenNtfyLink">Open ntfy.sh in a new tab</button>
      <button class="btn btn-secondary btn-block" id="btnCopyNtfyLink">Copy link</button>
      ${isOwner ? `<button class="btn btn-secondary btn-block mt-8" id="btnTestNtfyConfig">Send test notification</button>` : ''}
    `;
    renderQr(link, 'ntfySubscribeQr');
    document.getElementById('btnOpenNtfyAndroidApp').addEventListener('click', ()=>{
      // A bare location change (not window.open) is what actually lets
      // Android's intent-resolution kick in for a custom scheme like this.
      window.location.href = androidAppLink;
    });
    document.getElementById('btnOpenNtfyLink').addEventListener('click', ()=>{
      window.open(link, '_blank', 'noopener');
    });
    document.getElementById('btnCopyNtfyLink').addEventListener('click', async ()=>{
      try{ await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch(e){ toast('Could not copy — long-press to copy manually'); }
    });
    if(isOwner){
      document.getElementById('btnTestNtfyConfig').addEventListener('click', async ()=>{
        await publishNtfy(topic, {
          title: activeGroup.name,
          message: 'Test notification from Gym Tracker 👋',
          tags: ['bell']
        });
        toast('Test sent');
      });
    }
  }

  /* ---------------- group detail ---------------- */
  // Anchors the overflow-menu dropdown just under the burger button,
  // computed fresh each open so it stays correctly placed regardless of
  // scroll position or viewport size.
  function toggleGroupMenu(show){
    const dropdown = document.getElementById('groupMenuDropdown');
    const backdrop = document.getElementById('groupMenuBackdrop');
    if(show){
      const btn = document.getElementById('btnGroupMenu');
      const rect = btn.getBoundingClientRect();
      dropdown.style.top = (rect.bottom + 8) + 'px';
      dropdown.style.right = (window.innerWidth - rect.right) + 'px';
      backdrop.classList.add('open');
      dropdown.classList.add('open');
    } else {
      backdrop.classList.remove('open');
      dropdown.classList.remove('open');
    }
  }


  async function openGroup(groupId){
    activeGroupId = groupId;
    calCursor = new Date();
    document.getElementById('groupsPanelList').style.display = 'none';
    document.getElementById('groupsPanelInvite').style.display = 'none';
    document.getElementById('groupsPanelDetail').style.display = '';
    document.getElementById('groupDetailName').textContent = 'Loading…';
    document.getElementById('groupMembersRow').innerHTML = '';
    document.getElementById('groupChallengesList').innerHTML = '';
    document.getElementById('calGroupGrid').innerHTML = '';

    // Show one clean loading state instead of the real content sections —
    // those get built up in the background as listeners land, then
    // revealed all at once by maybeRevealGroupDetail() below.
    groupDetailReady = false;
    membersLoadedOnce = false;
    challengesLoadedOnce = false;
    document.getElementById('groupDetailSkeleton').style.display = '';
    document.getElementById('groupDetailBody').style.display = 'none';

    const gSnap = await getDoc(doc(db, 'groups', groupId));
    if(!gSnap.exists()){ toast('Group not found'); closeGroup(); return; }
    activeGroup = {id:groupId, ...gSnap.data()};
    document.getElementById('groupDetailName').textContent = activeGroup.name;
    document.getElementById('btnModeration').style.display =
      (currentUser && activeGroup.ownerUid===currentUser.uid) ? '' : 'none';
    document.getElementById('btnOpenTelegramGroup').style.display =
      activeGroup.telegramGroupLink ? '' : 'none';

    teardownDetailListeners();

    membersUnsub = onSnapshot(collection(db, 'groups', groupId, 'members'), (snap)=>{
      activeMembers = snap.docs.map(d=>d.data()).sort((a,b)=>a.colorIndex-b.colorIndex);
      membersLoadedOnce = true;
      renderMembersRow();
      renderGroupCalendar(); // legend depends on members
      renderActivityBadge();
      healOwnMemberDoc();
      maybeRevealGroupDetail();
    });

    listenToActiveChallenges();

    // Live "transparency log" — rename, join/leave, kick, ownership
    // changes, challenge start/end. Single-field orderBy+limit needs no
    // composite index. Kept separate from activityFeedItems (completions)
    // since only completions ever get the emoji-reaction row. Not part of
    // the initial-reveal gate below — it only feeds the separate Activity
    // sheet, not anything visible on the group screen itself.
    activityLogUnsub = onSnapshot(
      query(collection(db, 'groups', groupId, 'activityLog'), orderBy('at', 'desc'), limit(50)),
      (snap)=>{
        activityLogItems = snap.docs.map(d=>({id:d.id, ...d.data()}));
        renderActivityFeedList();
      },
      (err)=>console.error('activity log listen failed', err)
    );
  }

  // Reveals the real group-screen content in one step, once members, the
  // active-challenge list, AND every one of those challenges' completions
  // have each landed their first snapshot — see groupDetailReady above.
  function maybeRevealGroupDetail(){
    if(groupDetailReady) return;
    if(!membersLoadedOnce || !challengesLoadedOnce) return;
    const allCompletionsLoaded = activeChallenges.every(ch=>
      challengeCompletions[ch.id] && challengeCompletions[ch.id].loadedOnce
    );
    if(!allCompletionsLoaded) return;

    groupDetailReady = true;
    document.getElementById('groupDetailSkeleton').style.display = 'none';
    document.getElementById('groupDetailBody').style.display = '';
  }

  function teardownDetailListeners(){
    if(membersUnsub){ membersUnsub(); membersUnsub = null; }
    if(challengeUnsub){ challengeUnsub(); challengeUnsub = null; }
    if(activityLogUnsub){ activityLogUnsub(); activityLogUnsub = null; }
    Object.values(challengeCompletions).forEach(entry=>{ if(entry.unsub) entry.unsub(); });
    challengeCompletions = {};
  }

  function closeGroup(){
    teardownDetailListeners();
    closeCameraCapture(); // safety net — stops any live camera stream if this fires mid-capture
    activeGroupId = null; activeGroup = null; activeMembers = []; activeChallenges = [];
    selectedCalendarChallengeId = null;
    activityFeedItems = [];
    activityLogItems = [];
    groupDetailReady = false;
    membersLoadedOnce = false;
    challengesLoadedOnce = false;
    renderRoot();
  }

  function renderMembersRow(){
    const row = document.getElementById('groupMembersRow');
    const leaderUids = computeActiveLeaderUids();
    row.innerHTML = activeMembers.map(m=>`
      <div class="group-member-chip" title="${escapeHtml(m.displayName)}">
        <span class="group-color-dot" style="background:${m.color}"></span>
        ${escapeHtml(firstName(m.displayName))}${badgesForMember(m.uid, leaderUids)}
      </div>
    `).join('') + (activeGroup && currentUser && activeGroup.ownerUid===currentUser.uid ? `<div class="group-member-chip group-member-chip-muted">${activeMembers.length}/${MAX_MEMBERS}</div>` : '');
    const leaveBtn = document.getElementById('btnLeaveGroup');
    leaveBtn.style.display = activeMembers.length ? '' : 'none';
  }

  function isOwnerUid(uid){
    return !!(activeGroup && activeGroup.ownerUid === uid);
  }

  // Owner gets 📋, the leader (most challenges completed) gets 👑 — both can
  // land on the same person. "Leader" here is computed from currently-active
  // challenges only (already-live data, no extra reads); see
  // computeActiveLeaderUids() and the Leaderboard sheet's own all-time tally
  // for the fuller picture.
  function badgesForMember(uid, leaderUids){
    const owner = isOwnerUid(uid) ? ' <span class="group-crown" title="Group owner">📋</span>' : '';
    const leader = leaderUids.has(uid) ? ' <span class="group-crown" title="Leader — most challenges completed">👑</span>' : '';
    return owner + leader;
  }

  // Ties count as co-leaders (all shown) rather than arbitrarily picking one.
  // Empty set if nobody's completed anything in an active challenge yet.
  function computeActiveLeaderUids(){
    const counts = {};
    activeChallenges.forEach(ch=>{
      const entry = challengeCompletions[ch.id];
      if(!entry) return;
      Object.values(entry.byDate).flat().forEach(c=>{
        counts[c.uid] = (counts[c.uid]||0)+1;
      });
    });
    const max = Math.max(0, ...Object.values(counts));
    if(max===0) return new Set();
    return new Set(Object.keys(counts).filter(uid=>counts[uid]===max));
  }

  function firstName(name){ return (name||'Member').split(' ')[0]; }

  // Repairs this user's own member doc if the name/photo it holds is stale
  // (e.g. saved before the auth-name bug fix, or the person renamed their
  // Google account since joining). Only ever touches the caller's own doc —
  // matches the Firestore rule that a member can update only themselves.
  async function healOwnMemberDoc(){
    if(!currentUser || !activeGroupId) return;
    const mine = activeMembers.find(m=>m.uid===currentUser.uid);
    if(!mine) return;
    const wantName = currentUser.name || 'Member';
    const wantPhoto = currentUser.photo || '';
    if(mine.displayName === wantName && (mine.photoURL||'') === wantPhoto) return;
    try{
      await updateDoc(doc(db, 'groups', activeGroupId, 'members', currentUser.uid), {
        displayName: wantName, photoURL: wantPhoto
      });
    }catch(e){ console.error('member doc heal failed', e); }
  }

  function listenToActiveChallenges(){
    const q = query(collection(db, 'groups', activeGroupId, 'challenges'), where('active', '==', true));
    challengeUnsub = onSnapshot(q, (snap)=>{
      const newList = snap.docs.map(d=>({id:d.id, ...d.data()})).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
      const newIds = new Set(newList.map(c=>c.id));

      // Tear down completions listeners for challenges that dropped out of
      // the active set (owner ended them) so we don't leak listeners.
      Object.keys(challengeCompletions).forEach(cid=>{
        if(!newIds.has(cid)){
          if(challengeCompletions[cid].unsub) challengeCompletions[cid].unsub();
          delete challengeCompletions[cid];
        }
      });

      activeChallenges = newList;
      newList.forEach(ch=>{
        if(!challengeCompletions[ch.id]) attachChallengeCompletionsListener(ch.id);
      });

      // Keep the calendar's selected challenge pointing at something real —
      // default to the newest active challenge the first time, or if the
      // one that was selected just got ended.
      if(!selectedCalendarChallengeId || !newIds.has(selectedCalendarChallengeId)){
        selectedCalendarChallengeId = newList.length ? newList[0].id : null;
      }

      renderChallengesList();
      renderCalendarChallengeSelector();
      renderGroupCalendar();
      newList.forEach(ch=>{
        if(challengeCompletions[ch.id] && challengeCompletions[ch.id].loadedOnce) checkAndProcessEliminations(ch);
      });
      challengesLoadedOnce = true;
      maybeRevealGroupDetail();
    }, (err)=>console.error('challenges listen failed', err));
  }

  // One live listener per active challenge, on its full completions
  // collection (not just "today") — needed to compute weekly/monthly
  // period progress (e.g. "2/3 this week"), not just a single day's status.
  // Collections here are small (one group, a handful of members, one
  // challenge's lifetime) so this is cheap even listened to in full.
  function attachChallengeCompletionsListener(challengeId){
    challengeCompletions[challengeId] = {byDate:{}, seenKeys:new Set(), notified:false, unsub:null, loadedOnce:false};
    const ref = collection(db, 'groups', activeGroupId, 'challenges', challengeId, 'completions');
    challengeCompletions[challengeId].unsub = onSnapshot(ref, (snap)=>{
      const entry = challengeCompletions[challengeId];
      if(!entry) return; // challenge was ended/torn down mid-flight

      const byDate = {};
      const currentKeys = new Set();
      snap.forEach(d=>{
        const c = d.data();
        currentKeys.add(d.id);
        (byDate[c.date] = byDate[c.date] || []).push(c);
      });
      entry.byDate = byDate;

      // Notify (foreground toast + Notification) about any check-in that's
      // new since the last snapshot and isn't the current user's own —
      // skipped on the very first snapshot after attaching so opening the
      // group doesn't fire a backlog of "notifications" for history.
      if(entry.notified){
        currentKeys.forEach(key=>{
          if(entry.seenKeys.has(key)) return;
          const cdoc = snap.docs.find(d=>d.id===key);
          if(!cdoc) return;
          const c = cdoc.data();
          if(c.uid !== currentUser.uid) notifyTeammateCompletion(c);
        });
      }
      entry.seenKeys = currentKeys;
      entry.notified = true;
      entry.loadedOnce = true;

      renderChallengesList();
      if(challengeId===selectedCalendarChallengeId) renderGroupCalendar();
      syncActivityFeedFromActiveChallenges();
      const ch = activeChallenges.find(c=>c.id===challengeId);
      if(ch) checkAndProcessEliminations(ch);
      maybeRevealGroupDetail();
    }, (err)=>console.error('completions listen failed', err));
  }

  // Computes this user's progress for a challenge given its frequency —
  // "done today" for daily, "N/target this week|month" for weekly/monthly,
  // counting distinct completed dates within the current period.
  function computeChallengeProgress(ch, byDate){
    const today = todayISO();
    const myDates = Object.entries(byDate)
      .filter(([,list])=>list.some(c=>c.uid===currentUser.uid))
      .map(([date])=>date);
    const doneToday = myDates.includes(today);

    if(ch.frequency==='weekly' || ch.frequency==='monthly'){
      const now = new Date();
      const periodStart = ch.frequency==='weekly' ? mondayOfWeek(now) : new Date(now.getFullYear(), now.getMonth(), 1);
      const periodStartIso = fmtISO(periodStart);
      const periodCount = myDates.filter(d=>d>=periodStartIso && d<=today).length;
      const periodTarget = ch.frequencyCount || 1;
      return {
        doneToday, periodCount, periodTarget,
        periodLabel: ch.frequency==='weekly' ? 'this week' : 'this month',
        metTarget: periodCount>=periodTarget
      };
    }
    return {doneToday, periodCount: doneToday?1:0, periodTarget:1, periodLabel:'today', metTarget:doneToday};
  }

  function addDaysISO(iso, n){
    const d = parseISO(iso);
    d.setDate(d.getDate()+n);
    return fmtISO(d);
  }

  function daysBetweenInclusive(startIso, endIso){
    return Math.round((parseISO(endIso) - parseISO(startIso)) / 86400000) + 1;
  }

  // Builds the chronological list of "periods" a challenge is graded on —
  // one per day (daily), per Monday–Sunday week (weekly), or per calendar
  // month (monthly) — each carrying how many check-ins it requires. If the
  // very first or last period is too short to fairly hold the full target
  // against (fewer than *double* the target's worth of days — e.g. a
  // 3x/week target needs at least 6 days to count on its own), it's folded
  // into its one full neighboring period instead of being thrown away: the
  // neighbor's date range stretches to cover it, but its target stays the
  // same. More calendar days, same target — that's what makes a challenge
  // with an awkward start/end date easier rather than unfairly tight,
  // without losing those extra days' worth of required effort entirely
  // (which straight-up dismissing them would have done). See
  // mergeShortEdgePeriods() for the actual folding logic — this function
  // just builds the raw, unmerged list first.
  function computeChallengePeriods(ch){
    const target = ch.frequencyCount || 1;

    if(ch.frequency==='daily'){
      const periods = [];
      let cursor = ch.startDate;
      while(cursor <= ch.endDate){
        periods.push({start: cursor, end: cursor, requiredCount: 1, dismissed: false});
        cursor = addDaysISO(cursor, 1);
      }
      return periods;
    }

    const raw = [];
    if(ch.frequency==='weekly'){
      let weekStart = fmtISO(mondayOfWeek(parseISO(ch.startDate)));
      while(weekStart <= ch.endDate){
        const weekEnd = addDaysISO(weekStart, 6);
        const overlapStart = weekStart < ch.startDate ? ch.startDate : weekStart;
        const overlapEnd = weekEnd > ch.endDate ? ch.endDate : weekEnd;
        const overlapDays = daysBetweenInclusive(overlapStart, overlapEnd);
        const needsMerge = overlapDays < 7 && overlapDays < 2*target;
        raw.push({start: overlapStart, end: overlapEnd, requiredCount: target, needsMerge});
        weekStart = addDaysISO(weekStart, 7);
      }
    } else if(ch.frequency==='monthly'){
      let monthStart = new Date(parseISO(ch.startDate).getFullYear(), parseISO(ch.startDate).getMonth(), 1);
      while(fmtISO(monthStart) <= ch.endDate){
        const monthEndDate = new Date(monthStart.getFullYear(), monthStart.getMonth()+1, 0);
        const monthStartIso = fmtISO(monthStart), monthEndIso = fmtISO(monthEndDate);
        const overlapStart = monthStartIso < ch.startDate ? ch.startDate : monthStartIso;
        const overlapEnd = monthEndIso > ch.endDate ? ch.endDate : monthEndIso;
        const overlapDays = daysBetweenInclusive(overlapStart, overlapEnd);
        const fullDays = daysBetweenInclusive(monthStartIso, monthEndIso);
        const needsMerge = overlapDays < fullDays && overlapDays < 2*target;
        raw.push({start: overlapStart, end: overlapEnd, requiredCount: target, needsMerge});
        monthStart = new Date(monthStart.getFullYear(), monthStart.getMonth()+1, 1);
      }
    }
    return mergeShortEdgePeriods(raw);
  }

  // Folds a too-short leading and/or trailing period into its one
  // neighboring full period, per the comment above. Only ever touches the
  // first and/or last entries — middle periods are always full weeks/months
  // by construction, so they never need merging. If the whole challenge is
  // just one short period with no neighbor to fold into at all, it's left
  // standing on its own with the plain target (nothing else to do).
  function mergeShortEdgePeriods(raw){
    if(raw.length<=1) return raw.map(p=>({start:p.start, end:p.end, requiredCount:p.requiredCount, dismissed:false}));
    let periods = raw.map(p=>({...p}));

    if(periods[0].needsMerge){
      periods[1] = {...periods[1], start: periods[0].start};
      periods.shift();
    }
    if(periods.length>1 && periods[periods.length-1].needsMerge){
      const li = periods.length-1;
      periods[li-1] = {...periods[li-1], end: periods[li].end};
      periods.pop();
    }
    return periods.map(p=>({start:p.start, end:p.end, requiredCount:p.requiredCount, dismissed:false}));
  }

  // "Which numbered week is 'today' in, and what are its real boundaries" —
  // reads directly from computeChallengePeriods(), the same source of truth
  // used for progress and elimination, rather than computing its own
  // separate rolling-week math. It used to do the latter (a plain
  // start+7-day rolling window), which drifted out of sync the moment the
  // merge-short-edge-periods logic was added: the label would show a
  // slightly different boundary than what the person was actually being
  // graded against — e.g. claiming a week ended a day before the real
  // (merged) deadline. Deriving from the same periods list makes that
  // impossible by construction. Before today's/the challenge's date range,
  // falls back to the first period; after it, the last.
  function computeCurrentWeekLabel(ch){
    if(ch.frequency!=='weekly') return null;
    const periods = computeChallengePeriods(ch);
    if(periods.length===0) return null;
    const today = todayISO();
    let idx = periods.findIndex(p=>today>=p.start && today<=p.end);
    if(idx===-1) idx = today < periods[0].start ? 0 : periods.length-1;
    const p = periods[idx];
    return `Week ${idx+1}: ${fmtRange(p.start, p.end)}`;
  }

  // "0/X this challenge" — X is the total check-ins required to complete
  // the whole challenge (summed target across every non-dismissed period).
  // The numerator counts every one of the user's real completions in the
  // challenge's date range, regardless of which period it fell in — see the
  // comment inside for why dismissed periods still credit real check-ins.
  function computeChallengeTotals(ch, byDate){
    const periods = computeChallengePeriods(ch);
    // Dismissal only ever affects what's *required* (the denominator) —
    // real check-ins always count toward the numerator regardless of which
    // period they fell in, including a dismissed one. Excluding them there
    // too was the bug: a check-in made during a dismissed partial week
    // would show up in "this week" but vanish from "this challenge",
    // which reads as the app losing your progress.
    const requiredTotal = periods.reduce((sum, p)=> p.dismissed ? sum : sum + p.requiredCount, 0);
    const myTotal = Object.entries(byDate)
      .filter(([date, list])=> date>=ch.startDate && date<=ch.endDate && list.some(c=>c.uid===currentUser.uid))
      .length;
    return {myTotal, requiredTotal};
  }

  // Opportunistic, client-side elimination check — there's no backend to
  // run this on a schedule, so it runs whenever a challenge's completions
  // refresh (i.e. whichever member's client happens to be open). For every
  // member not already eliminated, walks their required periods in order;
  // the first *elapsed, non-dismissed* period they didn't hit the target
  // for eliminates them from this specific challenge, permanently — they
  // never get evaluated against later periods once out. Safe to call
  // repeatedly: already-eliminated members are skipped, so redundant calls
  // from multiple simultaneously-open clients just no-op past the first.
  async function checkAndProcessEliminations(ch){
    if(!activeGroup || !currentUser || !activeGroupId) return;
    const entry = challengeCompletions[ch.id];
    if(!entry) return;
    const alreadyEliminated = new Set(ch.eliminatedUids || []);
    const candidates = activeMembers.filter(m=>!alreadyEliminated.has(m.uid));
    if(candidates.length===0) return;

    const periods = computeChallengePeriods(ch);
    const today = todayISO();
    const newlyFailed = [];

    candidates.forEach(m=>{
      for(const p of periods){
        if(p.dismissed) continue;
        if(p.end >= today) break; // not elapsed yet — periods are chronological
        const count = Object.entries(entry.byDate)
          .filter(([date, list])=> date>=p.start && date<=p.end && list.some(c=>c.uid===m.uid))
          .length;
        if(count < p.requiredCount){
          newlyFailed.push(m);
          break;
        }
      }
    });

    if(newlyFailed.length===0) return;
    try{
      await updateDoc(doc(db, 'groups', activeGroupId, 'challenges', ch.id), {
        eliminatedUids: arrayUnion(...newlyFailed.map(m=>m.uid))
      });
      newlyFailed.forEach(m=>{
        logGroupEvent(activeGroupId, `${m.displayName} missed their target for "${ch.title}" and is out of the challenge`);
        if(activeGroup.telegramWorkerUrl){
          publishTelegram(activeGroup.telegramWorkerUrl, activeGroup.telegramChatId,
            `❌ ${firstName(m.displayName)} missed their target for "${ch.title}" and can no longer participate.`);
        }
      });
    }catch(e){
      console.error('elimination check failed', e);
    }
  }

  function mondayOfWeek(d){
    const day = (d.getDay()+6)%7; // 0=Mon, matching the app's convention elsewhere
    const monday = new Date(d);
    monday.setDate(d.getDate()-day);
    monday.setHours(0,0,0,0);
    return monday;
  }

  function renderChallengesList(){
    const container = document.getElementById('groupChallengesList');
    const isOwner = activeGroup && currentUser && activeGroup.ownerUid===currentUser.uid;
    document.getElementById('btnNewChallenge').style.display = isOwner ? '' : 'none';

    if(activeChallenges.length===0){
      container.innerHTML = `<div class="card mb-16">
        <p class="text-sm text-muted mb-4">No active challenges yet.</p>
        ${isOwner ? '' : '<p class="text-sm text-faint">Waiting on the group owner to set one.</p>'}
      </div>`;
      return;
    }

    const cardsHtml = activeChallenges.map(ch=>{
      const entry = challengeCompletions[ch.id];
      const byDate = entry ? entry.byDate : {};
      const isEliminated = !!(ch.eliminatedUids && ch.eliminatedUids.includes(currentUser.uid));
      const freqLabel = ch.frequency==='weekly' ? `${ch.frequencyCount||1}x per week`
        : ch.frequency==='monthly' ? `${ch.frequencyCount||1}x per month`
        : 'Daily';
      const isPastEnd = todayISO() > ch.endDate;

      if(isEliminated){
        return `<div class="card group-challenge-card eliminated">
          <div class="settings-row-label">${escapeHtml(ch.title)}${ch.requirePhoto?' 📷':''}</div>
          ${ch.targetLabel ? `<div class="text-sm text-muted">${escapeHtml(ch.targetLabel)}</div>` : ''}
          <div class="text-sm text-faint mt-4">${freqLabel} · ${fmtRange(ch.startDate, ch.endDate)}${isPastEnd?' · Ended':''}${ch.requirePhoto?' · Photo required':''}</div>
          <div class="text-sm mt-8" style="color:var(--danger);">❌ You missed a required target and are out of this challenge</div>
          <div class="quick-actions mt-12" style="margin-bottom:0;">
            <button class="btn btn-secondary btn-sm" style="flex:1; color:var(--danger); border-color:var(--danger-dim);" disabled>You can't participate in this challenge</button>
            ${isOwner ? `<button class="btn btn-secondary btn-sm" data-end-challenge="${ch.id}">End</button>` : ''}
          </div>
        </div>`;
      }

      const progress = computeChallengeProgress(ch, byDate);
      const totals = computeChallengeTotals(ch, byDate);
      const weekLabel = computeCurrentWeekLabel(ch);
      const today = todayISO();
      const inRange = today >= ch.startDate && today <= ch.endDate;
      const progressText = ch.frequency==='daily'
        ? (progress.doneToday ? '✓ Done today' : 'Not done today')
        : `${progress.periodCount}/${progress.periodTarget} ${progress.periodLabel}${progress.metTarget?' ✓':''}`;

      return `<div class="card group-challenge-card">
        <div class="settings-row-label">${escapeHtml(ch.title)}${ch.requirePhoto?' 📷':''}</div>
        ${ch.targetLabel ? `<div class="text-sm text-muted">${escapeHtml(ch.targetLabel)}</div>` : ''}
        <div class="text-sm text-faint mt-4">${freqLabel} · ${fmtRange(ch.startDate, ch.endDate)}${isPastEnd?' · Ended':''}${ch.requirePhoto?' · Photo required':''}</div>
        ${weekLabel ? `<div class="text-sm text-faint mt-4">${escapeHtml(weekLabel)}</div>` : ''}
        <div class="text-sm mt-8" style="color:${progress.metTarget?'var(--positive)':'var(--text-muted)'};">${progressText}</div>
        <div class="text-sm text-faint mt-4">${totals.myTotal}/${totals.requiredTotal} this challenge</div>
        <div class="quick-actions mt-12" style="margin-bottom:0;">
          ${inRange ? `<button class="btn btn-primary btn-sm" style="flex:1;" data-mark-done="${ch.id}" ${progress.doneToday?'disabled':''}>${progress.doneToday?'✓ Done for today':'Mark today done'}</button>` : ''}
          ${isOwner ? `<button class="btn btn-secondary btn-sm" data-end-challenge="${ch.id}">End</button>` : ''}
        </div>
      </div>`;
    }).join('');

    // Same horizontally-scrollable, snap-to-card carousel pattern as the
    // Home screen's "Scheduled for today" row — one challenge per swipe,
    // with dot pagination once there's more than one to page through.
    container.innerHTML = `
      <div class="group-challenge-carousel" id="groupChallengeCarousel">${cardsHtml}</div>
      ${activeChallenges.length>1 ? `<div class="routine-carousel-dots" id="groupChallengeDots">
        ${activeChallenges.map((_,i)=>`<div class="routine-carousel-dot ${i===0?'active':''}" data-dot="${i}"></div>`).join('')}
      </div>` : ''}
    `;

    container.querySelectorAll('[data-mark-done]').forEach(btn=>{
      btn.addEventListener('click', ()=>markChallengeDone(btn.dataset.markDone));
    });
    container.querySelectorAll('[data-end-challenge]').forEach(btn=>{
      btn.addEventListener('click', ()=>endChallenge(btn.dataset.endChallenge));
    });

    if(activeChallenges.length>1){
      const carousel = document.getElementById('groupChallengeCarousel');
      const dotsWrap = document.getElementById('groupChallengeDots');
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

  function fmtRange(startIso, endIso){
    const opts = {month:'short', day:'numeric'};
    return `${parseISO(startIso).toLocaleDateString(undefined,opts)} – ${parseISO(endIso).toLocaleDateString(undefined,opts)}`;
  }

  async function createChallenge(){
    const title = document.getElementById('challengeTitleInput').value.trim();
    const targetLabel = document.getElementById('challengeTargetInput').value.trim();
    const startDate = document.getElementById('challengeStartInput').value;
    const endDate = document.getElementById('challengeEndInput').value;
    const frequency = selectedChallengeFreq;
    // Final clamp regardless of what the input's own max/change handling
    // already did — a week can never hold more than 7 completions (one per
    // day, hard-capped elsewhere), so anything higher would be a target
    // nobody could ever actually complete.
    const freqCap = frequency==='weekly' ? 7 : 31;
    const frequencyCount = frequency==='daily' ? 1 : Math.min(freqCap, Math.max(1, +document.getElementById('challengeFreqCountInput').value || 1));
    // Only actually honored if the group has Telegram configured — the
    // toggle itself is hidden otherwise, but this guards against it
    // somehow being left on from a previous open where it was configured.
    const requirePhoto = requirePhotoOn && !!(activeGroup && activeGroup.telegramWorkerUrl);
    const requireLocation = requirePhoto && requireLocationOn; // never true without requirePhoto
    if(!title){ toast('Give the challenge a name'); return; }
    if(!startDate || !endDate || startDate > endDate){ toast('Check the challenge dates'); return; }
    try{
      // No longer deactivates other challenges — multiple can run at once,
      // each with its own independent completions and calendar view.
      await addDoc(collection(db, 'groups', activeGroupId, 'challenges'), {
        title, targetLabel, startDate, endDate, frequency, frequencyCount, requirePhoto, requireLocation,
        createdBy: currentUser.uid, createdAt: Date.now(), active: true
      });
      ui().closeSheet('sheetNewChallenge');
      toast('Challenge created');
      logGroupEvent(activeGroupId, `started a new challenge: "${title}"`);
      if(activeGroup && activeGroup.ntfyTopic){
        publishNtfy(activeGroup.ntfyTopic, {
          title: activeGroup.name,
          message: `${firstName(currentUser.name)} set a new challenge: ${title}`,
          tags: ['triangular_flag_on_post']
        });
      }
      if(activeGroup && activeGroup.telegramWorkerUrl){
        publishTelegram(activeGroup.telegramWorkerUrl, activeGroup.telegramChatId,
          `🚩 ${firstName(currentUser.name)} started a new challenge: "${title}"`);
      }
    }catch(e){
      console.error(e);
      toast('Could not create challenge');
    }
  }

  // Owner-only: moves a challenge out of the active set (and into history)
  // without deleting its data — members immediately lose the ability to
  // mark it done, but the calendar/tally stay intact for the history view.
  async function endChallenge(challengeId){
    const ch = activeChallenges.find(c=>c.id===challengeId);
    if(!ch) return;
    const ok = ui().confirmDialog ? await ui().confirmDialog({
      title:'End this challenge?', message:`"${ch.title}" will move to history. Members can no longer mark it done.`, confirmLabel:'End challenge', danger:false
    }) : confirm(`End "${ch.title}"?`);
    if(!ok) return;
    try{
      await updateDoc(doc(db, 'groups', activeGroupId, 'challenges', challengeId), {active:false, endedAt: Date.now()});
      toast('Challenge ended');
      logGroupEvent(activeGroupId, `ended the challenge "${ch.title}"`);
      if(activeGroup && activeGroup.telegramWorkerUrl){
        publishTelegram(activeGroup.telegramWorkerUrl, activeGroup.telegramChatId,
          `🏁 ${firstName(currentUser.name)} ended the challenge: "${ch.title}"`);
      }
    }catch(e){
      console.error(e);
      toast('Could not end challenge');
    }
  }

  function notifyTeammateCompletion(c){
    toast(`${firstName(c.displayName)} completed today's challenge 🔥`);
    try{
      if('Notification' in window && Notification.permission==='granted'){
        new Notification(`${activeGroup.name}`, {
          body: `${firstName(c.displayName)} just completed today's challenge`,
          tag: 'group-completion-' + activeGroupId
        });
      }
    }catch(e){ /* notifications are a nice-to-have here, never fatal */ }
  }

  async function markChallengeDone(challengeId){
    const ch = activeChallenges.find(c=>c.id===challengeId);
    if(!ch || !currentUser) return;
    if(ch.eliminatedUids && ch.eliminatedUids.includes(currentUser.uid)) return; // belt-and-suspenders — the button is already disabled for this
    if(ch.requirePhoto){
      openCameraCapture(ch);
      return;
    }
    await recordChallengeCompletion(ch, null);
  }

  // Shared by both paths — a plain check-in and a photo-verified one.
  // photoBase64 is null for the plain path.
  // mapsLink is deliberately never written to Firestore — it only ever
  // reaches Telegram, in the same message the photo itself already goes
  // to. Keeping it out of the completion doc means this app never becomes
  // a second, permanent, app-controlled record of someone's location on
  // top of whatever the group's own Telegram chat retains — one copy of
  // that data is already one more than ideal for something this sensitive.
  async function recordChallengeCompletion(ch, photoBase64, mapsLink){
    const date = todayISO();
    const id = `${date}_${currentUser.uid}`;
    try{
      await setDoc(doc(db, 'groups', activeGroupId, 'challenges', ch.id, 'completions', id), {
        uid: currentUser.uid,
        date,
        displayName: currentUser.name || 'Member',
        color: (activeMembers.find(m=>m.uid===currentUser.uid)||{}).color || PALETTE[0],
        completedAt: Date.now()
      });
      toast('Nice work — marked done for today');
      if(activeGroup && activeGroup.ntfyTopic){
        publishNtfy(activeGroup.ntfyTopic, {
          title: activeGroup.name,
          message: `${firstName(currentUser.name)} completed today's challenge: ${ch.title}`,
          tags: ['fire']
        });
      }
      if(activeGroup && activeGroup.telegramWorkerUrl){
        if(photoBase64){
          const caption = `📸 ${firstName(currentUser.name)} completed today's challenge: ${ch.title}!`
            + (mapsLink ? `\n📍 ${mapsLink}` : '');
          publishTelegramPhoto(activeGroup.telegramWorkerUrl, activeGroup.telegramChatId, photoBase64, caption);
        } else {
          publishTelegram(activeGroup.telegramWorkerUrl, activeGroup.telegramChatId,
            `🎉 Congrats ${firstName(currentUser.name)} for finishing today's challenge: ${ch.title}! Feel free to share a photo 📸`);
        }
      }
    }catch(e){
      console.error(e);
      toast('Could not save — try again');
    }
  }

  /* ---------------- challenge photo capture (camera only, no gallery) ----------------
     Deliberately uses getUserMedia + a live <video> preview rather than a
     native `<input type="file" capture>` picker. The file-input approach
     is only a UX *hint* toward the camera app — behavior varies by browser/
     OS and some still offer a "choose from library" option alongside it,
     which would defeat the entire point ("this way users can't lie"). A
     getUserMedia stream never shows a file picker at all, so there's no
     path to selecting a pre-existing photo — what gets sent is provably a
     live camera frame captured at the moment of tapping the shutter.

     Trade-off worth being honest about: this is strong evidence against
     reusing an old photo, but it's not proof of *what* was photographed or
     *who* took it — someone could still point the camera at a screen, or
     hand their phone to someone else. No client-side technique closes
     that gap completely.

     Also note: because the image is drawn from a live video frame onto a
     <canvas>, it carries no EXIF metadata at all (no GPS, no camera model,
     no embedded timestamp) — unlike a real photo file from the camera app.
     The "metadata" here is our own: the completion doc's date/time, same
     as any other check-in. */
  let cameraStream = null;
  let cameraFacingMode = 'user'; // selfie by default, per the ask — flippable to 'environment'
  let mirrorEnabled = true; // live-preview + captured-photo mirroring; user-togglable via btnCameraMirror
  let pendingPhotoChallenge = null;
  let pendingLocationPromise = null; // resolves to {lat,lng} or null — kicked off at shutter time, read at confirm time
  let capturedPhotoBase64 = null;
  let currentZoomTrack = null;
  let currentZoom = 1;
  let zoomCaps = null; // {min, max, step} from the active track's capabilities, or null if unsupported

  function openCameraCapture(ch){
    pendingPhotoChallenge = ch;
    capturedPhotoBase64 = null;
    pendingLocationPromise = null;
    cameraFacingMode = 'user';
    // Selfie cameras conventionally preview mirrored (like an actual
    // mirror) — that's the expected default when framing yourself. The
    // button lets you turn it off if you'd rather see exactly what the
    // photo will look like.
    mirrorEnabled = true;
    document.getElementById('cameraTitle').textContent = `Capture a photo — ${ch.title}`;
    document.getElementById('cameraOverlay').style.display = 'flex';
    document.getElementById('cameraTopbar').style.display = '';
    document.getElementById('cameraVideo').style.display = '';
    document.getElementById('cameraVideo').classList.toggle('camera-mirrored', mirrorEnabled);
    document.getElementById('cameraPreviewImg').style.display = 'none';
    document.getElementById('cameraLiveControls').style.display = '';
    document.getElementById('cameraPreviewControls').style.display = 'none';
    document.getElementById('cameraStatusText').style.display = 'none';
    document.getElementById('btnCameraMirror').classList.toggle('mirror-on', mirrorEnabled);
    // Shown for the whole live-view step (not just a one-off popup) so it's
    // visible before the browser's own location prompt fires, not after —
    // the person should know what's about to be asked and why, and that
    // declining is fine, before they're staring at a bare system dialog.
    document.getElementById('cameraLocationNote').style.display = ch.requireLocation ? '' : 'none';
    startCameraStream();
  }

  function toggleCameraMirror(){
    mirrorEnabled = !mirrorEnabled;
    document.getElementById('cameraVideo').classList.toggle('camera-mirrored', mirrorEnabled);
    document.getElementById('btnCameraMirror').classList.toggle('mirror-on', mirrorEnabled);
  }

  async function startCameraStream(){
    stopCameraStream();
    const statusEl = document.getElementById('cameraStatusText');
    try{
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: cameraFacingMode}, audio: false
      });
      document.getElementById('cameraVideo').srcObject = cameraStream;
      statusEl.style.display = 'none';
      setupZoomControls();
    }catch(e){
      console.error('camera access failed', e);
      statusEl.textContent = 'Camera access is needed to mark this done. Check your browser or site permissions and try again.';
      statusEl.style.display = '';
    }
  }

  // Many phones default a fresh camera stream — the front one especially —
  // to well above its own minimum zoom, which is exactly why the framing
  // can feel uncomfortably tight before anyone's touched a zoom control.
  // Reset to the widest field of view the track actually supports as soon
  // as we know its capabilities, then expose +/- to adjust from there.
  // Not every browser/device exposes a `zoom` constraint at all (notably
  // iOS Safari and most desktop webcams don't) — the row just stays hidden
  // when that's the case rather than pretending to offer a control that'd
  // silently do nothing.
  function setupZoomControls(){
    const zoomRow = document.getElementById('cameraZoomControls');
    const track = cameraStream ? cameraStream.getVideoTracks()[0] : null;
    currentZoomTrack = track || null;
    zoomCaps = (track && track.getCapabilities) ? (track.getCapabilities().zoom || null) : null;
    if(!zoomCaps){
      zoomRow.style.display = 'none';
      return;
    }
    zoomRow.style.display = '';
    applyZoom(zoomCaps.min);
  }

  function zoomStepSize(){
    if(!zoomCaps) return 0.1;
    return zoomCaps.step || Math.max(0.1, (zoomCaps.max - zoomCaps.min) / 10);
  }

  function applyZoom(z){
    if(!currentZoomTrack || !zoomCaps) return;
    currentZoom = Math.min(zoomCaps.max, Math.max(zoomCaps.min, z));
    currentZoomTrack.applyConstraints({advanced: [{zoom: currentZoom}]}).catch(e=>{
      console.error('zoom adjustment failed', e);
    });
    document.getElementById('cameraZoomLabel').textContent = `${currentZoom.toFixed(1)}x`;
  }

  function stopCameraStream(){
    if(cameraStream){
      cameraStream.getTracks().forEach(t=>t.stop());
      cameraStream = null;
    }
    currentZoomTrack = null;
    zoomCaps = null;
  }

  function closeCameraCapture(){
    stopCameraStream();
    document.getElementById('cameraOverlay').style.display = 'none';
    pendingPhotoChallenge = null;
    capturedPhotoBase64 = null;
    pendingLocationPromise = null;
  }

  async function flipCameraFacing(){
    cameraFacingMode = cameraFacingMode==='user' ? 'environment' : 'user';
    // Reasonable per-camera default each time you switch (selfie cameras
    // conventionally preview mirrored, rear cameras conventionally don't)
    // — the button still always lets you override it manually afterward.
    mirrorEnabled = cameraFacingMode==='user';
    document.getElementById('cameraVideo').classList.toggle('camera-mirrored', mirrorEnabled);
    document.getElementById('btnCameraMirror').classList.toggle('mirror-on', mirrorEnabled);
    await startCameraStream();
  }

  function captureCameraFrame(){
    const video = document.getElementById('cameraVideo');
    if(!video.videoWidth) return; // stream not actually ready yet
    const canvas = document.getElementById('cameraCanvas');
    // Downscale — this is a verification snapshot for Telegram, not a
    // keepsake, so there's no reason to ship a full-resolution photo.
    const maxDim = 1024;
    const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;
    const ctx = canvas.getContext('2d');
    // Match whatever the live preview was actually showing — the person
    // composed the shot against the mirrored-or-not toggle state, so the
    // captured frame should look the same way, not silently differ from
    // what they saw on screen.
    if(mirrorEnabled){
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    capturedPhotoBase64 = dataUrl.split(',')[1];

    // Fired at the exact moment of capture (not later, at confirm time) so
    // the location genuinely corresponds to when the photo was taken. Only
    // *read* once they hit Send, by which point it's almost always already
    // resolved — this way the permission prompt (if it hasn't been granted
    // before) doesn't block or delay the photo preview appearing. Entirely
    // best-effort: a denial or failure just means no map link gets sent,
    // never blocks the check-in itself.
    if(pendingPhotoChallenge && pendingPhotoChallenge.requireLocation && navigator.geolocation){
      pendingLocationPromise = new Promise(resolve=>{
        navigator.geolocation.getCurrentPosition(
          pos => resolve({lat: pos.coords.latitude, lng: pos.coords.longitude}),
          err => { console.error('geolocation failed', err); resolve(null); },
          {timeout: 8000, maximumAge: 0}
        );
      });
    } else {
      pendingLocationPromise = null;
    }

    document.getElementById('cameraPreviewImg').src = dataUrl;
    document.getElementById('cameraPreviewImg').style.display = '';
    document.getElementById('cameraVideo').style.display = 'none';
    // Nothing on the live-view chrome (close, flip, zoom, the location
    // notice) makes sense once a photo's already been taken — Retake/Send
    // are the only two things to do from here.
    document.getElementById('cameraTopbar').style.display = 'none';
    document.getElementById('cameraLiveControls').style.display = 'none';
    document.getElementById('cameraLocationNote').style.display = 'none';
    document.getElementById('cameraPreviewControls').style.display = '';
  }

  function retakeCameraPhoto(){
    capturedPhotoBase64 = null;
    // A retake discards this attempt entirely — any location fetch tied to
    // the discarded frame is stale and shouldn't carry over to whatever
    // gets captured next.
    pendingLocationPromise = null;
    document.getElementById('cameraPreviewImg').style.display = 'none';
    document.getElementById('cameraVideo').style.display = '';
    document.getElementById('cameraTopbar').style.display = '';
    document.getElementById('cameraLiveControls').style.display = '';
    document.getElementById('cameraLocationNote').style.display =
      (pendingPhotoChallenge && pendingPhotoChallenge.requireLocation) ? '' : 'none';
    document.getElementById('cameraPreviewControls').style.display = 'none';
  }

  async function confirmCameraPhoto(){
    if(!pendingPhotoChallenge || !capturedPhotoBase64) return;
    const ch = pendingPhotoChallenge;
    const photoBase64 = capturedPhotoBase64;
    let mapsLink = null;
    if(pendingLocationPromise){
      try{
        const loc = await pendingLocationPromise;
        if(loc) mapsLink = `https://maps.google.com/?q=${loc.lat},${loc.lng}`;
      }catch(e){
        console.error('resolving location failed', e);
      }
    }
    closeCameraCapture();
    await recordChallengeCompletion(ch, photoBase64, mapsLink);
  }

  // The Worker is shared across every group that uses it — the bot token
  // is the only thing baked into its own secrets. Which specific Telegram
  // chat a message lands in is decided per-call by chat_id, which the
  // Worker cross-checks against its own allow-list before ever touching
  // the Telegram API, so a leaked Worker URL alone still can't be used to
  // spam a chat that URL's owner never explicitly approved for it.
  async function publishTelegramPhoto(workerUrl, chatId, photoBase64, caption){
    if(!workerUrl || !chatId) return;
    try{
      await fetch(workerUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({chat_id: chatId, photoBase64, caption})
      });
    }catch(e){
      console.error('telegram photo publish failed', e);
    }
  }

  // Writes a transparency-log entry for a group event (rename, join, leave,
  // kick, ownership change, challenge created/ended, etc.) — shown in the
  // Activity feed alongside challenge check-ins, but never reactable (see
  // renderActivityFeedList: only completion-type items get the emoji row).
  // Self-attributed by design: the underlying privileged actions (rename,
  // kick, transfer...) are already independently gated by their own rules;
  // this collection is a transparency trail, not itself an authorization
  // boundary, so a failed write here never blocks or reverts the actual
  // action it's describing.
  async function logGroupEvent(groupId, message, colorOverride){
    if(!currentUser || !groupId) return;
    try{
      await addDoc(collection(db, 'groups', groupId, 'activityLog'), {
        message,
        actorUid: currentUser.uid,
        actorName: currentUser.name || 'Member',
        color: colorOverride || (activeMembers.find(m=>m.uid===currentUser.uid)||{}).color || PALETTE[0],
        at: Date.now()
      });
    }catch(e){
      console.error('activity log write failed', e);
    }
  }

  /* ---------------- moderation (owner only) ---------------- */
  function showModerationSheet(){
    if(!activeGroupId || !activeGroup) return;
    document.getElementById('modGroupNameInput').value = activeGroup.name;
    document.getElementById('modTelegramWorkerInput').value = activeGroup.telegramWorkerUrl || '';
    document.getElementById('modTelegramChatIdInput').value = activeGroup.telegramChatId || '';
    document.getElementById('modTelegramGroupLinkInput').value = activeGroup.telegramGroupLink || '';
    renderModMembersList();
    ui().openSheet('sheetModeration');
  }

  function renderModMembersList(){
    const list = document.getElementById('modMembersList');
    if(activeMembers.length<=1){
      list.innerHTML = `<p class="text-sm text-muted">No other members yet.</p>`;
      return;
    }
    list.innerHTML = activeMembers.map(m=>{
      const owner = isOwnerUid(m.uid);
      return `<div class="row" style="padding:8px 0; border-bottom:1px solid var(--border-soft); flex-wrap:wrap; gap:8px;">
        <div style="display:flex; align-items:center; gap:10px; min-width:0;">
          <span class="group-color-dot" style="background:${m.color};"></span>
          <span>${escapeHtml(m.displayName)}${owner ? ' <span class="group-crown" title="Group owner">📋</span>' : ''}</span>
        </div>
        ${owner ? '' : `<div style="display:flex; gap:6px; flex-shrink:0;">
          <button class="btn btn-secondary btn-sm" data-transfer-owner="${m.uid}">Make owner</button>
          <button class="btn btn-secondary btn-sm" data-kick-member="${m.uid}" style="border-color:var(--danger-dim); color:var(--danger);">Remove</button>
        </div>`}
      </div>`;
    }).join('');
    list.querySelectorAll('[data-kick-member]').forEach(btn=>{
      btn.addEventListener('click', ()=>kickMember(btn.dataset.kickMember));
    });
    list.querySelectorAll('[data-transfer-owner]').forEach(btn=>{
      btn.addEventListener('click', ()=>transferOwnership(btn.dataset.transferOwner));
    });
  }

  async function saveGroupRename(){
    const name = document.getElementById('modGroupNameInput').value.trim();
    if(!name){ toast('Enter a group name'); return; }
    try{
      await updateDoc(doc(db, 'groups', activeGroupId), {name});
      activeGroup.name = name;
      document.getElementById('groupDetailName').textContent = name;
      toast('Group renamed');
      logGroupEvent(activeGroupId, `renamed the group to "${name}"`);
    }catch(e){
      console.error(e);
      toast('Could not rename group');
    }
  }

  async function regenerateInviteCode(){
    const ok = ui().confirmDialog ? await ui().confirmDialog({
      title:'Regenerate invite code?',
      message:'The old link and QR code will stop working. Anyone who hasn\'t already joined will need the new one.',
      confirmLabel:'Regenerate', danger:true
    }) : confirm('Regenerate the invite code? The old link will stop working.');
    if(!ok) return;
    try{
      const newCode = randomCode();
      await updateDoc(doc(db, 'groups', activeGroupId), {inviteCode: newCode});
      activeGroup.inviteCode = newCode;
      toast('Invite code regenerated');
      logGroupEvent(activeGroupId, 'regenerated the invite code');
    }catch(e){
      console.error(e);
      toast('Could not regenerate invite code');
    }
  }

  /* ---------------- Telegram integration (owner-configured) ----------------
     Telegram's Bot API has no CORS support, so unlike ntfy this can't be a
     direct browser call — it goes through a small Cloudflare Worker the
     owner deploys themselves (see TELEGRAM_SETUP.md), which holds the bot
     token and chat ID as its own secrets. This app only ever sends the
     message text to that Worker's URL; it never sees or stores the token
     or the chat ID at all. */
  async function publishTelegram(workerUrl, chatId, text){
    if(!workerUrl || !chatId) return;
    try{
      await fetch(workerUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({chat_id: chatId, text})
      });
    }catch(e){
      // Same principle as the ntfy publish — never let a notification
      // delivery failure block or roll back the actual action.
      console.error('telegram publish failed', e);
    }
  }

  // The same deployed Worker can now serve many different groups' Telegram
  // chats — the Worker itself only ever holds the bot token as a shared
  // secret; which chat a given group's messages land in is this
  // telegramChatId, cross-checked by the Worker against its own allow-list
  // of chat IDs the owner has actually approved for it.
  async function saveTelegramSettings(){
    const workerUrl = document.getElementById('modTelegramWorkerInput').value.trim();
    const chatId = document.getElementById('modTelegramChatIdInput').value.trim();
    const groupLink = document.getElementById('modTelegramGroupLinkInput').value.trim();
    try{
      await updateDoc(doc(db, 'groups', activeGroupId), {
        telegramWorkerUrl: workerUrl || null,
        telegramChatId: chatId || null,
        telegramGroupLink: groupLink || null
      });
      activeGroup.telegramWorkerUrl = workerUrl || null;
      activeGroup.telegramChatId = chatId || null;
      activeGroup.telegramGroupLink = groupLink || null;
      document.getElementById('btnOpenTelegramGroup').style.display = groupLink ? '' : 'none';
      toast('Telegram settings saved');
    }catch(e){
      console.error(e);
      toast('Could not save Telegram settings');
    }
  }

  async function testTelegramMessage(){
    const workerUrl = document.getElementById('modTelegramWorkerInput').value.trim();
    const chatId = document.getElementById('modTelegramChatIdInput').value.trim();
    if(!workerUrl){ toast('Enter your Cloudflare Worker URL first'); return; }
    if(!chatId){ toast('Enter this group\'s Telegram chat ID first'); return; }
    await publishTelegram(workerUrl, chatId, `Test message from ${activeGroup.name} 👋 — if you can see this, it's working!`);
    toast('Test sent — check your Telegram group');
  }

  // Deliberate hand-off, initiated by the current owner, while they stay a
  // regular member afterward. Distinct from the auto-succession that
  // happens if the owner leaves the group entirely without doing this
  // first (see leaveActiveGroup) — this is the "do it on purpose, in
  // advance" path; that one's the safety net for when nobody does.
  async function transferOwnership(uid){
    const m = activeMembers.find(x=>x.uid===uid);
    if(!m) return;
    const ok = ui().confirmDialog ? await ui().confirmDialog({
      title:'Transfer ownership?',
      message:`${m.displayName} will become the group owner. You'll keep your membership but lose owner controls — moderation, setting challenges, and so on.`,
      confirmLabel:'Transfer', danger:true
    }) : confirm(`Make ${m.displayName} the new owner?`);
    if(!ok) return;
    try{
      await updateDoc(doc(db, 'groups', activeGroupId), {ownerUid: uid});
      activeGroup.ownerUid = uid;
      toast(`${firstName(m.displayName)} is now the owner`);
      logGroupEvent(activeGroupId, `made ${m.displayName} the group owner`);
      // We're no longer the owner ourselves — hide our own owner-only
      // controls immediately rather than waiting for a re-open. The new
      // owner's own device picks this up next time they open the group
      // (there's no live listener on the group doc itself to push it to
      // them instantly).
      document.getElementById('btnModeration').style.display = 'none';
      ui().closeSheet('sheetModeration');
      renderMembersRow();
      renderChallengesList();
    }catch(e){
      console.error(e);
      toast('Could not transfer ownership');
    }
  }

  async function kickMember(uid){
    const m = activeMembers.find(x=>x.uid===uid);
    if(!m) return;
    const ok = ui().confirmDialog ? await ui().confirmDialog({
      title:'Remove member?',
      message:`${m.displayName} will be removed from the group and lose access to its challenges and calendar.`,
      confirmLabel:'Remove', danger:true
    }) : confirm(`Remove ${m.displayName} from the group?`);
    if(!ok) return;
    try{
      await updateDoc(doc(db, 'groups', activeGroupId), {
        memberUids: arrayRemove(uid)
      });
      logGroupEvent(activeGroupId, `removed ${m.displayName} from the group`);
      await deleteDoc(doc(db, 'groups', activeGroupId, 'members', uid));
      activeGroup.memberUids = (activeGroup.memberUids||[]).filter(x=>x!==uid);
      toast(`${firstName(m.displayName)} removed`);
      renderModMembersList();
    }catch(e){
      console.error(e);
      toast('Could not remove member');
    }
  }

  // Permanently deletes the group and everything under it — members,
  // challenges, and every challenge's completions — not just the group doc
  // itself, so nothing gets left behind as orphaned, unreachable data.
  // Firestore has no cascading delete, so this is done client-side, one
  // collection at a time, before finally removing the group doc.
  // Deletes everything under a group — challenges, their completions, the
  // activity log, and members — then the group doc itself. Firestore has
  // no cascading delete, so this walks each collection client-side. Shared
  // by the explicit "Delete group" moderation action and by the owner
  // leaving an otherwise-empty group (see leaveActiveGroup), so an empty,
  // permanently-orphaned group never lingers.
  async function cascadeDeleteGroupData(groupId){
    const challengesSnap = await getDocs(collection(db, 'groups', groupId, 'challenges'));
    for(const chDoc of challengesSnap.docs){
      const compSnap = await getDocs(collection(db, 'groups', groupId, 'challenges', chDoc.id, 'completions'));
      await Promise.all(compSnap.docs.map(d=>deleteDoc(d.ref)));
      await deleteDoc(chDoc.ref);
    }
    const logSnap = await getDocs(collection(db, 'groups', groupId, 'activityLog'));
    await Promise.all(logSnap.docs.map(d=>deleteDoc(d.ref)));
    const membersSnap = await getDocs(collection(db, 'groups', groupId, 'members'));
    await Promise.all(membersSnap.docs.map(d=>deleteDoc(d.ref)));
    await deleteDoc(doc(db, 'groups', groupId));
  }

  async function deleteGroupEntirely(){
    if(!activeGroupId || !activeGroup) return;
    const ok = ui().confirmDialog ? await ui().confirmDialog({
      title:`Delete "${activeGroup.name}"?`,
      message:'This permanently deletes the group for everyone — all challenges, check-ins, and history. This cannot be undone.',
      confirmLabel:'Delete permanently', danger:true
    }) : confirm(`Permanently delete "${activeGroup.name}"? This cannot be undone.`);
    if(!ok) return;

    try{
      await cascadeDeleteGroupData(activeGroupId);
      toast('Group deleted');
      ui().closeSheet('sheetModeration');
      closeGroup();
    }catch(e){
      console.error(e);
      toast('Could not fully delete the group — try again');
    }
  }

  /* ---------------- leaderboard ---------------- */
  // All-time tally across every challenge in the group (active + ended) —
  // unlike the quick 👑 badges shown elsewhere (member chips, day sheet),
  // which only look at currently-active challenges for cheapness, this
  // sheet does the fuller fetch since it's opened deliberately rather than
  // rendered constantly.
  async function showLeaderboardSheet(){
    if(!activeGroupId) return;
    ui().openSheet('sheetLeaderboard');
    const content = document.getElementById('leaderboardContent');
    content.innerHTML = `<p class="text-sm text-muted">Loading…</p>`;

    const counts = {};
    const bump = (uid)=>{ counts[uid] = (counts[uid]||0)+1; };

    activeChallenges.forEach(ch=>{
      const entry = challengeCompletions[ch.id];
      if(!entry) return;
      Object.values(entry.byDate).flat().forEach(c=>bump(c.uid));
    });

    try{
      const snap = await getDocs(collection(db, 'groups', activeGroupId, 'challenges'));
      const today = todayISO();
      const ended = snap.docs.map(d=>({id:d.id, ...d.data()})).filter(ch=>!ch.active || ch.endDate < today);
      const endedUidLists = await Promise.all(ended.map(async ch=>{
        const compSnap = await getDocs(collection(db, 'groups', activeGroupId, 'challenges', ch.id, 'completions'));
        return compSnap.docs.map(d=>d.data().uid);
      }));
      endedUidLists.flat().forEach(bump);
    }catch(e){
      console.error('leaderboard history fetch failed', e);
    }

    // Include anyone with a completion even if they've since left the
    // group (same fallback pattern as challenge history's tally).
    const allUids = new Set([...activeMembers.map(m=>m.uid), ...Object.keys(counts)]);
    const rows = Array.from(allUids).map(uid=>{
      const m = activeMembers.find(x=>x.uid===uid);
      return { uid, name: m ? m.displayName : 'Former member', color: m ? m.color : PALETTE[0], count: counts[uid]||0 };
    }).sort((a,b)=>b.count-a.count);

    if(rows.length===0){
      content.innerHTML = `<p class="text-sm text-muted">No members yet.</p>`;
      return;
    }
    const topCount = rows[0].count;

    content.innerHTML = rows.map((r,i)=>{
      const owner = isOwnerUid(r.uid) ? ' <span class="group-crown" title="Group owner">📋</span>' : '';
      const leader = (topCount>0 && r.count===topCount) ? ' <span class="group-crown" title="Leader — most challenges completed">👑</span>' : '';
      return `<div class="row" style="padding:8px 0; border-bottom:1px solid var(--border-soft);">
        <div style="display:flex; align-items:center; gap:10px; min-width:0;">
          <span class="text-sm text-faint" style="width:16px; flex-shrink:0;">${i+1}</span>
          <span class="group-color-dot" style="background:${r.color};"></span>
          <span>${escapeHtml(firstName(r.name))}${owner}${leader}</span>
        </div>
        <span class="text-sm text-muted" style="flex-shrink:0;">${r.count} check-in${r.count!==1?'s':''}</span>
      </div>`;
    }).join('');
  }

  /* ---------------- challenge history ---------------- */
  // A closed-book view — fetched once per open (getDocs, not a live
  // listener) since ended challenges never change again. Falls back to the
  // displayName/color stored on each completion for anyone no longer in
  // activeMembers (e.g. they've since left the group), so the tally still
  // shows who they were rather than silently dropping their check-ins.
  async function showChallengeHistorySheet(){
    if(!activeGroupId) return;
    ui().openSheet('sheetChallengeHistory');
    const content = document.getElementById('challengeHistoryContent');
    content.innerHTML = `<p class="text-sm text-muted">Loading…</p>`;
    try{
      const snap = await getDocs(collection(db, 'groups', activeGroupId, 'challenges'));
      const today = todayISO();
      const ended = snap.docs
        .map(d=>({id:d.id, ...d.data()}))
        .filter(ch=>!ch.active || ch.endDate < today)
        .sort((a,b)=>(b.endedAt||b.createdAt||0)-(a.endedAt||a.createdAt||0));

      if(ended.length===0){
        content.innerHTML = `<p class="text-sm text-muted">No past challenges yet.</p>`;
        return;
      }

      const cards = await Promise.all(ended.map(async ch=>{
        const compSnap = await getDocs(collection(db, 'groups', activeGroupId, 'challenges', ch.id, 'completions'));
        const countByUid = {}, nameByUid = {}, colorByUid = {};
        compSnap.forEach(d=>{
          const c = d.data();
          countByUid[c.uid] = (countByUid[c.uid]||0)+1;
          nameByUid[c.uid] = c.displayName;
          colorByUid[c.uid] = c.color;
        });
        const allUids = new Set([...activeMembers.map(m=>m.uid), ...Object.keys(countByUid)]);
        const tally = Array.from(allUids).map(uid=>{
          const m = activeMembers.find(x=>x.uid===uid);
          return {
            name: firstName(m ? m.displayName : (nameByUid[uid]||'Member')),
            color: m ? m.color : (colorByUid[uid]||PALETTE[0]),
            count: countByUid[uid]||0
          };
        }).sort((a,b)=>b.count-a.count);
        const freqLabel = ch.frequency==='weekly' ? `${ch.frequencyCount||1}x/week` : ch.frequency==='monthly' ? `${ch.frequencyCount||1}x/month` : 'Daily';

        return `<div class="card mb-12">
          <div class="settings-row-label">${escapeHtml(ch.title)}</div>
          <div class="text-sm text-faint mb-8">${freqLabel} · ${fmtRange(ch.startDate, ch.endDate)}</div>
          ${tally.map(t=>`<div class="row" style="padding:4px 0;">
            <div style="display:flex; align-items:center; gap:8px;"><span class="group-color-dot" style="background:${t.color};"></span>${escapeHtml(t.name)}</div>
            <span class="text-sm text-muted">${t.count} check-in${t.count!==1?'s':''}</span>
          </div>`).join('')}
        </div>`;
      }));
      content.innerHTML = cards.join('');
    }catch(e){
      console.error(e);
      content.innerHTML = `<p class="text-sm text-muted">Could not load history.</p>`;
    }
  }

  /* ---------------- activity feed (reactions) ----------------
     A reverse-chronological feed of check-ins across every challenge in
     the group — active ones read live from the same data the challenge
     cards already listen to (no extra Firestore reads), ended ones are
     fetched once per sheet-open the same way challenge history is (a
     closed book — nothing there changes on its own). Each item carries a
     small emoji-reaction bar; reactions live in a `reactions: {uid:emoji}`
     map on the completion doc itself. */
  const REACTION_EMOJI = ['👍','🔥','💪','🎉','👏'];

  async function showActivityFeedSheet(){
    if(!activeGroupId) return;
    const mine = activeMembers.find(m=>m.uid===(currentUser||{}).uid);
    const previousSeen = mine ? (mine.lastSeenReactionsAt||0) : 0;

    ui().openSheet('sheetActivityFeed');
    document.getElementById('activityFeedBanner').innerHTML = '';
    const container = document.getElementById('activityFeedContent');
    container.innerHTML = `<p class="text-sm text-muted">Loading…</p>`;

    const items = [];
    activeChallenges.forEach(ch=>{
      const entry = challengeCompletions[ch.id];
      if(!entry) return;
      Object.values(entry.byDate).flat().forEach(c=>{
        items.push({...c, challengeId: ch.id, challengeTitle: ch.title, completionId: `${c.date}_${c.uid}`});
      });
    });

    try{
      const snap = await getDocs(collection(db, 'groups', activeGroupId, 'challenges'));
      const today = todayISO();
      const ended = snap.docs.map(d=>({id:d.id, ...d.data()})).filter(ch=>!ch.active || ch.endDate < today);
      const endedGroups = await Promise.all(ended.map(async ch=>{
        const compSnap = await getDocs(collection(db, 'groups', activeGroupId, 'challenges', ch.id, 'completions'));
        return compSnap.docs.map(d=>({...d.data(), challengeId: ch.id, challengeTitle: ch.title, completionId: d.id}));
      }));
      endedGroups.forEach(list=>items.push(...list));
    }catch(e){
      console.error('activity feed history fetch failed', e);
    }

    items.sort((a,b)=>(b.completedAt||0)-(a.completedAt||0));
    activityFeedItems = items.slice(0, 40);
    renderActivityFeedList();

    // Anything that happened while they were away — collected against the
    // *old* lastSeenReactionsAt, before we mark everything seen below.
    const congratsNames = collectCongratsNames(activityFeedItems, previousSeen);
    if(congratsNames.length) showActivityCongratsBanner(congratsNames);

    markReactionsSeenNow();
  }

  function renderActivityFeedList(){
    const container = document.getElementById('activityFeedContent');
    if(!container) return;

    // Merge completions (reactable) with log events (not reactable) purely
    // at render time, sorted together chronologically — the two source
    // arrays stay separate since only completions ever grow a reaction row.
    const merged = [
      ...activityFeedItems.map(i=>({...i, kind:'completion', ts:i.completedAt})),
      ...activityLogItems.map(i=>({...i, kind:'log', ts:i.at}))
    ].sort((a,b)=>(b.ts||0)-(a.ts||0)).slice(0, 50);

    if(merged.length===0){
      container.innerHTML = `<p class="text-sm text-muted">No activity yet.</p>`;
      return;
    }

    container.innerHTML = merged.map(item=>{
      if(item.kind==='log'){
        return `<div class="card mb-12">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="group-color-dot" style="background:${item.color||'#888'};"></span>
            <div style="min-width:0;">
              <div class="text-sm"><span style="font-weight:600;">${escapeHtml(firstName(item.actorName))}</span> <span style="color:var(--text-muted);">${escapeHtml(item.message)}</span></div>
              <div class="text-sm text-faint">${relativeTime(item.ts)}</div>
            </div>
          </div>
        </div>`;
      }
      const reactions = item.reactions || {};
      const counts = {};
      Object.values(reactions).forEach(r=>{ counts[r.emoji] = (counts[r.emoji]||0)+1; });
      const mineR = currentUser ? reactions[currentUser.uid] : null;
      const myReaction = mineR ? mineR.emoji : null;
      return `<div class="card mb-12">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="group-color-dot" style="background:${item.color};"></span>
          <div style="min-width:0;">
            <div class="text-sm" style="font-weight:600;">${escapeHtml(firstName(item.displayName))} <span style="font-weight:400; color:var(--text-muted);">completed</span> ${escapeHtml(item.challengeTitle)}</div>
            <div class="text-sm text-faint">${relativeTime(item.completedAt)}</div>
          </div>
        </div>
        <div class="activity-reaction-row mt-8">
          ${REACTION_EMOJI.map(e=>`
            <button type="button" class="activity-reaction-btn ${myReaction===e?'active':''}" data-react="${item.challengeId}|${item.completionId}|${e}">
              ${e}${counts[e]?`<span class="activity-reaction-count">${counts[e]}</span>`:''}
            </button>
          `).join('')}
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('[data-react]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const [challengeId, completionId, emoji] = btn.dataset.react.split('|');
        toggleReaction(challengeId, completionId, emoji);
      });
    });
  }

  // Applies live updates from the already-subscribed active-challenge
  // completions listeners onto whatever's currently cached for the feed —
  // keeps reactions on active challenges' items live without any extra
  // Firestore reads. Ended-challenge items only refresh on next sheet-open.
  // Also detects brand-new reactions landing on the current user's own
  // check-ins (diffed against what was already cached, not a timestamp, so
  // it only ever fires for genuinely new arrivals) and, if the Activity
  // sheet is open right now, surfaces them as an in-page banner instead of
  // waiting for the next time the sheet is opened.
  function syncActivityFeedFromActiveChallenges(){
    let changed = false;
    const liveCongrats = new Set();
    activeChallenges.forEach(ch=>{
      const entry = challengeCompletions[ch.id];
      if(!entry) return;
      Object.values(entry.byDate).flat().forEach(c=>{
        const completionId = `${c.date}_${c.uid}`;
        const idx = activityFeedItems.findIndex(i=>i.challengeId===ch.id && i.completionId===completionId);
        if(idx<0) return;
        const old = activityFeedItems[idx];
        if(currentUser && c.uid===currentUser.uid){
          const oldReactions = old.reactions || {};
          const newReactions = c.reactions || {};
          Object.entries(newReactions).forEach(([uid,r])=>{
            if(uid===currentUser.uid) return;
            const oldR = oldReactions[uid];
            if(!oldR || oldR.at !== r.at){
              const m = activeMembers.find(x=>x.uid===uid);
              liveCongrats.add(m ? firstName(m.displayName) : 'Someone');
            }
          });
        }
        activityFeedItems[idx] = {...old, ...c};
        changed = true;
      });
    });

    const sheetEl = document.getElementById('sheetActivityFeed');
    const sheetOpen = sheetEl && sheetEl.classList.contains('open');
    if(liveCongrats.size && sheetOpen){
      showActivityCongratsBanner(Array.from(liveCongrats));
      markReactionsSeenNow();
    }
    if(changed) renderActivityFeedList();
    renderActivityBadge();
  }

  // Collects the first names of anyone who reacted to one of the current
  // user's own check-ins after `sinceTs` — used both for the "while you
  // were away" banner on opening the sheet, and could be reused elsewhere.
  function collectCongratsNames(items, sinceTs){
    if(!currentUser) return [];
    const names = new Set();
    items.forEach(item=>{
      if(item.uid !== currentUser.uid) return;
      const reactions = item.reactions || {};
      Object.entries(reactions).forEach(([uid,r])=>{
        if(uid===currentUser.uid) return;
        if((r.at||0) > sinceTs){
          const m = activeMembers.find(x=>x.uid===uid);
          names.add(m ? firstName(m.displayName) : 'Someone');
        }
      });
    });
    return Array.from(names);
  }

  function showActivityCongratsBanner(names){
    const banner = document.getElementById('activityFeedBanner');
    if(!banner) return;
    const text = names.length===1 ? `${names[0]} congratulated you 🔥`
      : names.length===2 ? `${names[0]} and ${names[1]} congratulated you 🔥`
      : `${names.slice(0,-1).join(', ')}, and ${names[names.length-1]} congratulated you 🔥`;
    banner.innerHTML = `<div class="activity-congrats-banner">${escapeHtml(text)}</div>`;
    clearTimeout(banner._hideTimeout);
    banner._hideTimeout = setTimeout(()=>{ banner.innerHTML = ''; }, 6000);
  }

  // Writes this user's "I've seen reactions up to now" marker onto their
  // own member doc (already self-writable, no rule change needed) — synced
  // across devices, unlike a purely local/localStorage flag would be.
  async function markReactionsSeenNow(){
    if(!currentUser || !activeGroupId) return;
    const now = Date.now();
    const mine = activeMembers.find(m=>m.uid===currentUser.uid);
    if(mine) mine.lastSeenReactionsAt = now; // optimistic, so the badge clears immediately
    renderActivityBadge();
    try{
      await updateDoc(doc(db, 'groups', activeGroupId, 'members', currentUser.uid), {lastSeenReactionsAt: now});
    }catch(e){
      console.error('could not mark reactions seen', e);
    }
  }

  // Red dot on the Activity button — based on live data from active
  // challenges only (the same data already in memory), so reactions on a
  // long-ended challenge won't trigger it. A reasonable trade-off against
  // adding more always-on listeners for something that's just a hint.
  function hasUnseenReactions(){
    if(!currentUser) return false;
    const mine = activeMembers.find(m=>m.uid===currentUser.uid);
    const lastSeen = mine ? (mine.lastSeenReactionsAt||0) : 0;
    return activeChallenges.some(ch=>{
      const entry = challengeCompletions[ch.id];
      if(!entry) return false;
      return Object.values(entry.byDate).flat().some(c=>{
        if(c.uid !== currentUser.uid) return false;
        const reactions = c.reactions || {};
        return Object.entries(reactions).some(([uid,r])=>uid!==currentUser.uid && (r.at||0) > lastSeen);
      });
    });
  }

  function renderActivityBadge(){
    const dot = document.getElementById('activityUnreadDot');
    if(!dot) return;
    dot.style.display = hasUnseenReactions() ? '' : 'none';
  }

  async function toggleReaction(challengeId, completionId, emoji){
    if(!currentUser) return;
    const item = activityFeedItems.find(i=>i.challengeId===challengeId && i.completionId===completionId);
    if(!item) return;
    const reactions = {...(item.reactions||{})};
    const mine = reactions[currentUser.uid];
    const removing = mine && mine.emoji===emoji;
    const at = Date.now();
    if(removing) delete reactions[currentUser.uid];
    else reactions[currentUser.uid] = {emoji, at};

    item.reactions = reactions; // optimistic — feels instant, corrected on next fetch if the write below ever fails
    renderActivityFeedList();

    try{
      const ref = doc(db, 'groups', activeGroupId, 'challenges', challengeId, 'completions', completionId);
      await updateDoc(ref, { [`reactions.${currentUser.uid}`]: removing ? deleteField() : {emoji, at} });
    }catch(e){
      console.error(e);
      toast('Could not save reaction');
    }
  }

  function relativeTime(ts){
    if(!ts) return '';
    const mins = Math.floor((Date.now()-ts)/60000);
    if(mins<1) return 'just now';
    if(mins<60) return `${mins}m ago`;
    const hrs = Math.floor(mins/60);
    if(hrs<24) return `${hrs}h ago`;
    const days = Math.floor(hrs/24);
    if(days<7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString(undefined,{month:'short', day:'numeric'});
  }

  /* ---------------- completions + calendar ---------------- */
  function renderCalendarChallengeSelector(){
    const wrap = document.getElementById('calChallengeSelector');
    if(activeChallenges.length<=1){
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = '';
    wrap.innerHTML = activeChallenges.map(ch=>`
      <button type="button" class="btn btn-secondary btn-sm challenge-freq-chip ${ch.id===selectedCalendarChallengeId?'selected':''}" data-cal-challenge="${ch.id}" style="white-space:nowrap;">${escapeHtml(ch.title)}</button>
    `).join('');
    wrap.querySelectorAll('[data-cal-challenge]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        selectedCalendarChallengeId = btn.dataset.calChallenge;
        renderCalendarChallengeSelector();
        renderGroupCalendar();
      });
    });
  }

  function renderGroupCalendar(){
    if(!activeGroupId) return;
    const year = calCursor.getFullYear(), month = calCursor.getMonth();
    document.getElementById('calGroupMonthLabel').textContent = calCursor.toLocaleDateString(undefined,{month:'long', year:'numeric'});

    const dowRow = document.getElementById('calGroupDowRow');
    dowRow.innerHTML = ['M','T','W','T','F','S','S'].map(d=>`<div class="cal-dow">${d}</div>`).join('');

    const grid = document.getElementById('calGroupGrid');
    const firstDay = new Date(year, month, 1);
    const startOffset = (firstDay.getDay()+6)%7;
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const today = new Date();
    const byDate = (challengeCompletions[selectedCalendarChallengeId] || {}).byDate || {};

    let cells = [];
    for(let i=0;i<startOffset;i++) cells.push(null);
    for(let d=1; d<=daysInMonth; d++) cells.push(d);

    grid.innerHTML = cells.map(d=>{
      if(d===null) return `<div class="cal-cell empty"></div>`;
      const cellDate = new Date(year,month,d);
      const iso = fmtISO(cellDate);
      const isToday = iso===fmtISO(today);
      const completions = byDate[iso] || [];
      const dots = completions.slice(0,8).map(c=>`<span class="group-cal-dot" style="background:${c.color}"></span>`).join('');
      return `<div class="cal-cell ${isToday?'today':''} ${completions.length?'has-completions':''}" data-date="${iso}">
        <span class="num">${d}</span>
        <div class="group-cal-dots">${dots}</div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.cal-cell[data-date]').forEach(cell=>{
      cell.addEventListener('click', ()=>openDaySheet(cell.dataset.date));
    });

    // Legend: one row per member and their color, so dot colors are readable
    // at a glance without needing to tap into every day. A member eliminated
    // from the currently-selected challenge shows red with a ❌ instead of
    // their usual color — visible to everyone, not just the person out.
    const selectedCh = activeChallenges.find(c=>c.id===selectedCalendarChallengeId);
    const eliminatedSet = new Set((selectedCh && selectedCh.eliminatedUids) || []);
    const legend = document.getElementById('calGroupLegend');
    legend.innerHTML = activeMembers.map(m=>{
      const isOut = eliminatedSet.has(m.uid);
      return `<div class="cal-legend-item" style="${isOut?'color:var(--danger);':''}">
        <div class="cal-legend-swatch" style="background:${isOut?'var(--danger)':m.color}; border:none;"></div>
        ${escapeHtml(firstName(m.displayName))}${isOut?' ❌':''}
      </div>`;
    }).join('');
  }

  function openDaySheet(dateIso){
    const byDate = (challengeCompletions[selectedCalendarChallengeId] || {}).byDate || {};
    const completions = byDate[dateIso] || [];
    const completedUids = new Set(completions.map(c=>c.uid));
    const d = parseISO(dateIso);
    document.getElementById('dayCompletionsTitle').textContent = d.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'});

    const list = document.getElementById('dayCompletionsList');
    if(activeMembers.length===0){
      list.innerHTML = `<p class="text-sm text-muted">No members yet.</p>`;
    } else {
      const leaderUids = computeActiveLeaderUids();
      list.innerHTML = activeMembers.map(m=>{
        const done = completedUids.has(m.uid);
        return `<div class="row" style="padding:8px 0; border-bottom:1px solid var(--border-soft);">
          <div style="display:flex; align-items:center; gap:10px;">
            <span class="group-color-dot" style="background:${m.color}; opacity:${done?1:0.35};"></span>
            <span style="${done?'':'color:var(--text-faint);'}">${escapeHtml(m.displayName)}${badgesForMember(m.uid, leaderUids)}</span>
          </div>
          <span style="${done?'color:var(--positive);':'color:var(--text-faint);'} font-size:13px;">${done?'✓ Done':'—'}</span>
        </div>`;
      }).join('');
    }
    ui().openSheet('sheetDayCompletions');
  }

  function escapeHtml(s){
    return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // groups.js is a `<script type="module">`, which the spec always defers —
  // it only executes after the document has finished parsing. By that
  // point `document.readyState` is already 'interactive', not 'loading',
  // so the `if` check below fires init() immediately... but DOMContentLoaded
  // hasn't actually dispatched yet at that moment (it fires *after*
  // deferred/module scripts finish), so the listener on the line above
  // *also* fires init() a moment later. Net effect: init() — and every
  // click handler wired up inside it — ran twice on every load. Most
  // things absorbed that silently (opening a sheet twice is harmless,
  // re-setting the same value twice is harmless), but anything that
  // *flips* a boolean each call would flip it on, then immediately back
  // off, in the same tick — invisible net effect, which is exactly the
  // "Require photo" toggle bug this guard fixes.
  let initialized = false;
  function guardedInit(){
    if(initialized) return;
    initialized = true;
    init();
  }
  document.addEventListener('DOMContentLoaded', guardedInit);
  if(document.readyState!=='loading') guardedInit();

  window.GymGroups = { onShow, getHomeChallengeCards, openGroupFromHome };
})();
