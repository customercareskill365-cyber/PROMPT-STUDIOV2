(() => {
  'use strict';

  const LOCAL_STORAGE_KEY = 'prompt_studio_library_v1';

  const state = {
    library: {
      version: 1,
      settings: {
        autoCompleteOnCopy: false,
        defaultShotSeconds: 6,
      },
      projects: [],
    },
    activeProjectId: null,
    focusedShotId: null,
    libFilter: 'all',
    libTopic: 'all',
    libSort: 'updated',
    libSearch: '',
    wsShotFilter: 'all',
    wsShotSearch: '',
    importContext: {
      appendToProjectId: null,
      rawTableRows: null,
      columnMapping: null,
      headerRowIndex: -1,
      previewShots: [],
      sourceFilename: '',
    },
    serverOnline: true,
    hasBackend: true,
    saveTimer: null,
    saveInFlight: false,
    savePending: false,
    dirtyProjectIds: new Set(),
    dirtySettings: false,
    replaceAllPending: false,
    lastSyncCheck: 0,
  };

  // --- DOM Refs ---
  const $ = (id) => document.getElementById(id);

  // --- Utilities ---
  function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(message, variant = 'ok') {
    const container = $('toastContainer');
    const div = document.createElement('div');
    div.className = `toast ${variant === 'warn' ? 'toast-warn' : variant === 'err' ? 'toast-err' : ''}`;
    div.textContent = message;
    container.appendChild(div);
    setTimeout(() => {
      div.style.opacity = '0';
      div.style.transform = 'translateY(6px)';
      div.style.transition = 'all 0.2s ease';
      setTimeout(() => div.remove(), 220);
    }, 2600);
  }

  function formatRelativeTime(iso) {
    if (!iso) return 'Just now';
    const diffMs = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return 'Just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  function parseDurationSeconds(durStr, fallback = 6) {
    if (durStr === undefined || durStr === null) return fallback;
    const s = String(durStr).trim().toLowerCase();
    if (!s) return fallback;
    // mm:ss
    const colon = s.match(/^(\d+):(\d{1,2})$/);
    if (colon) return parseInt(colon[1], 10) * 60 + parseInt(colon[2], 10);
    // Xm Ys
    const minSec = s.match(/(\d+(?:\.\d+)?)\s*m(?:in)?(?:\s*(\d+(?:\.\d+)?)\s*s)?/);
    if (minSec) {
      return Math.round(parseFloat(minSec[1]) * 60 + (minSec[2] ? parseFloat(minSec[2]) : 0));
    }
    const sec = s.match(/(\d+(?:\.\d+)?)/);
    if (sec) return Math.max(1, Math.round(parseFloat(sec[1])));
    return fallback;
  }

  function formatSecondsMMSS(totalSec) {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
  }

  function calculateProjectStats(project) {
    const shots = project.shots || [];
    const total = shots.length;
    const completed = shots.filter((s) => !!s.completed).length;
    const copied = shots.filter((s) => !!s.copied && !s.completed).length;
    const pending = total - completed - copied;
    const pct = total ? Math.round((completed / total) * 100) : 0;
    const defaultSec = Number(project.defaultShotSeconds || state.library.settings.defaultShotSeconds || 6);
    const totalSeconds = shots.reduce((acc, s) => acc + parseDurationSeconds(s.duration, defaultSec), 0);
    const nextIncomplete = shots.find((s) => !s.completed) || null;
    return { total, completed, copied, pending, pct, totalSeconds, nextIncomplete };
  }

  function getActiveProject() {
    return state.library.projects.find((p) => p.id === state.activeProjectId) || null;
  }

  function cleanFilenameTitle(filename) {
    return String(filename || 'Untitled Video Project')
      .replace(/\.[^/.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function copyTextToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    // Fallback textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {}
    ta.remove();
    return ok;
  }

  // --- Persistence (Disk API + LocalStorage Backup) ---
  function setSyncStatus(mode, text) {
    const pill = $('saveSyncIndicator');
    const lbl = $('saveSyncLabel');
    pill.classList.remove('sync-ok', 'sync-warn');
    pill.classList.add(mode === 'ok' ? 'sync-ok' : 'sync-warn');
    lbl.textContent = text;
  }

  function saveLocalBackup() {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state.library));
    } catch (_) {}
  }

  async function loadLibrary() {
    let loadedFromServer = null;
    try {
      const resp = await fetch('/api/library', { cache: 'no-store' });
      const ct = resp.headers.get('content-type') || '';
      if (resp.ok && ct.includes('application/json')) {
        loadedFromServer = await resp.json();
        state.serverOnline = true;
        state.hasBackend = true;
      } else {
        state.hasBackend = false;
      }
    } catch (_) {
      state.serverOnline = false;
      state.hasBackend = false;
    }

    if (loadedFromServer && Array.isArray(loadedFromServer.projects)) {
      state.library = {
        version: loadedFromServer.version || 1,
        settings: Object.assign(
          { autoCompleteOnCopy: false, defaultShotSeconds: 6 },
          loadedFromServer.settings || {}
        ),
        projects: loadedFromServer.projects,
      };
      saveLocalBackup();
      setSyncStatus('ok', 'Saved to Disk');
    } else {
      // Fallback to localStorage (also used when hosted as a free static web app)
      try {
        const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.projects)) {
            state.library = parsed;
          }
        }
      } catch (_) {}
      setSyncStatus('ok', state.hasBackend ? 'Browser Backup Only' : 'Saved on Device');
    }
  }

  async function postJsonWithRetry(url, payload, retryOnce = true) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (resp.ok) return { ok: true };
      if (retryOnce) {
        await new Promise((r) => setTimeout(r, 250));
        return postJsonWithRetry(url, payload, false);
      }
      return { ok: false, offline: false };
    } catch (_) {
      if (retryOnce) {
        await new Promise((r) => setTimeout(r, 250));
        return postJsonWithRetry(url, payload, false);
      }
      return { ok: false, offline: true };
    }
  }

  async function flushSaveLibrary() {
    if (!state.hasBackend) {
      state.dirtyProjectIds.clear();
      state.dirtySettings = false;
      state.replaceAllPending = false;
      setSyncStatus('ok', 'Saved on Device');
      return;
    }
    if (state.saveInFlight) {
      state.savePending = true;
      return;
    }
    state.saveInFlight = true;
    state.savePending = false;

    let allOk = true;
    let wentOffline = false;

    try {
      if (state.replaceAllPending) {
        state.replaceAllPending = false;
        state.dirtyProjectIds.clear();
        state.dirtySettings = false;
        const res = await postJsonWithRetry('/api/library', { ...state.library, replaceAll: true }, true);
        if (!res.ok) {
          allOk = false;
          if (res.offline) wentOffline = true;
        }
      } else {
        const idsToSave = Array.from(state.dirtyProjectIds);
        state.dirtyProjectIds.clear();
        for (const pid of idsToSave) {
          const proj = state.library.projects.find((p) => p.id === pid);
          if (!proj) continue;
          const res = await postJsonWithRetry('/api/project', proj, true);
          if (!res.ok) {
            state.dirtyProjectIds.add(pid);
            allOk = false;
            if (res.offline) wentOffline = true;
          }
        }

        if (state.dirtySettings) {
          state.dirtySettings = false;
          const res = await postJsonWithRetry('/api/settings', state.library.settings, true);
          if (!res.ok) {
            state.dirtySettings = true;
            allOk = false;
            if (res.offline) wentOffline = true;
          }
        }
      }

      if (allOk) {
        state.serverOnline = true;
        setSyncStatus('ok', 'Saved to Disk');
      } else if (wentOffline) {
        state.serverOnline = false;
        setSyncStatus('warn', 'Offline · Browser Backup');
      } else {
        setSyncStatus('warn', 'Browser Backup Only');
      }
    } finally {
      state.saveInFlight = false;
    }

    if (state.savePending) {
      flushSaveLibrary();
    }
  }

  function scheduleSaveLibrary(touchProject = null, opts = {}) {
    if (touchProject) {
      touchProject.updatedAt = new Date().toISOString();
      state.dirtyProjectIds.add(touchProject.id);
    } else if (opts.replaceAll) {
      state.replaceAllPending = true;
    } else if (opts.settingsOnly) {
      state.dirtySettings = true;
    } else if (state.activeProjectId) {
      state.dirtyProjectIds.add(state.activeProjectId);
    } else {
      state.dirtySettings = true;
    }

    saveLocalBackup();
    setSyncStatus('warn', 'Saving...');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      flushSaveLibrary();
    }, 220);
  }

  async function syncFromServerIfIdle() {
    if (!state.hasBackend || state.saveInFlight || state.dirtyProjectIds.size > 0 || state.replaceAllPending) return;
    const now = Date.now();
    if (now - state.lastSyncCheck < 1500) return;
    state.lastSyncCheck = now;

    try {
      const resp = await fetch('/api/library', { cache: 'no-store' });
      if (!resp.ok) return;
      const serverLib = await resp.json();
      if (!serverLib || !Array.isArray(serverLib.projects)) return;

      const currentJson = JSON.stringify(state.library.projects);
      const serverJson = JSON.stringify(serverLib.projects);
      if (currentJson !== serverJson) {
        state.library.projects = serverLib.projects;
        if (serverLib.settings) state.library.settings = serverLib.settings;
        saveLocalBackup();
        setSyncStatus('ok', 'Saved to Disk');
        renderTopSwitcher();
        if (!state.activeProjectId) {
          renderLibrary();
        } else if (state.library.projects.some((p) => p.id === state.activeProjectId)) {
          updateWorkspaceMetrics();
        } else {
          showLibraryView();
        }
      }
    } catch (_) {}
  }

  function autoSizeTextarea(el) {
    if (!el || el.tagName !== 'TEXTAREA') return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  function autoSizeTextareas(root = document) {
    root.querySelectorAll('.prompt-textarea, .sub-field-box textarea').forEach(autoSizeTextarea);
  }

  function renderTopSwitcher() {
    const projects = state.library.projects || [];
    const countEl = $('topProjectCount');
    if (countEl) countEl.textContent = String(projects.length);

    const sel = $('quickProjectSwitcher');
    if (!sel) return;
    const opts = [
      `<option value="">⚡ Switch Project (${projects.length})...</option>`,
      ...projects.map((p) => {
        const st = calculateProjectStats(p);
        const label = `${p.videoName || 'Untitled Video'} (${st.completed}/${st.total})`;
        const selected = p.id === state.activeProjectId ? 'selected' : '';
        return `<option value="${escapeHtml(p.id)}" ${selected}>${escapeHtml(label)}</option>`;
      }),
    ];
    sel.innerHTML = opts.join('');
    sel.value = state.activeProjectId || '';
  }

  // --- Navigation ---
  function showLibraryView() {
    state.activeProjectId = null;
    state.focusedShotId = null;
    $('workspaceView').classList.remove('active');
    $('libraryView').classList.add('active');
    renderLibrary();
  }

  function openProjectWorkspace(projectId, focusNextIncomplete = false) {
    const proj = state.library.projects.find((p) => p.id === projectId);
    if (!proj) return;
    state.activeProjectId = proj.id;
    state.wsShotFilter = 'all';
    state.wsShotSearch = '';
    $('wsShotSearch').value = '';
    document.querySelectorAll('#wsShotFilterTabs .pill').forEach((b) => {
      b.classList.toggle('active', b.dataset.shotFilter === 'all');
    });

    const stats = calculateProjectStats(proj);
    state.focusedShotId = focusNextIncomplete && stats.nextIncomplete ? stats.nextIncomplete.id : null;

    $('libraryView').classList.remove('active');
    $('workspaceView').classList.add('active');
    renderWorkspace();

    if (state.focusedShotId) {
      setTimeout(() => scrollToShot(state.focusedShotId), 60);
    }
  }

  function scrollToShot(shotId) {
    const el = document.querySelector(`.shot-card[data-shot-id="${shotId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('shot-focus-ring');
    }
  }

  // --- Render: Library ---
  function renderLibrary() {
    renderTopSwitcher();
    const projects = state.library.projects || [];
    const totalProjects = projects.length;
    let totalShots = 0;
    let totalDone = 0;
    let totalCopied = 0;
    const topicsSet = new Set();

    projects.forEach((p) => {
      const st = calculateProjectStats(p);
      totalShots += st.total;
      totalDone += st.completed;
      totalCopied += st.copied;
      if (p.topic && p.topic.trim()) topicsSet.add(p.topic.trim());
    });

    $('libraryStats').innerHTML = `
      <div class="stat-card"><span>Projects</span><strong>${totalProjects}</strong></div>
      <div class="stat-card"><span>Total Shots</span><strong>${totalShots}</strong></div>
      <div class="stat-card"><span>Completed</span><strong style="color:#6ee7b7">${totalDone}</strong></div>
      <div class="stat-card"><span>In-Flight</span><strong style="color:#fcd34d">${totalCopied}</strong></div>
    `;

    // Populate Topic Dropdown
    const topicSelect = $('libTopicFilter');
    const prevTopic = state.libTopic;
    topicSelect.innerHTML = '<option value="all">All Topics</option>';
    Array.from(topicsSet)
      .sort((a, b) => a.localeCompare(b))
      .forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        topicSelect.appendChild(opt);
      });
    topicSelect.value = topicsSet.has(prevTopic) ? prevTopic : 'all';
    state.libTopic = topicSelect.value;

    const query = state.libSearch.trim().toLowerCase();
    let filtered = projects.filter((p) => {
      const st = calculateProjectStats(p);
      if (state.libFilter === 'in_progress' && !(st.completed > 0 && st.completed < st.total || st.copied > 0)) {
        return false;
      }
      if (state.libFilter === 'not_started' && (st.completed > 0 || st.copied > 0)) {
        return false;
      }
      if (state.libFilter === 'completed' && !(st.total > 0 && st.completed === st.total)) {
        return false;
      }
      if (state.libTopic !== 'all' && (p.topic || '').trim() !== state.libTopic) {
        return false;
      }
      if (query) {
        const hay = [
          p.videoName,
          p.topic,
          p.aiModel,
          ...(p.shots || []).map((s) => `${s.title} ${s.videoPrompt} ${s.imagePrompt} ${s.script}`),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      if (state.libSort === 'name') {
        return (a.videoName || '').localeCompare(b.videoName || '');
      }
      if (state.libSort === 'shots') {
        return (b.shots?.length || 0) - (a.shots?.length || 0);
      }
      if (state.libSort === 'progress') {
        return calculateProjectStats(b).pct - calculateProjectStats(a).pct;
      }
      return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
    });

    const grid = $('projectGrid');
    const empty = $('libraryEmpty');

    if (filtered.length === 0) {
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    grid.innerHTML = filtered
      .map((p) => {
        const st = calculateProjectStats(p);
        const isDone = st.total > 0 && st.completed === st.total;
        const resumeLabel = isDone
          ? 'Open Completed'
          : st.nextIncomplete
          ? `Resume (Shot #${st.nextIncomplete.seq})`
          : 'Open Project';

        const nextSnippet = st.nextIncomplete
          ? `<div class="next-shot-preview">
               <strong>Next up → Shot #${st.nextIncomplete.seq}${st.nextIncomplete.title ? `: ${escapeHtml(st.nextIncomplete.title)}` : ''}</strong>
               <span>${escapeHtml(st.nextIncomplete.videoPrompt || st.nextIncomplete.imagePrompt || '(No prompt text yet)')}</span>
             </div>`
          : `<div class="next-shot-preview" style="border-left-color: var(--green);">
               <strong>All ${st.total} shots completed!</strong>
               <span>Ready for final editing or export.</span>
             </div>`;

        return `
          <article class="project-card" data-project-id="${escapeHtml(p.id)}">
            <div class="project-card-top">
              <div>
                <h3>${escapeHtml(p.videoName || 'Untitled Video')}</h3>
                <div class="badges-row">
                  ${p.topic ? `<span class="badge badge-topic">🏷 ${escapeHtml(p.topic)}</span>` : ''}
                  ${p.aiModel ? `<span class="badge badge-model">🤖 ${escapeHtml(p.aiModel)}</span>` : ''}
                  <span class="badge badge-runtime">⏱ ${formatSecondsMMSS(st.totalSeconds)}${p.targetDuration ? ` / ${escapeHtml(p.targetDuration)}` : ''}</span>
                  ${isDone ? `<span class="badge badge-done">✓ Done</span>` : ''}
                </div>
              </div>
              <span style="font-size:11.5px; color: var(--text-dim); white-space:nowrap;">${formatRelativeTime(p.updatedAt)}</span>
            </div>

            <div>
              <div class="project-progress-row">
                <span><strong>${st.completed}</strong> / ${st.total} shots completed (${st.pct}%)</span>
                <span>${st.copied > 0 ? `<span style="color:#fcd34d">${st.copied} copied</span>` : `${st.pending} left`}</span>
              </div>
              <div class="progress-track">
                <div class="progress-fill" style="width:${st.pct}%"></div>
              </div>
            </div>

            ${nextSnippet}

            <div class="project-card-footer">
              <button class="btn btn-primary btn-sm" data-action="resume" data-id="${escapeHtml(p.id)}">
                ▶ ${resumeLabel}
              </button>
              <div class="card-mini-actions">
                <button class="btn btn-ghost btn-xs" data-action="duplicate" data-id="${escapeHtml(p.id)}" title="Duplicate Project">📄 Copy</button>
                <button class="btn btn-danger-ghost btn-xs" data-action="delete" data-id="${escapeHtml(p.id)}" title="Delete Project">🗑</button>
              </div>
            </div>
          </article>
        `;
      })
      .join('');
  }

  // --- Render: Workspace ---
  function renderWorkspace() {
    const proj = getActiveProject();
    if (!proj) return showLibraryView();

    $('wsVideoName').value = proj.videoName || '';
    $('wsTopic').value = proj.topic || '';
    $('wsAiModel').value = proj.aiModel || '';
    $('wsTargetDuration').value = proj.targetDuration || '';
    $('wsDefaultSec').value = proj.defaultShotSeconds || state.library.settings.defaultShotSeconds || 6;

    $('toggleAutoComplete').checked = !!state.library.settings.autoCompleteOnCopy;
    $('wsUseGlobalStyle').checked = !!proj.useGlobalStyle;
    $('wsStylePrefix').value = proj.stylePrefix || '';
    $('wsStyleSuffix').value = proj.styleSuffix || '';
    $('globalStyleBadge').classList.toggle('hidden', !proj.useGlobalStyle);

    updateWorkspaceMetrics();
    renderShotList();
  }

  function updateWorkspaceMetrics() {
    const proj = getActiveProject();
    if (!proj) return;
    const st = calculateProjectStats(proj);

    $('wsProgressText').textContent = `${st.completed} / ${st.total} (${st.pct}%)`;
    $('wsProgressBar').style.width = `${st.pct}%`;
    $('wsBreakdownText').textContent = `${st.copied} Copied · ${st.pending} Pending`;
    $('wsRuntimeValue').textContent = formatSecondsMMSS(st.totalSeconds);
    $('wsRuntimeTargetHint').textContent = proj.targetDuration
      ? `Target: ${proj.targetDuration} (${st.total} shots)`
      : `${st.total} shots total`;

    $('countAll').textContent = st.total;
    $('countPending').textContent = st.pending;
    $('countCopied').textContent = st.copied;
    $('countCompleted').textContent = st.completed;
    renderTopSwitcher();
  }

  function renderShotList() {
    const proj = getActiveProject();
    if (!proj) return;

    const shots = proj.shots || [];
    const q = state.wsShotSearch.trim().toLowerCase();

    const filtered = shots.filter((s) => {
      if (state.wsShotFilter === 'pending' && (s.completed || s.copied)) return false;
      if (state.wsShotFilter === 'copied' && (!s.copied || s.completed)) return false;
      if (state.wsShotFilter === 'completed' && !s.completed) return false;
      if (q) {
        const hay = `${s.seq} ${s.title} ${s.videoPrompt} ${s.imagePrompt} ${s.script} ${s.notes}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const container = $('shotList');
    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🎬</div>
          <h2>No shots match this filter</h2>
          <p>Switch back to "All Shots" or add a new shot below.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered
      .map((s, idxInView) => {
        const stateClass = s.completed ? 'state-completed' : s.copied ? 'state-copied' : '';
        const focusClass = state.focusedShotId === s.id ? 'shot-focus-ring' : '';
        const statusBadge = s.completed
          ? `<div class="status-pill status-completed">✓ Completed</div>`
          : s.copied
          ? `<div class="status-pill status-copied">📋 Copied</div>`
          : `<div class="status-pill status-pending">○ Pending</div>`;

        const copiedNote = s.copiedAt
          ? `<div class="copied-time-note">Copied ${formatRelativeTime(s.copiedAt)}</div>`
          : '';

        const hasImage = !!(s.imagePrompt && s.imagePrompt.trim()) || !!s._showImage;
        const hasScript = !!(s.script && s.script.trim()) || !!s._showScript;
        const hasNotes = !!(s.notes && s.notes.trim()) || !!s._showNotes;

        const secondaryBlocks = [];
        if (hasImage) {
          secondaryBlocks.push(`
            <div class="sub-field-box">
              <div class="prompt-box-header">
                <span class="prompt-label img-lbl">🖼 Image / First-Frame Prompt</span>
                <button class="btn btn-ghost btn-xs" data-shot-action="copy-image" data-shot-id="${escapeHtml(s.id)}">
                  ${s.imageCopied ? '✓ Image Copied' : '📋 Copy Image'}
                </button>
              </div>
              <textarea data-shot-field="imagePrompt" data-shot-id="${escapeHtml(s.id)}" placeholder="Image / keyframe generation prompt...">${escapeHtml(s.imagePrompt || '')}</textarea>
            </div>
          `);
        }
        if (hasScript) {
          secondaryBlocks.push(`
            <div class="sub-field-box">
              <div class="prompt-box-header">
                <span class="prompt-label script-lbl">🎙 Script / Voiceover</span>
                <button class="btn btn-ghost btn-xs" data-shot-action="copy-script" data-shot-id="${escapeHtml(s.id)}">📋 Copy VO</button>
              </div>
              <textarea data-shot-field="script" data-shot-id="${escapeHtml(s.id)}" placeholder="Narration or dialogue line for this shot...">${escapeHtml(s.script || '')}</textarea>
            </div>
          `);
        }
        if (hasNotes) {
          secondaryBlocks.push(`
            <div class="sub-field-box">
              <div class="prompt-box-header">
                <span class="prompt-label notes-lbl">📝 Camera / Production Notes</span>
              </div>
              <textarea data-shot-field="notes" data-shot-id="${escapeHtml(s.id)}" placeholder="Motion settings, seed, lens notes...">${escapeHtml(s.notes || '')}</textarea>
            </div>
          `);
        }

        const addPills = [];
        if (!hasImage) addPills.push(`<button class="mini-add-pill" data-shot-action="reveal" data-reveal="_showImage" data-shot-id="${escapeHtml(s.id)}">+ Image Prompt</button>`);
        if (!hasScript) addPills.push(`<button class="mini-add-pill" data-shot-action="reveal" data-reveal="_showScript" data-shot-id="${escapeHtml(s.id)}">+ Script / VO</button>`);
        if (!hasNotes) addPills.push(`<button class="mini-add-pill" data-shot-action="reveal" data-reveal="_showNotes" data-shot-id="${escapeHtml(s.id)}">+ Notes</button>`);

        return `
          <article class="shot-card ${stateClass} ${focusClass}" data-shot-id="${escapeHtml(s.id)}">
            <div class="shot-seq-col">
              <div class="seq-badge">SHOT ${String(s.seq).padStart(2, '0')}</div>
              <input class="dur-input" type="text" value="${escapeHtml(s.duration || '')}" placeholder="6s" title="Shot Duration (e.g. 6s, 8s)" data-shot-field="duration" data-shot-id="${escapeHtml(s.id)}" />
              <div class="seq-controls">
                <button class="seq-btn" data-shot-action="move-up" data-shot-id="${escapeHtml(s.id)}" title="Move Shot Up">↑</button>
                <button class="seq-btn" data-shot-action="move-down" data-shot-id="${escapeHtml(s.id)}" title="Move Shot Down">↓</button>
                <button class="seq-btn" data-shot-action="insert-below" data-shot-id="${escapeHtml(s.id)}" title="Insert New Shot Below">＋</button>
                <button class="seq-btn del" data-shot-action="delete" data-shot-id="${escapeHtml(s.id)}" title="Delete Shot">🗑</button>
              </div>
            </div>

            <div class="shot-main-col">
              <div class="shot-title-row">
                <input class="shot-title-input" type="text" value="${escapeHtml(s.title || '')}" placeholder="Scene / Shot Title..." data-shot-field="title" data-shot-id="${escapeHtml(s.id)}" />
              </div>

              <div class="prompt-box">
                <div class="prompt-box-header">
                  <span class="prompt-label">🎥 Video Prompt</span>
                  <div class="prompt-actions">
                    <button class="btn btn-primary btn-xs" data-shot-action="copy-video" data-shot-id="${escapeHtml(s.id)}">
                      ${s.copied ? '📋 Copy Again' : '📋 Copy Prompt'}
                    </button>
                    <button class="btn btn-secondary btn-xs" data-shot-action="copy-advance" data-shot-id="${escapeHtml(s.id)}" title="Copy this prompt and jump to next incomplete shot">
                      ⚡ Copy &amp; Next
                    </button>
                  </div>
                </div>
                <textarea class="prompt-textarea" data-shot-field="videoPrompt" data-shot-id="${escapeHtml(s.id)}" placeholder="Write or paste your AI video generation prompt here...">${escapeHtml(s.videoPrompt || '')}</textarea>
              </div>

              ${secondaryBlocks.length ? `<div class="secondary-fields-grid">${secondaryBlocks.join('')}</div>` : ''}
              ${addPills.length ? `<div class="add-optional-pills">${addPills.join('')}</div>` : ''}
            </div>

            <div class="shot-status-col">
              <div>
                ${statusBadge}
                ${copiedNote}
              </div>

              <label class="complete-checkbox-card">
                <input type="checkbox" ${s.completed ? 'checked' : ''} data-shot-action="toggle-complete" data-shot-id="${escapeHtml(s.id)}" />
                <span>${s.completed ? 'Completed' : 'Mark Done'}</span>
              </label>
            </div>
          </article>
        `;
      })
      .join('');
    autoSizeTextareas(container);
  }

  function composeCopyableVideoPrompt(proj, shot) {
    const base = (shot.videoPrompt || '').trim();
    if (!base) return '';
    if (!proj.useGlobalStyle) return base;
    const pre = (proj.stylePrefix || '').trim();
    const suf = (proj.styleSuffix || '').trim();
    return [pre, base, suf].filter(Boolean).join(' ');
  }

  async function handleCopyVideoPrompt(proj, shot, advanceAfter = false) {
    const finalPrompt = composeCopyableVideoPrompt(proj, shot);
    if (!finalPrompt) {
      showToast('This shot has no Video Prompt text to copy.', 'warn');
      return;
    }
    const ok = await copyTextToClipboard(finalPrompt);
    if (!ok) {
      showToast('Clipboard blocked by browser permissions.', 'err');
      return;
    }
    shot.copied = true;
    shot.copiedAt = new Date().toISOString();
    if (state.library.settings.autoCompleteOnCopy) {
      shot.completed = true;
    }
    state.focusedShotId = shot.id;
    scheduleSaveLibrary(proj);

    if (advanceAfter) {
      const idx = proj.shots.findIndex((x) => x.id === shot.id);
      const next =
        proj.shots.slice(idx + 1).find((x) => !x.completed) ||
        proj.shots.find((x) => !x.completed && x.id !== shot.id);
      if (next) {
        state.focusedShotId = next.id;
        renderWorkspace();
        setTimeout(() => scrollToShot(next.id), 40);
        showToast(`Copied Shot #${shot.seq} → Jumped to Shot #${next.seq}`);
        return;
      }
    }

    renderWorkspace();
    showToast(
      state.library.settings.autoCompleteOnCopy
        ? `Copied & marked Shot #${shot.seq} completed!`
        : `Copied Shot #${shot.seq} prompt!`
    );
  }

  function renumberShots(proj) {
    (proj.shots || []).forEach((s, i) => {
      s.seq = i + 1;
    });
  }

  function createEmptyShot(seq) {
    return {
      id: uid('shot'),
      seq,
      title: `Shot ${seq}`,
      duration: '6s',
      script: '',
      imagePrompt: '',
      videoPrompt: '',
      notes: '',
      copied: false,
      copiedAt: null,
      imageCopied: false,
      completed: false,
    };
  }

  // --- Intelligent Import & Parsing Engine ---
  const FIELD_LABELS = {
    ignore: '— Ignore Column —',
    seq: 'Sequence #',
    title: 'Scene / Shot Title',
    videoPrompt: 'Video Prompt',
    imagePrompt: 'Image / Keyframe Prompt',
    script: 'Script / Voiceover',
    duration: 'Duration',
    notes: 'Notes',
  };

  function guessColumnRole(headerText) {
    const h = String(headerText || '').trim().toLowerCase();
    if (!h) return 'ignore';
    if (/^(#|no\.?|num|seq|sequence|shot\s*#|shot\s*no|shot\s*number|sl\.?\s*no)$/.test(h)) return 'seq';
    if (/^(shot|scene)$/.test(h)) return 'seq';
    if (/(video\s*prompt|motion\s*prompt|kling|runway|sora|veo|animation\s*prompt|^prompt$)/.test(h)) return 'videoPrompt';
    if (/(image\s*prompt|keyframe|first\s*frame|start\s*frame|midjourney|still\s*prompt|visual\s*prompt)/.test(h)) return 'imagePrompt';
    if (/(script|voice\s*over|\bvo\b|narration|dialogue|audio|caption|subtitle)/.test(h)) return 'script';
    if (/(duration|length|time|sec|seconds|runtime)/.test(h)) return 'duration';
    if (/(title|scene\s*name|shot\s*name|scene\s*title|heading|location)/.test(h)) return 'title';
    if (/(note|camera|comment|direction|instruction|setting)/.test(h)) return 'notes';
    return 'ignore';
  }

  function extractMetadataFromLines(lines) {
    let videoName = '';
    let topic = '';
    let aiModel = '';
    let targetDuration = '';
    const consumedIndices = new Set();

    lines.forEach((line, idx) => {
      const s = String(line || '').trim();
      if (!s) return;
      let m;
      if ((m = s.match(/^(?:video\s*name|video\s*title|project\s*name|project|title)\s*[:\-–]\s*(.+)$/i))) {
        if (!videoName) videoName = m[1].trim();
        consumedIndices.add(idx);
      } else if ((m = s.match(/^(?:topic|theme|category|subject|niche)\s*[:\-–]\s*(.+)$/i))) {
        if (!topic) topic = m[1].trim();
        consumedIndices.add(idx);
      } else if ((m = s.match(/^(?:ai\s*model|model|tool|generator)\s*[:\-–]\s*(.+)$/i))) {
        if (!aiModel) aiModel = m[1].trim();
        consumedIndices.add(idx);
      } else if ((m = s.match(/^(?:target\s*duration|target\s*runtime|video\s*length|total\s*duration)\s*[:\-–]\s*(.+)$/i))) {
        if (!targetDuration) targetDuration = m[1].trim();
        consumedIndices.add(idx);
      }
    });

    return { videoName, topic, aiModel, targetDuration, consumedIndices };
  }

  function analyzeTabularRows(rows, fallbackFilename) {
    if (!rows || rows.length === 0) {
      throw new Error('The table appears to be empty.');
    }

    let videoName = '';
    let topic = '';
    let aiModel = '';
    let targetDuration = '';

    // Inspect top rows (up to 8) for key-value metadata rows AND best header row
    let bestHeaderIdx = -1;
    let bestScore = 0;

    const scanLimit = Math.min(10, rows.length);
    for (let r = 0; r < scanLimit; r++) {
      const row = rows[r].map((c) => String(c || '').trim());
      const nonEmpty = row.filter(Boolean);
      if (nonEmpty.length === 0) continue;

      // Key-value metadata row like ["Video Name", "My Video"]
      if (nonEmpty.length <= 2) {
        const k = nonEmpty[0].toLowerCase();
        const v = nonEmpty[1] || '';
        if (/^(video\s*name|video\s*title|project\s*name|title)$/.test(k) && v) {
          videoName = v;
          continue;
        }
        if (/^(topic|theme|category|subject|niche)$/.test(k) && v) {
          topic = v;
          continue;
        }
        if (/^(ai\s*model|model|tool)$/.test(k) && v) {
          aiModel = v;
          continue;
        }
        if (/^(target\s*duration|target\s*runtime|duration|length)$/.test(k) && v) {
          targetDuration = v;
          continue;
        }
      }

      // Score row as potential table header
      let score = 0;
      row.forEach((cell) => {
        if (guessColumnRole(cell) !== 'ignore') score += 2;
      });
      if (nonEmpty.length >= 2 && score > bestScore) {
        bestScore = score;
        bestHeaderIdx = r;
      }
    }

    // Check single-cell metadata lines above header if not yet found
    if (bestHeaderIdx > 0) {
      const preLines = rows.slice(0, bestHeaderIdx).map((r) => r.filter(Boolean).join(': '));
      const meta = extractMetadataFromLines(preLines);
      if (!videoName && meta.videoName) videoName = meta.videoName;
      if (!topic && meta.topic) topic = meta.topic;
      if (!aiModel && meta.aiModel) aiModel = meta.aiModel;
      if (!targetDuration && meta.targetDuration) targetDuration = meta.targetDuration;
    }

    const colCount = Math.max(...rows.map((r) => r.length));
    let headers;
    let dataStartRow;

    if (bestHeaderIdx >= 0 && bestScore >= 2) {
      headers = Array.from({ length: colCount }, (_, i) => String(rows[bestHeaderIdx][i] || `Column ${i + 1}`).trim());
      dataStartRow = bestHeaderIdx + 1;
    } else {
      headers = Array.from({ length: colCount }, (_, i) => `Column ${i + 1}`);
      dataStartRow = 0;
    }

    // Auto-map columns
    const mapping = headers.map((h) => guessColumnRole(h));
    // Fallback heuristic if no videoPrompt column detected
    if (!mapping.includes('videoPrompt')) {
      const sampleRows = rows.slice(dataStartRow, dataStartRow + 6);
      let longestCol = -1;
      let maxAvgLen = 0;
      for (let c = 0; c < colCount; c++) {
        if (mapping[c] !== 'ignore') continue;
        const avg =
          sampleRows.reduce((sum, r) => sum + String(r[c] || '').length, 0) /
          Math.max(1, sampleRows.length);
        if (avg > maxAvgLen) {
          maxAvgLen = avg;
          longestCol = c;
        }
      }
      if (longestCol >= 0) mapping[longestCol] = 'videoPrompt';
    }

    return {
      videoName: videoName || cleanFilenameTitle(fallbackFilename),
      topic,
      aiModel,
      targetDuration,
      headers,
      mapping,
      dataRows: rows.slice(dataStartRow),
    };
  }

  function buildShotsFromMapping(dataRows, mapping) {
    const shots = [];
    let autoSeq = 1;
    dataRows.forEach((row) => {
      const obj = createEmptyShot(autoSeq);
      let hasAnyText = false;
      mapping.forEach((role, colIdx) => {
        if (role === 'ignore') return;
        const val = String(row[colIdx] || '').trim();
        if (!val) return;
        if (role === 'seq') {
          const num = parseInt(val.replace(/[^\d]/g, ''), 10);
          if (!Number.isNaN(num) && num > 0) obj.seq = num;
        } else {
          obj[role] = val;
          hasAnyText = true;
        }
      });
      if (hasAnyText) {
        if (!obj.title || obj.title === `Shot ${autoSeq}`) {
          obj.title = obj.title && obj.title !== '' ? obj.title : `Shot ${obj.seq}`;
        }
        shots.push(obj);
        autoSeq += 1;
      }
    });

    // Sort by extracted sequence if valid, then normalize 1..N cleanly
    shots.sort((a, b) => a.seq - b.seq);
    shots.forEach((s, i) => {
      s.seq = i + 1;
      if (!s.title) s.title = `Shot ${s.seq}`;
    });
    return shots;
  }

  function parseUnstructuredTextToShots(rawText, fallbackFilename) {
    const normalized = String(rawText || '').replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');

    // Check if tab-separated (copied from Excel / Google Sheets!)
    const tabRows = lines
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);
    const tsvCount = tabRows.filter((l) => l.includes('\t')).length;
    if (tabRows.length >= 2 && tsvCount >= Math.floor(tabRows.length * 0.6)) {
      const table = tabRows.map((l) => l.split('\t').map((c) => c.trim()));
      const analyzed = analyzeTabularRows(table, fallbackFilename);
      return {
        isTabular: true,
        ...analyzed,
        shots: buildShotsFromMapping(analyzed.dataRows, analyzed.mapping),
      };
    }

    const meta = extractMetadataFromLines(lines);
    let videoName = meta.videoName;
    let topic = meta.topic;
    let aiModel = meta.aiModel;
    let targetDuration = meta.targetDuration;

    // Split into shot blocks using strong shot header patterns
    const shotStartRegex = /^(?:#{1,4}\s*)?(?:\[?\s*(?:shot|scene|clip)\s*#?\s*(\d+)\s*\]?|\b(\d{1,3})[\.)]\s+)(?:[:\-–—|]\s*(.*))?$/i;

    const blocks = [];
    let current = null;

    lines.forEach((rawLine, idx) => {
      if (meta.consumedIndices.has(idx)) return;
      const line = rawLine.trim();
      if (!line) return;

      // If no videoName yet and first non-meta line looks like a heading
      if (!videoName && blocks.length === 0 && !current && !shotStartRegex.test(line)) {
        if (/^#{1,3}\s+/.test(line) || line.length < 90) {
          videoName = line.replace(/^#{1,3}\s+/, '').trim();
          return;
        }
      }

      const m = line.match(shotStartRegex);
      if (m) {
        if (current) blocks.push(current);
        const seqNum = parseInt(m[1] || m[2], 10);
        const tail = (m[3] || '').trim();
        current = {
          seq: Number.isNaN(seqNum) ? blocks.length + 1 : seqNum,
          title: tail,
          lines: [],
        };
      } else {
        if (!current) {
          current = { seq: blocks.length + 1, title: '', lines: [] };
        }
        current.lines.push(line);
      }
    });
    if (current) blocks.push(current);

    // If only 1 giant block with paragraph breaks, split by blank lines as fallback
    if (blocks.length <= 1 && normalized.includes('\n\n')) {
      const chunks = normalized
        .split(/\n\s*\n+/)
        .map((c) => c.trim())
        .filter((c) => c.length > 0 && !/^(?:video\s*name|topic|ai\s*model|target\s*duration)\s*[:\-–]/i.test(c));
      if (chunks.length >= 2) {
        blocks.length = 0;
        chunks.forEach((chunk, i) => {
          const chunkLines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
          blocks.push({ seq: i + 1, title: '', lines: chunkLines });
        });
      }
    }

    const shots = blocks
      .map((blk, idx) => {
        const shot = createEmptyShot(idx + 1);
        shot.seq = blk.seq || idx + 1;
        shot.title = blk.title || '';

        let activeKey = null;
        const looseLines = [];

        blk.lines.forEach((l) => {
          let fm;
          if ((fm = l.match(/^(?:duration|time|length)\s*[:\-–]\s*(.+)$/i))) {
            shot.duration = fm[1].trim();
            activeKey = null;
          } else if ((fm = l.match(/^(?:scene\s*title|shot\s*title|title|scene)\s*[:\-–]\s*(.+)$/i))) {
            shot.title = fm[1].trim();
            activeKey = null;
          } else if ((fm = l.match(/^(?:script|voice\s*over|vo|narration|dialogue)\s*[:\-–]\s*(.*)$/i))) {
            shot.script = fm[1].trim();
            activeKey = 'script';
          } else if ((fm = l.match(/^(?:image\s*prompt|keyframe\s*prompt|first\s*frame|still\s*prompt)\s*[:\-–]\s*(.*)$/i))) {
            shot.imagePrompt = fm[1].trim();
            activeKey = 'imagePrompt';
          } else if ((fm = l.match(/^(?:video\s*prompt|motion\s*prompt|prompt)\s*[:\-–]\s*(.*)$/i))) {
            shot.videoPrompt = fm[1].trim();
            activeKey = 'videoPrompt';
          } else if ((fm = l.match(/^(?:notes?|camera|direction)\s*[:\-–]\s*(.*)$/i))) {
            shot.notes = fm[1].trim();
            activeKey = 'notes';
          } else if (activeKey) {
            shot[activeKey] = shot[activeKey] ? `${shot[activeKey]}\n${l}` : l;
          } else {
            looseLines.push(l);
          }
        });

        if (!shot.videoPrompt && looseLines.length > 0) {
          shot.videoPrompt = looseLines.join(' ');
        } else if (!shot.videoPrompt && shot.title && shot.title.length > 45) {
          shot.videoPrompt = shot.title;
          shot.title = `Shot ${shot.seq}`;
        }

        if (!shot.title) shot.title = `Shot ${shot.seq}`;
        return shot;
      })
      .filter((s) => s.videoPrompt || s.imagePrompt || s.script || (s.title && !/^Shot \d+$/.test(s.title)));

    shots.sort((a, b) => a.seq - b.seq);
    shots.forEach((s, i) => {
      s.seq = i + 1;
    });

    return {
      isTabular: false,
      videoName: videoName || cleanFilenameTitle(fallbackFilename),
      topic,
      aiModel,
      targetDuration,
      shots,
    };
  }

  function parseCsvString(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuotes) {
        if (ch === '"' && s[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cell += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          row.push(cell);
          cell = '';
        } else if (ch === '\n') {
          row.push(cell);
          if (row.some((c) => c.trim() !== '')) rows.push(row);
          row = [];
          cell = '';
        } else {
          cell += ch;
        }
      }
    }
    row.push(cell);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    return rows;
  }

  // --- Import Modal Flow ---
  function openImportModal(mode = 'file', appendToProjectId = null) {
    state.importContext = {
      appendToProjectId,
      rawTableRows: null,
      headers: null,
      columnMapping: null,
      previewShots: [],
      sourceFilename: '',
    };
    $('importErrorBox').classList.add('hidden');
    $('importStepInput').classList.remove('hidden');
    $('importStepPreview').classList.add('hidden');
    $('importModalTitle').textContent = appendToProjectId
      ? 'Import More Shots Into Current Project'
      : 'Import Video Prompts (.xlsx / .docx / Paste)';
    switchImportMode(mode);
    $('importModal').classList.remove('hidden');
  }

  function closeImportModal() {
    $('importModal').classList.add('hidden');
  }

  function switchImportMode(mode) {
    $('tabModeFile').classList.toggle('active', mode === 'file');
    $('tabModePaste').classList.toggle('active', mode === 'paste');
    $('panelFileUpload').classList.toggle('hidden', mode !== 'file');
    $('panelRawPaste').classList.toggle('hidden', mode !== 'paste');
    $('importErrorBox').classList.add('hidden');
  }

  function showImportError(msg) {
    const box = $('importErrorBox');
    box.textContent = msg;
    box.classList.remove('hidden');
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = String(reader.result || '');
        const comma = res.indexOf(',');
        resolve(comma >= 0 ? res.slice(comma + 1) : res);
      };
      reader.onerror = () => reject(new Error('Could not read file.'));
      reader.readAsDataURL(file);
    });
  }

  async function processUploadedFile(file) {
    $('importErrorBox').classList.add('hidden');
    const name = file.name;
    const ext = name.split('.').pop().toLowerCase();

    try {
      if (ext === 'csv') {
        const text = await file.text();
        const rows = parseCsvString(text);
        const analyzed = analyzeTabularRows(rows, name);
        enterImportPreview({
          isTabular: true,
          sourceFilename: name,
          ...analyzed,
          shots: buildShotsFromMapping(analyzed.dataRows, analyzed.mapping),
        });
        return;
      }

      if (ext === 'txt' || ext === 'md') {
        const text = await file.text();
        const parsed = parseUnstructuredTextToShots(text, name);
        enterImportPreview({ sourceFilename: name, ...parsed });
        return;
      }

      if (ext === 'xlsx' || ext === 'docx') {
        let data = null;
        if (state.hasBackend) {
          try {
            const base64 = await fileToBase64(file);
            const resp = await fetch('/api/parse-file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filename: name, base64 }),
            });
            const ct = resp.headers.get('content-type') || '';
            if (resp.ok && ct.includes('application/json')) {
              data = await resp.json();
            }
          } catch (_) {
            data = null;
          }
        }

        if (!data) {
          // Pure-browser ZIP/XML fallback (works completely offline & on static hosts)
          data = ext === 'xlsx' ? await parseXlsxInBrowser(file) : await parseDocxInBrowser(file);
        }

        if (data.error) {
          throw new Error(data.error || 'Failed to parse file.');
        }

        if (data.type === 'xlsx') {
          const analyzed = analyzeTabularRows(data.rows || [], name);
          enterImportPreview({
            isTabular: true,
            sourceFilename: name,
            ...analyzed,
            shots: buildShotsFromMapping(analyzed.dataRows, analyzed.mapping),
          });
        } else if (data.type === 'docx') {
          // If docx has a multi-row table and few loose paragraphs outside it, use table!
          const tables = data.tables || [];
          const paras = (data.paragraphs || []).map((p) => (typeof p === 'string' ? p : p.text));
          const biggestTable = tables.slice().sort((a, b) => b.length - a.length)[0];

          if (biggestTable && biggestTable.length >= 2) {
            const meta = extractMetadataFromLines(paras);
            const analyzed = analyzeTabularRows(biggestTable, name);
            if (meta.videoName) analyzed.videoName = meta.videoName;
            if (meta.topic) analyzed.topic = meta.topic;
            if (meta.aiModel) analyzed.aiModel = meta.aiModel;
            if (meta.targetDuration) analyzed.targetDuration = meta.targetDuration;
            enterImportPreview({
              isTabular: true,
              sourceFilename: name,
              ...analyzed,
              shots: buildShotsFromMapping(analyzed.dataRows, analyzed.mapping),
            });
          } else {
            const parsed = parseUnstructuredTextToShots(paras.join('\n'), name);
            enterImportPreview({ sourceFilename: name, ...parsed });
          }
        }
        return;
      }

      throw new Error(`Unsupported file format ".${ext}". Please upload .xlsx, .docx, .csv, or .txt.`);
    } catch (err) {
      showImportError(err.message || 'Unable to parse file.');
    }
  }

  // --- Pure-Browser ZIP / XLSX / DOCX Parser (Offline & Static Hosting Fallback) ---
  async function inflateRawBytes(u8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot decompress .xlsx/.docx offline without the local server.');
    }
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(u8);
    writer.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function parseZipEntriesInBrowser(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);

    // Find End of Central Directory (0x06054b50)
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Invalid Office OpenXML ZIP archive.');

    const cdCount = view.getUint16(eocd + 10, true);
    let ptr = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder('utf-8');
    const entries = new Map();

    for (let idx = 0; idx < cdCount; idx++) {
      if (view.getUint32(ptr, true) !== 0x02014b50) break;
      const method = view.getUint16(ptr + 10, true);
      const compSize = view.getUint32(ptr + 20, true);
      const nameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);
      const localOffset = view.getUint32(ptr + 42, true);
      const entryName = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen)).replace(/\\/g, '/');
      ptr += 46 + nameLen + extraLen + commentLen;

      if (view.getUint32(localOffset, true) !== 0x04034b50) continue;
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const compBytes = bytes.subarray(dataStart, dataStart + compSize);

      let outBytes;
      if (method === 0) outBytes = compBytes;
      else if (method === 8) outBytes = await inflateRawBytes(compBytes);
      else continue;

      entries.set(entryName.toLowerCase(), decoder.decode(outBytes));
    }
    return entries;
  }

  function excelColToIdx(letters) {
    let col = 0;
    for (const ch of letters.toUpperCase()) {
      const code = ch.charCodeAt(0);
      if (code >= 65 && code <= 90) col = col * 26 + (code - 64);
    }
    return Math.max(0, col - 1);
  }

  async function parseXlsxInBrowser(file) {
    const entries = await parseZipEntriesInBrowser(file);
    const parser = new DOMParser();

    const sharedStrings = [];
    const sstText = entries.get('xl/sharedstrings.xml');
    if (sstText) {
      const sstDoc = parser.parseFromString(sstText, 'application/xml');
      sstDoc.querySelectorAll('si').forEach((si) => {
        let txt = '';
        si.querySelectorAll('t').forEach((t) => {
          txt += t.textContent || '';
        });
        sharedStrings.push(txt);
      });
    }

    const sheetKeys = Array.from(entries.keys())
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort((a, b) => {
        const na = parseInt(a.match(/(\d+)/)?.[1] || '999', 10);
        const nb = parseInt(b.match(/(\d+)/)?.[1] || '999', 10);
        return na - nb;
      });

    if (sheetKeys.length === 0) throw new Error('No worksheet found in .xlsx file.');
    const sheetDoc = parser.parseFromString(entries.get(sheetKeys[0]), 'application/xml');
    const rows = [];

    sheetDoc.querySelectorAll('sheetData > row').forEach((rowEl) => {
      const map = new Map();
      let maxCol = -1;
      let fallback = 0;
      rowEl.querySelectorAll('c').forEach((cEl) => {
        const ref = cEl.getAttribute('r') || '';
        const letters = ref.match(/^([A-Za-z]+)/)?.[1];
        const colIdx = letters ? excelColToIdx(letters) : fallback;
        fallback = colIdx + 1;
        if (colIdx > maxCol) maxCol = colIdx;

        const tAttr = cEl.getAttribute('t');
        let val = '';
        if (tAttr === 's') {
          const idx = parseInt(cEl.querySelector('v')?.textContent || '-1', 10);
          if (idx >= 0 && idx < sharedStrings.length) val = sharedStrings[idx];
        } else if (tAttr === 'inlineStr') {
          cEl.querySelectorAll('t').forEach((t) => {
            val += t.textContent || '';
          });
        } else if (tAttr === 'b') {
          val = cEl.querySelector('v')?.textContent === '1' ? 'TRUE' : 'FALSE';
        } else {
          val = cEl.querySelector('v')?.textContent || '';
          if (!val) {
            cEl.querySelectorAll('t').forEach((t) => {
              val += t.textContent || '';
            });
          }
        }
        map.set(colIdx, val);
      });

      if (maxCol >= 0) {
        const arr = Array.from({ length: maxCol + 1 }, (_, i) => map.get(i) || '');
        if (arr.some((v) => v.trim() !== '')) rows.push(arr);
      }
    });

    return { type: 'xlsx', rows };
  }

  async function parseDocxInBrowser(file) {
    const entries = await parseZipEntriesInBrowser(file);
    const docText = entries.get('word/document.xml');
    if (!docText) throw new Error('word/document.xml not found inside .docx file.');
    const doc = new DOMParser().parseFromString(docText, 'application/xml');
    const body = doc.getElementsByTagNameNS('*', 'body')[0] || doc.querySelector('body');

    const getParaText = (pNode) => {
      let out = '';
      pNode.childNodes.forEach((ch) => {
        const ln = ch.localName;
        if (ln === 'r') {
          ch.childNodes.forEach((rc) => {
            if (rc.localName === 't' || rc.localName === 'delText') out += rc.textContent || '';
            else if (rc.localName === 'br' || rc.localName === 'cr') out += '\n';
            else if (rc.localName === 'tab') out += '\t';
          });
        } else if (ln === 'hyperlink') {
          const ts = ch.getElementsByTagNameNS('*', 't');
          for (const t of ts) out += t.textContent || '';
        }
      });
      return out.trim();
    };

    const paragraphs = [];
    const tables = [];

    if (body) {
      body.childNodes.forEach((node) => {
        if (node.localName === 'p') {
          const t = getParaText(node);
          if (t) paragraphs.push({ text: t, style: '' });
        } else if (node.localName === 'tbl') {
          const tblRows = [];
          const trs = Array.from(node.childNodes).filter((c) => c.localName === 'tr');
          trs.forEach((tr) => {
            const cells = [];
            let has = false;
            const tcs = Array.from(tr.childNodes).filter((c) => c.localName === 'tc');
            tcs.forEach((tc) => {
              const ps = Array.from(tc.childNodes).filter((c) => c.localName === 'p');
              const txt = ps.map(getParaText).filter(Boolean).join('\n').trim();
              if (txt) has = true;
              cells.push(txt);
            });
            if (has) tblRows.push(cells);
          });
          if (tblRows.length > 0) tables.push(tblRows);
        }
      });
    }

    return { type: 'docx', paragraphs, tables };
  }

  async function loadSampleFromServer(samplePath, filename) {
    try {
      const resp = await fetch(samplePath);
      if (!resp.ok) throw new Error('Sample file not found.');
      const blob = await resp.blob();
      const file = new File([blob], filename, { type: blob.type });
      await processUploadedFile(file);
    } catch (err) {
      showImportError(err.message);
    }
  }

  function enterImportPreview(parsed) {
    state.importContext.sourceFilename = parsed.sourceFilename || 'Imported Prompts';
    state.importContext.rawTableRows = parsed.isTabular ? parsed.dataRows : null;
    state.importContext.headers = parsed.isTabular ? parsed.headers : null;
    state.importContext.columnMapping = parsed.isTabular ? parsed.mapping : null;
    state.importContext.previewShots = parsed.shots || [];

    const existingProj = state.importContext.appendToProjectId
      ? state.library.projects.find((p) => p.id === state.importContext.appendToProjectId)
      : null;

    $('prevVideoName').value = existingProj ? existingProj.videoName : parsed.videoName || '';
    $('prevTopic').value = existingProj ? existingProj.topic : parsed.topic || '';
    $('prevAiModel').value = existingProj ? existingProj.aiModel : parsed.aiModel || '';
    $('prevTargetDuration').value = existingProj ? existingProj.targetDuration : parsed.targetDuration || '8:00';

    $('prevVideoName').disabled = !!existingProj;
    $('prevTopic').disabled = !!existingProj;

    renderColumnMapper();
    renderPreviewTable();

    $('importStepInput').classList.add('hidden');
    $('importStepPreview').classList.remove('hidden');
  }

  function renderColumnMapper() {
    const bar = $('columnMapperBar');
    const grid = $('mapperDropdowns');
    if (!state.importContext.rawTableRows || !state.importContext.columnMapping) {
      bar.classList.add('hidden');
      grid.innerHTML = '';
      return;
    }
    bar.classList.remove('hidden');
    const headers = state.importContext.headers || [];
    const mapping = state.importContext.columnMapping;

    grid.innerHTML = mapping
      .map((role, idx) => {
        const opts = Object.entries(FIELD_LABELS)
          .map(([k, lbl]) => `<option value="${k}" ${k === role ? 'selected' : ''}>${lbl}</option>`)
          .join('');
        return `
          <div class="mapper-item">
            <label title="${escapeHtml(headers[idx] || '')}">${escapeHtml(headers[idx] || `Column ${idx + 1}`)}</label>
            <select data-map-col="${idx}">${opts}</select>
          </div>
        `;
      })
      .join('');
  }

  function renderPreviewTable() {
    const shots = state.importContext.previewShots;
    $('prevShotCountLabel').textContent = `Detected ${shots.length} Shot${shots.length === 1 ? '' : 's'}`;
    const totalSec = shots.reduce((acc, s) => acc + parseDurationSeconds(s.duration, 6), 0);
    $('previewFooterNote').textContent = `Estimated total video runtime: ${formatSecondsMMSS(totalSec)}`;

    const tbody = $('previewTableBody');
    tbody.innerHTML = shots
      .map(
        (s, i) => `
      <tr data-prev-idx="${i}">
        <td><input type="number" min="1" value="${s.seq}" data-prev-field="seq" /></td>
        <td><input type="text" value="${escapeHtml(s.title)}" data-prev-field="title" /></td>
        <td><input type="text" value="${escapeHtml(s.duration)}" data-prev-field="duration" /></td>
        <td><textarea data-prev-field="videoPrompt">${escapeHtml(s.videoPrompt)}</textarea></td>
        <td><textarea data-prev-field="imagePrompt">${escapeHtml(s.imagePrompt)}</textarea></td>
        <td><textarea data-prev-field="script">${escapeHtml(s.script)}</textarea></td>
        <td><textarea data-prev-field="notes">${escapeHtml(s.notes)}</textarea></td>
        <td><button type="button" class="btn btn-danger-ghost btn-xs" data-prev-del="${i}" title="Remove Row">✕</button></td>
      </tr>
    `
      )
      .join('');
  }

  function confirmImportProject() {
    const shots = state.importContext.previewShots
      .map((s, idx) => ({
        ...createEmptyShot(idx + 1),
        ...s,
        seq: Number(s.seq) || idx + 1,
        id: uid('shot'),
      }))
      .sort((a, b) => a.seq - b.seq)
      .map((s, idx) => ({ ...s, seq: idx + 1 }));

    if (shots.length === 0) {
      showToast('Add at least one shot before saving.', 'warn');
      return;
    }

    if (state.importContext.appendToProjectId) {
      const proj = state.library.projects.find((p) => p.id === state.importContext.appendToProjectId);
      if (proj) {
        const startSeq = (proj.shots?.length || 0) + 1;
        shots.forEach((s, idx) => {
          s.seq = startSeq + idx;
          proj.shots.push(s);
        });
        scheduleSaveLibrary(proj);
        closeImportModal();
        renderWorkspace();
        showToast(`Appended ${shots.length} shots to "${proj.videoName}"!`);
        return;
      }
    }

    const videoName = $('prevVideoName').value.trim() || 'Untitled AI Video';
    const newProj = {
      id: uid('proj'),
      videoName,
      topic: $('prevTopic').value.trim(),
      aiModel: $('prevAiModel').value.trim(),
      targetDuration: $('prevTargetDuration').value.trim() || '8:00',
      defaultShotSeconds: 6,
      stylePrefix: '',
      styleSuffix: '',
      useGlobalStyle: false,
      sourceFile: state.importContext.sourceFilename,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      shots,
    };

    state.library.projects.unshift(newProj);
    scheduleSaveLibrary(newProj);
    closeImportModal();
    openProjectWorkspace(newProj.id, true);
    showToast(`Saved "${newProj.videoName}" with ${shots.length} sequenced shots!`);
  }

  // --- Export Helpers ---
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvEscape(val) {
    const s = String(val ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  async function exportActiveProject(format) {
    const proj = getActiveProject();
    if (!proj) return;
    const baseSlug = (proj.videoName || 'video-shots').replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '');

    if (format === 'json') {
      downloadBlob(new Blob([JSON.stringify(proj, null, 2)], { type: 'application/json' }), `${baseSlug}.json`);
      return;
    }

    if (format === 'txt') {
      const lines = [
        `Video Name: ${proj.videoName}`,
        `Topic: ${proj.topic || ''}`,
        `AI Model: ${proj.aiModel || ''}`,
        `Target Duration: ${proj.targetDuration || ''}`,
        '',
      ];
      (proj.shots || []).forEach((s) => {
        lines.push(`Shot ${s.seq}: ${s.title || ''} [${s.completed ? 'COMPLETED' : s.copied ? 'COPIED' : 'PENDING'}]`);
        if (s.duration) lines.push(`Duration: ${s.duration}`);
        if (s.script) lines.push(`Script: ${s.script}`);
        if (s.imagePrompt) lines.push(`Image Prompt: ${s.imagePrompt}`);
        if (s.videoPrompt) lines.push(`Video Prompt: ${s.videoPrompt}`);
        if (s.notes) lines.push(`Notes: ${s.notes}`);
        lines.push('');
      });
      downloadBlob(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }), `${baseSlug}.txt`);
      return;
    }

    const rows = [
      ['Video Name', proj.videoName || ''],
      ['Topic', proj.topic || ''],
      ['AI Model', proj.aiModel || ''],
      ['Target Duration', proj.targetDuration || ''],
      ['Shot #', 'Scene Title', 'Duration', 'Status', 'Script / VO', 'Image Prompt', 'Video Prompt', 'Notes'],
      ...(proj.shots || []).map((s) => [
        String(s.seq),
        s.title || '',
        s.duration || '',
        s.completed ? 'Completed' : s.copied ? 'Copied' : 'Pending',
        s.script || '',
        s.imagePrompt || '',
        s.videoPrompt || '',
        s.notes || '',
      ]),
    ];

    if (format === 'csv') {
      const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${baseSlug}.csv`);
      return;
    }

    if (format === 'xlsx') {
      try {
        const resp = await fetch('/api/export-xlsx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows }),
        });
        if (!resp.ok) throw new Error('Export failed');
        const blob = await resp.blob();
        downloadBlob(blob, `${baseSlug}.xlsx`);
      } catch (_) {
        showToast('Excel export requires the local server running.', 'err');
      }
    }
  }

  // --- Wire Events ---
  function bindEvents() {
    $('brandBtn').addEventListener('click', showLibraryView);
    $('btnTopLibrary').addEventListener('click', showLibraryView);
    $('btnBackToLibrary').addEventListener('click', showLibraryView);
    $('quickProjectSwitcher').addEventListener('change', (e) => {
      const id = e.target.value;
      if (id) {
        openProjectWorkspace(id, true);
      } else {
        showLibraryView();
      }
    });

    window.addEventListener('focus', () => {
      syncFromServerIfIdle();
    });
    window.addEventListener('storage', (e) => {
      if (e.key === LOCAL_STORAGE_KEY) {
        syncFromServerIfIdle();
      }
    });

    // Topbar actions
    $('btnOpenUpload').addEventListener('click', () => openImportModal('file'));
    $('btnOpenPaste').addEventListener('click', () => openImportModal('paste'));
    $('btnEmptyUpload').addEventListener('click', () => openImportModal('file'));
    $('btnEmptyPaste').addEventListener('click', () => openImportModal('paste'));
    $('btnAppendImport').addEventListener('click', () => openImportModal('file', state.activeProjectId));

    // Backup & Restore
    $('btnExportBackup').addEventListener('click', () => {
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(
        new Blob([JSON.stringify(state.library, null, 2)], { type: 'application/json' }),
        `prompt-studio-backup-${stamp}.json`
      );
      showToast('Full library JSON backup downloaded.');
    });

    $('inputRestoreBackup').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (!parsed || !Array.isArray(parsed.projects)) {
          throw new Error('Invalid backup JSON file.');
        }
        if (confirm(`Restore ${parsed.projects.length} projects from backup? This replaces the current library.`)) {
          state.library = parsed;
          scheduleSaveLibrary(null, { replaceAll: true });
          showLibraryView();
          showToast(`Restored ${parsed.projects.length} projects.`);
        }
      } catch (err) {
        showToast(err.message || 'Could not restore backup.', 'err');
      }
    });

    // Library Filters
    $('libSearch').addEventListener('input', (e) => {
      state.libSearch = e.target.value;
      renderLibrary();
    });
    $('libStatusTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.pill');
      if (!btn) return;
      state.libFilter = btn.dataset.filter;
      document.querySelectorAll('#libStatusTabs .pill').forEach((b) => b.classList.toggle('active', b === btn));
      renderLibrary();
    });
    $('libTopicFilter').addEventListener('change', (e) => {
      state.libTopic = e.target.value;
      renderLibrary();
    });
    $('libSort').addEventListener('change', (e) => {
      state.libSort = e.target.value;
      renderLibrary();
    });

    // Project Card Actions
    $('projectGrid').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === 'resume') {
        openProjectWorkspace(id, true);
      } else if (action === 'duplicate') {
        const orig = state.library.projects.find((p) => p.id === id);
        if (!orig) return;
        const copy = JSON.parse(JSON.stringify(orig));
        copy.id = uid('proj');
        copy.videoName = `${orig.videoName} (Copy)`;
        copy.createdAt = new Date().toISOString();
        copy.updatedAt = new Date().toISOString();
        copy.shots = (copy.shots || []).map((s) => ({ ...s, id: uid('shot') }));
        state.library.projects.unshift(copy);
        scheduleSaveLibrary(copy);
        renderLibrary();
        showToast('Project duplicated.');
      } else if (action === 'delete') {
        const orig = state.library.projects.find((p) => p.id === id);
        if (!orig) return;
        if (confirm(`Delete "${orig.videoName}" and all its shots?`)) {
          state.library.projects = state.library.projects.filter((p) => p.id !== id);
          state.dirtyProjectIds.delete(id);
          saveLocalBackup();
          renderLibrary();
          try {
            const resp = await fetch(`/api/project?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
            setSyncStatus(resp.ok ? 'ok' : 'warn', resp.ok ? 'Saved to Disk' : 'Browser Backup Only');
          } catch (_) {
            setSyncStatus('warn', 'Offline · Browser Backup');
          }
          showToast('Project deleted.');
        }
      }
    });

    // Blank Project Modal
    $('btnNewBlank').addEventListener('click', () => {
      $('blankProjectForm').reset();
      $('blankTargetDuration').value = '8:00';
      $('blankShotCount').value = '5';
      $('blankModal').classList.remove('hidden');
      setTimeout(() => $('blankVideoName').focus(), 40);
    });
    $('btnCloseBlank').addEventListener('click', () => $('blankModal').classList.add('hidden'));
    $('btnCancelBlank').addEventListener('click', () => $('blankModal').classList.add('hidden'));
    $('blankProjectForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const count = Math.max(1, Math.min(150, parseInt($('blankShotCount').value || '5', 10)));
      const shots = Array.from({ length: count }, (_, i) => createEmptyShot(i + 1));
      const newProj = {
        id: uid('proj'),
        videoName: $('blankVideoName').value.trim() || 'Untitled Video',
        topic: $('blankTopic').value.trim(),
        aiModel: $('blankAiModel').value.trim(),
        targetDuration: $('blankTargetDuration').value.trim() || '8:00',
        defaultShotSeconds: 6,
        stylePrefix: '',
        styleSuffix: '',
        useGlobalStyle: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        shots,
      };
      state.library.projects.unshift(newProj);
      scheduleSaveLibrary(newProj);
      $('blankModal').classList.add('hidden');
      openProjectWorkspace(newProj.id, false);
      showToast('Blank project created.');
    });

    // Workspace Project Header Fields
    ['wsVideoName', 'wsTopic', 'wsAiModel', 'wsTargetDuration'].forEach((id) => {
      $(id).addEventListener('input', () => {
        const proj = getActiveProject();
        if (!proj) return;
        proj.videoName = $('wsVideoName').value;
        proj.topic = $('wsTopic').value;
        proj.aiModel = $('wsAiModel').value;
        proj.targetDuration = $('wsTargetDuration').value;
        updateWorkspaceMetrics();
        scheduleSaveLibrary(proj);
      });
    });
    $('wsDefaultSec').addEventListener('input', () => {
      const proj = getActiveProject();
      if (!proj) return;
      proj.defaultShotSeconds = Math.max(1, parseInt($('wsDefaultSec').value || '6', 10));
      updateWorkspaceMetrics();
      scheduleSaveLibrary(proj);
    });

    // Production Toolbar
    $('toggleAutoComplete').addEventListener('change', (e) => {
      state.library.settings.autoCompleteOnCopy = e.target.checked;
      scheduleSaveLibrary(null, { settingsOnly: true });
      showToast(
        e.target.checked
          ? 'Auto-Complete on Copy enabled.'
          : 'Auto-Complete on Copy disabled (Copy marks "Copied" only).'
      );
    });

    $('btnToggleGlobalStyle').addEventListener('click', () => {
      $('globalStyleDrawer').classList.toggle('hidden');
    });
    $('wsUseGlobalStyle').addEventListener('change', (e) => {
      const proj = getActiveProject();
      if (!proj) return;
      proj.useGlobalStyle = e.target.checked;
      $('globalStyleBadge').classList.toggle('hidden', !proj.useGlobalStyle);
      scheduleSaveLibrary(proj);
    });
    ['wsStylePrefix', 'wsStyleSuffix'].forEach((id) => {
      $(id).addEventListener('input', () => {
        const proj = getActiveProject();
        if (!proj) return;
        proj.stylePrefix = $('wsStylePrefix').value;
        proj.styleSuffix = $('wsStyleSuffix').value;
        scheduleSaveLibrary(proj);
      });
    });

    $('btnJumpNext').addEventListener('click', () => {
      const proj = getActiveProject();
      if (!proj) return;
      const next = proj.shots.find((s) => !s.completed);
      if (!next) {
        showToast('All shots in this video are already marked completed!');
        return;
      }
      state.wsShotFilter = 'all';
      document.querySelectorAll('#wsShotFilterTabs .pill').forEach((b) => {
        b.classList.toggle('active', b.dataset.shotFilter === 'all');
      });
      state.focusedShotId = next.id;
      renderShotList();
      setTimeout(() => scrollToShot(next.id), 40);
    });

    $('btnRapidCopyNext').addEventListener('click', async () => {
      const proj = getActiveProject();
      if (!proj) return;
      let target =
        (state.focusedShotId && proj.shots.find((s) => s.id === state.focusedShotId && !s.completed)) ||
        proj.shots.find((s) => !s.completed);
      if (!target) {
        showToast('All shots are completed!');
        return;
      }
      await handleCopyVideoPrompt(proj, target, true);
    });

    // Shot Filter & Search
    $('wsShotFilterTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.pill');
      if (!btn) return;
      state.wsShotFilter = btn.dataset.shotFilter;
      document.querySelectorAll('#wsShotFilterTabs .pill').forEach((b) => b.classList.toggle('active', b === btn));
      renderShotList();
    });
    $('wsShotSearch').addEventListener('input', (e) => {
      state.wsShotSearch = e.target.value;
      renderShotList();
    });
    $('btnRenumberShots').addEventListener('click', () => {
      const proj = getActiveProject();
      if (!proj) return;
      renumberShots(proj);
      scheduleSaveLibrary(proj);
      renderShotList();
      showToast('Shots re-sequenced cleanly 1..' + proj.shots.length);
    });

    // Add Shots
    function appendBlankShotToWorkspace() {
      const proj = getActiveProject();
      if (!proj) return;
      const newShot = createEmptyShot(proj.shots.length + 1);
      proj.shots.push(newShot);
      state.focusedShotId = newShot.id;
      scheduleSaveLibrary(proj);
      renderWorkspace();
      setTimeout(() => scrollToShot(newShot.id), 40);
    }
    $('btnAddShotTop').addEventListener('click', appendBlankShotToWorkspace);
    $('btnAddShotBottom').addEventListener('click', appendBlankShotToWorkspace);

    // Export Dropdown
    $('btnDownloadTemplate').addEventListener('click', (e) => {
      e.stopPropagation();
      $('exportMenu').classList.toggle('hidden');
    });
    document.addEventListener('click', () => $('exportMenu').classList.add('hidden'));
    $('exportMenu').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-export]');
      if (!btn) return;
      $('exportMenu').classList.add('hidden');
      exportActiveProject(btn.dataset.export);
    });

    // Shot List Delegated Events (Input & Actions)
    $('shotList').addEventListener('input', (e) => {
      const el = e.target;
      if (el.tagName === 'TEXTAREA') autoSizeTextarea(el);
      const shotId = el.dataset.shotId;
      const field = el.dataset.shotField;
      if (!shotId || !field) return;
      const proj = getActiveProject();
      const shot = proj?.shots.find((s) => s.id === shotId);
      if (!shot) return;
      shot[field] = el.value;
      if (field === 'duration') updateWorkspaceMetrics();
      scheduleSaveLibrary(proj);
    });

    $('shotList').addEventListener('change', (e) => {
      const el = e.target;
      if (el.dataset.shotAction === 'toggle-complete') {
        const proj = getActiveProject();
        const shot = proj?.shots.find((s) => s.id === el.dataset.shotId);
        if (!shot) return;
        shot.completed = el.checked;
        state.focusedShotId = shot.id;
        scheduleSaveLibrary(proj);
        renderWorkspace();
        showToast(shot.completed ? `Shot #${shot.seq} marked Completed!` : `Shot #${shot.seq} marked incomplete.`);
      }
    });

    $('shotList').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-shot-action]');
      if (!btn) return;
      const action = btn.dataset.shotAction;
      if (action === 'toggle-complete') return; // handled on change
      const shotId = btn.dataset.shotId;
      const proj = getActiveProject();
      if (!proj) return;
      const idx = proj.shots.findIndex((s) => s.id === shotId);
      if (idx < 0) return;
      const shot = proj.shots[idx];

      if (action === 'copy-video') {
        await handleCopyVideoPrompt(proj, shot, false);
      } else if (action === 'copy-advance') {
        await handleCopyVideoPrompt(proj, shot, true);
      } else if (action === 'copy-image') {
        if (!shot.imagePrompt?.trim()) return showToast('No Image Prompt text to copy.', 'warn');
        await copyTextToClipboard(shot.imagePrompt);
        shot.imageCopied = true;
        scheduleSaveLibrary(proj);
        renderShotList();
        showToast(`Copied Shot #${shot.seq} Image Prompt!`);
      } else if (action === 'copy-script') {
        if (!shot.script?.trim()) return showToast('No Script/VO text to copy.', 'warn');
        await copyTextToClipboard(shot.script);
        showToast(`Copied Shot #${shot.seq} Script/VO!`);
      } else if (action === 'reveal') {
        shot[btn.dataset.reveal] = true;
        renderShotList();
      } else if (action === 'move-up' && idx > 0) {
        [proj.shots[idx - 1], proj.shots[idx]] = [proj.shots[idx], proj.shots[idx - 1]];
        renumberShots(proj);
        state.focusedShotId = shot.id;
        scheduleSaveLibrary(proj);
        renderWorkspace();
      } else if (action === 'move-down' && idx < proj.shots.length - 1) {
        [proj.shots[idx + 1], proj.shots[idx]] = [proj.shots[idx], proj.shots[idx + 1]];
        renumberShots(proj);
        state.focusedShotId = shot.id;
        scheduleSaveLibrary(proj);
        renderWorkspace();
      } else if (action === 'insert-below') {
        const created = createEmptyShot(idx + 2);
        proj.shots.splice(idx + 1, 0, created);
        renumberShots(proj);
        state.focusedShotId = created.id;
        scheduleSaveLibrary(proj);
        renderWorkspace();
        setTimeout(() => scrollToShot(created.id), 40);
      } else if (action === 'delete') {
        if (confirm(`Delete Shot #${shot.seq} ("${shot.title || 'Untitled'}")?`)) {
          proj.shots.splice(idx, 1);
          renumberShots(proj);
          scheduleSaveLibrary(proj);
          renderWorkspace();
          showToast('Shot removed and sequence updated.');
        }
      }
    });

    // Import Modal Events
    $('btnCloseImport').addEventListener('click', closeImportModal);
    $('btnCancelImport').addEventListener('click', closeImportModal);
    $('tabModeFile').addEventListener('click', () => switchImportMode('file'));
    $('tabModePaste').addEventListener('click', () => switchImportMode('paste'));

    $('importFileInput').addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (f) processUploadedFile(f);
    });

    const dz = $('dropZone');
    dz.addEventListener('dragover', (e) => {
      e.preventDefault();
      dz.classList.add('drag-over');
    });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('drag-over');
      const f = e.dataTransfer?.files?.[0];
      if (f) processUploadedFile(f);
    });

    $('btnLoadSampleXlsx').addEventListener('click', () =>
      loadSampleFromServer('samples/cyberpunk-documentary-shots.xlsx', 'cyberpunk-documentary-shots.xlsx')
    );
    $('btnLoadSampleDocx').addEventListener('click', () =>
      loadSampleFromServer('samples/ancient-india-story-shots.docx', 'ancient-india-story-shots.docx')
    );

    $('btnParsePastedText').addEventListener('click', () => {
      const txt = $('rawPasteTextarea').value;
      if (!txt.trim()) {
        showImportError('Paste some prompts or shot lines first.');
        return;
      }
      const parsed = parseUnstructuredTextToShots(txt, 'Pasted AI Video Prompts');
      enterImportPreview({ sourceFilename: 'Smart Paste', ...parsed });
    });

    $('btnPrevBack').addEventListener('click', () => {
      $('importStepPreview').classList.add('hidden');
      $('importStepInput').classList.remove('hidden');
    });

    $('btnPrevAddRow').addEventListener('click', () => {
      const list = state.importContext.previewShots;
      list.push(createEmptyShot(list.length + 1));
      renderPreviewTable();
    });

    $('mapperDropdowns').addEventListener('change', (e) => {
      const sel = e.target;
      const col = parseInt(sel.dataset.mapCol, 10);
      if (Number.isNaN(col)) return;
      state.importContext.columnMapping[col] = sel.value;
      state.importContext.previewShots = buildShotsFromMapping(
        state.importContext.rawTableRows,
        state.importContext.columnMapping
      );
      renderPreviewTable();
    });

    $('previewTableBody').addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-prev-idx]');
      if (!tr) return;
      const idx = parseInt(tr.dataset.prevIdx, 10);
      const field = e.target.dataset.prevField;
      if (!field || !state.importContext.previewShots[idx]) return;
      state.importContext.previewShots[idx][field] =
        field === 'seq' ? parseInt(e.target.value || String(idx + 1), 10) : e.target.value;
      if (field === 'duration') {
        const totalSec = state.importContext.previewShots.reduce(
          (acc, s) => acc + parseDurationSeconds(s.duration, 6),
          0
        );
        $('previewFooterNote').textContent = `Estimated total video runtime: ${formatSecondsMMSS(totalSec)}`;
      }
    });

    $('previewTableBody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-prev-del]');
      if (!btn) return;
      const idx = parseInt(btn.dataset.prevDel, 10);
      state.importContext.previewShots.splice(idx, 1);
      state.importContext.previewShots.forEach((s, i) => {
        s.seq = i + 1;
      });
      renderPreviewTable();
    });

    $('btnConfirmImport').addEventListener('click', confirmImportProject);
  }

  function applyTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#f3f6fc' : '#0b0e14');
    const btn = $('btnThemeToggle');
    if (btn) btn.textContent = t === 'light' ? '🌙 Dark' : '☀️ Light';
    try {
      localStorage.setItem('ps_theme', t);
    } catch (_) {}
  }

  function syncTopbarHeightVar() {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;
    document.documentElement.style.setProperty('--topbar-height', `${Math.ceil(topbar.getBoundingClientRect().height)}px`);
  }

  // --- Boot ---
  async function init() {
    let savedTheme = 'dark';
    try {
      savedTheme = localStorage.getItem('ps_theme') || 'dark';
    } catch (_) {}
    applyTheme(savedTheme);
    const themeBtn = $('btnThemeToggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        applyTheme(cur === 'light' ? 'dark' : 'light');
      });
    }

    bindEvents();
    syncTopbarHeightVar();
    if (typeof ResizeObserver !== 'undefined') {
      const topbar = document.querySelector('.topbar');
      if (topbar) new ResizeObserver(syncTopbarHeightVar).observe(topbar);
    }
    window.addEventListener('resize', syncTopbarHeightVar);
    await loadLibrary();
    renderLibrary();
  }

  init();
})();
