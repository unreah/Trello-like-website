/**
 * Kanban Pro — Professional Kanban Platform with Workspace Management,
 * Dynamic Columns, Administrator Roles, Role Permissions, Multi-User Assignment,
 * and Priority Tracking.
 */

// Global State
let currentUser = null;
let userTeams = [];
let currentWorkspace = null; // { type: 'solo'|'team', id: number|null, name: string, role?: string }
let currentColumns = []; // Dynamic columns for active board
let allUsers = []; // Users available in active workspace
let allTasks = [];
let activeTagFilter = "";
let draggedTaskId = null;
let currentTheme = localStorage.getItem("kanban_theme") || "theme-terracotta";

/* ==========================================================
   INITIALIZATION
   ========================================================== */

document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  setupEventListeners();
  initMobileBoardTabs();
  await checkAuth();
});

/* ==========================================================
   THEMES SETUP
   ========================================================== */

function initTheme() {
  applyTheme(currentTheme);

  const swatches = document.querySelectorAll(".theme-swatch");
  swatches.forEach(swatch => {
    swatch.addEventListener("click", async () => {
      const theme = swatch.dataset.theme;
      applyTheme(theme);
      localStorage.setItem("kanban_theme", theme);
      if (currentUser) {
        try {
          await fetch("/api/settings/theme", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ theme })
          });
        } catch (e) {
          // ignore offline
        }
      }
    });
  });
}

function applyTheme(themeName) {
  currentTheme = themeName;
  document.body.className = themeName;
  document.querySelectorAll(".theme-swatch").forEach(s => {
    s.classList.toggle("active", s.dataset.theme === themeName);
  });
}

/* ==========================================================
   AUTH MANAGEMENT
   ========================================================== */

async function checkAuth() {
  try {
    const res = await fetch("/api/auth/me");
    const data = await res.json();
    if (data.success && data.user) {
      currentUser = data.user;
      if (currentUser.theme) {
        applyTheme(currentUser.theme);
      }
    } else {
      currentUser = null;
    }
  } catch (e) {
    currentUser = null;
  }

  renderAuthHeader();

  if (currentUser) {
    await initWorkspaces();
  } else {
    document.getElementById("workspace-switcher-wrapper").style.display = "none";
    renderEmptyBoard();
    openAuthModal();
  }
}

function renderAuthHeader() {
  const authArea = document.getElementById("auth-area");
  if (!authArea) return;

  if (currentUser) {
    const initials = (currentUser.name || currentUser.username).slice(0, 2).toUpperCase();
    authArea.innerHTML = `
      <div class="user-profile-badge" title="Увійшли як ${escapeHtml(currentUser.username)}">
        <div class="user-avatar">${escapeHtml(initials)}</div>
        <span class="user-name-text">${escapeHtml(currentUser.name)}</span>
      </div>
      <button class="btn btn-secondary btn-sm" id="btn-logout">Вийти</button>
    `;

    document.getElementById("btn-logout").addEventListener("click", logout);
  } else {
    authArea.innerHTML = `
      <button class="btn btn-primary" id="btn-open-login">Увійти / Зареєструватися</button>
    `;
    document.getElementById("btn-open-login").addEventListener("click", openAuthModal);
  }
}

async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch (e) {}
  currentUser = null;
  userTeams = [];
  currentWorkspace = null;
  currentColumns = [];
  allTasks = [];
  allUsers = [];
  document.getElementById("workspace-switcher-wrapper").style.display = "none";
  renderAuthHeader();
  renderEmptyBoard();
  showToast("Ви вийшли з акаунту", "info");
  openAuthModal();
}

/* ==========================================================
   WORKSPACES & TEAMS (SLACK STYLE)
   ========================================================== */

async function initWorkspaces() {
  await loadTeams();

  const savedWs = localStorage.getItem("active_workspace");
  if (savedWs === "solo") {
    currentWorkspace = { type: "solo", id: null, name: "Особистий простір", role: "owner" };
  } else if (savedWs) {
    const matchedTeam = userTeams.find(t => String(t.id) === String(savedWs));
    if (matchedTeam) {
      currentWorkspace = { type: "team", id: matchedTeam.id, name: matchedTeam.name, role: matchedTeam.role };
    }
  }

  // If no saved preference, default to solo workspace
  if (!currentWorkspace) {
    currentWorkspace = { type: "solo", id: null, name: "Особистий простір", role: "owner" };
  }

  updateWorkspaceHeader();
  await switchWorkspace(currentWorkspace, false);
}

async function loadTeams() {
  try {
    const res = await fetch("/api/teams");
    const data = await res.json();
    if (data.success) {
      userTeams = data.teams || [];
    }
  } catch (e) {
    console.error("Failed to load teams:", e);
  }
}

function updateWorkspaceHeader() {
  const wrapper = document.getElementById("workspace-switcher-wrapper");
  const iconEl = document.getElementById("current-ws-icon");
  const nameEl = document.getElementById("current-ws-name");
  const boardTitle = document.getElementById("board-title");

  if (!wrapper || !currentWorkspace) return;
  wrapper.style.display = "flex";

  if (currentWorkspace.type === "solo") {
    iconEl.innerText = "👤";
    nameEl.innerText = "Особистий";
    if (boardTitle) boardTitle.innerText = "Особиста дошка";
  } else {
    iconEl.innerText = "🏢";
    nameEl.innerText = currentWorkspace.name;
    if (boardTitle) boardTitle.innerText = `Дошка: ${currentWorkspace.name}`;
  }
}

async function switchWorkspace(ws, notify = true) {
  currentWorkspace = ws;

  // Resolve role in team
  if (ws.type === "team") {
    const matchedTeam = userTeams.find(t => t.id === ws.id);
    currentWorkspace.role = matchedTeam ? matchedTeam.role : "member";
  } else {
    currentWorkspace.role = "owner";
  }

  localStorage.setItem("active_workspace", ws.type === "team" ? ws.id : "solo");
  updateWorkspaceHeader();

  // Load assignees based on workspace
  if (ws.type === "solo") {
    allUsers = [currentUser];
  } else {
    try {
      const res = await fetch(`/api/teams/${ws.id}/members`);
      const data = await res.json();
      if (data.success) {
        allUsers = data.members || [];
        if (data.myRole) {
          currentWorkspace.role = data.myRole;
        }
      } else {
        allUsers = [currentUser];
      }
    } catch (e) {
      allUsers = [currentUser];
    }
  }

  populateAssigneeOptions();
  await loadBoardColumns();
  await loadTasks();

  if (notify) {
    showToast(`Перемкнуто на: ${ws.name}`, "info");
  }
}

function openWorkspaceModal() {
  if (!currentUser) return;
  renderWorkspaceList();
  switchWsTab("list");
  openModal("workspace-modal-backdrop");
}

function formatMembersCount(count) {
  const n = Math.abs(Number(count) || 0);
  const n100 = n % 100;
  const n10 = n % 10;
  if (n100 >= 11 && n100 <= 19) return 'учасників';
  if (n10 === 1) return 'учасник';
  if (n10 >= 2 && n10 <= 4) return 'учасники';
  return 'учасників';
}

function renderWorkspaceList() {
  const container = document.getElementById("ws-list-container");
  if (!container) return;

  const isSoloActive = currentWorkspace?.type === "solo";

  let teamsHtml = userTeams.map(t => {
    const isTeamActive = currentWorkspace?.type === "team" && currentWorkspace?.id === t.id;
    const isOwner = t.role === "owner";
    const isAdmin = t.role === "admin";
    const membersWord = formatMembersCount(t.member_count);

    let roleBadge = "Учасник";
    let roleClass = "";
    if (isOwner) {
      roleBadge = "👑 Власник";
      roleClass = "owner";
    } else if (isAdmin) {
      roleBadge = "⭐ Адмін";
      roleClass = "admin";
    }

    return `
      <div class="ws-card ${isTeamActive ? 'active' : ''}" id="ws-card-${t.id}">
        <div class="ws-card-main" data-type="team" data-id="${t.id}" data-name="${escapeHtml(t.name)}">
          <div class="ws-card-left">
            <div class="ws-card-icon">🏢</div>
            <div class="ws-card-info">
              <div class="ws-card-title-row">
                <span class="ws-card-title">Команда ${escapeHtml(t.name)}</span>
                <span class="ws-role-pill ${roleClass}">
                  ${roleBadge}
                </span>
              </div>
              <div class="ws-card-subtitle">
                <span>👥 ${t.member_count} ${membersWord}</span>
              </div>
            </div>
          </div>
          <div class="ws-card-right">
            <span class="ws-status-badge">${isTeamActive ? '✓ Активне' : 'Обрати →'}</span>
          </div>
        </div>

        <div class="ws-card-actions">
          <button type="button" class="btn-ws-subaction btn-manage-members" data-id="${t.id}" data-name="${escapeHtml(t.name)}" title="Переглянути список учасників">
            👥 Учасники (${t.member_count})
          </button>
          ${isOwner ? `
            <button type="button" class="btn-ws-subaction danger btn-delete-team" data-id="${t.id}" data-name="${escapeHtml(t.name)}" title="Видалити корпоративне середовище">
              🗑️ Видалити команду
            </button>
          ` : `
            <button type="button" class="btn-ws-subaction danger btn-leave-team" data-id="${t.id}" data-name="${escapeHtml(t.name)}" title="Вийти з цієї команди">
              🚪 Вийти з команди
            </button>
          `}
        </div>

        <!-- Drawer for members (initially hidden) -->
        <div class="ws-members-drawer" id="members-drawer-${t.id}" style="display:none;"></div>
      </div>
    `;
  }).join("");

  container.innerHTML = `
    <!-- Solo option -->
    <div class="ws-card ${isSoloActive ? 'active' : ''}" id="ws-card-solo">
      <div class="ws-card-main" data-type="solo">
        <div class="ws-card-left">
          <div class="ws-card-icon">👤</div>
          <div class="ws-card-info">
            <div class="ws-card-title-row">
              <span class="ws-card-title">Особистий простір</span>
              <span class="ws-role-pill">Solo</span>
            </div>
            <div class="ws-card-subtitle">
              <span>🔒 Тільки ваші приватні задачі</span>
            </div>
          </div>
        </div>
        <div class="ws-card-right">
          <span class="ws-status-badge">${isSoloActive ? '✓ Активне' : 'Обрати →'}</span>
        </div>
      </div>
    </div>

    ${teamsHtml}
  `;

  // Bind click on card mains (switching workspace)
  container.querySelectorAll(".ws-card-main").forEach(cardMain => {
    cardMain.addEventListener("click", async () => {
      const type = cardMain.dataset.type;
      if (type === "solo") {
        await switchWorkspace({ type: "solo", id: null, name: "Особистий простір", role: "owner" });
      } else {
        const id = Number(cardMain.dataset.id);
        const name = cardMain.dataset.name;
        await switchWorkspace({ type: "team", id, name });
      }
      closeModal("workspace-modal-backdrop");
    });
  });

  // Bind members button
  container.querySelectorAll(".btn-manage-members").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const teamId = Number(btn.dataset.id);
      const teamName = btn.dataset.name;
      const drawer = document.getElementById(`members-drawer-${teamId}`);
      if (!drawer) return;

      if (drawer.style.display === "block") {
        drawer.style.display = "none";
        return;
      }

      await loadAndRenderTeamMembersDrawer(teamId, teamName, drawer);
    });
  });

  // Bind delete team button (owner)
  container.querySelectorAll(".btn-delete-team").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const teamId = Number(btn.dataset.id);
      const teamName = btn.dataset.name;

      if (!confirm(`Ви дійсно бажаєте безповоротно видалити команду "${teamName}"? Усі колонки та задачі цієї команди будуть видалені.`)) {
        return;
      }

      try {
        const res = await fetch(`/api/teams/${teamId}`, { method: "DELETE" });
        const data = await res.json();
        if (data.success) {
          showToast(`Команду "${teamName}" успішно видалено`, "success");
          if (currentWorkspace?.type === "team" && currentWorkspace?.id === teamId) {
            await switchWorkspace({ type: "solo", id: null, name: "Особистий простір", role: "owner" });
          }
          await loadTeams();
          renderWorkspaceList();
        } else {
          showToast(data.error || "Не вдалося видалити команду", "error");
        }
      } catch (err) {
        showToast("Помилка мережі при видаленні команди", "error");
      }
    });
  });

  // Bind leave team button (member/admin)
  container.querySelectorAll(".btn-leave-team").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const teamId = Number(btn.dataset.id);
      const teamName = btn.dataset.name;

      if (!confirm(`Ви дійсно бажаєте вийти з команди "${teamName}"?`)) {
        return;
      }

      try {
        const res = await fetch(`/api/teams/${teamId}/leave`, { method: "POST" });
        const data = await res.json();
        if (data.success) {
          showToast(`Ви вийшли з команди "${teamName}"`, "info");
          if (currentWorkspace?.type === "team" && currentWorkspace?.id === teamId) {
            await switchWorkspace({ type: "solo", id: null, name: "Особистий простір", role: "owner" });
          }
          await loadTeams();
          renderWorkspaceList();
        } else {
          showToast(data.error || "Не вдалося вийти з команди", "error");
        }
      } catch (err) {
        showToast("Помилка мережі при виході з команди", "error");
      }
    });
  });
}

async function loadAndRenderTeamMembersDrawer(teamId, teamName, drawer) {
  drawer.style.display = "block";
  drawer.innerHTML = `<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:6px;">Завантаження списку учасників...</div>`;

  try {
    const res = await fetch(`/api/teams/${teamId}/members`);
    const data = await res.json();
    if (!data.success) {
      drawer.innerHTML = `<div style="font-size:12px; color:#DC2626; padding:6px;">${escapeHtml(data.error || 'Не вдалося отримати учасників')}</div>`;
      return;
    }

    const members = data.members || [];
    const myRole = data.myRole || (userTeams.find(t => t.id === teamId)?.role) || "member";
    const amOwner = myRole === "owner";
    const amAdmin = myRole === "admin";

    let membersHtml = members.map(m => {
      const isSelf = currentUser && m.id === currentUser.id;
      const isMemberOwner = m.role === "owner";
      const isMemberAdmin = m.role === "admin";

      let roleBadge = `<span class="ws-member-role-badge member">👤 Учасник</span>`;
      if (isMemberOwner) roleBadge = `<span class="ws-member-role-badge owner">👑 Власник</span>`;
      else if (isMemberAdmin) roleBadge = `<span class="ws-member-role-badge admin">⭐ Адмін</span>`;

      let actionButtons = "";
      if (!isMemberOwner && !isSelf) {
        // Owner can promote to admin or demote to member
        if (amOwner) {
          if (isMemberAdmin) {
            actionButtons += `
              <button type="button" class="btn-demote-member" data-team-id="${teamId}" data-user-id="${m.id}" data-name="${escapeHtml(m.name)}" title="Зняти статус адміністратора">
                Зняти адміна
              </button>
            `;
          } else {
            actionButtons += `
              <button type="button" class="btn-promote-member" data-team-id="${teamId}" data-user-id="${m.id}" data-name="${escapeHtml(m.name)}" title="Призначити адміністратором">
                ⭐ Зробити адміном
              </button>
            `;
          }
        }

        // Owner can remove any member. Admin can remove regular members (not other admins or owner)
        const canKick = amOwner || (amAdmin && !isMemberAdmin);
        if (canKick) {
          actionButtons += `
            <button type="button" class="btn-kick-member" data-team-id="${teamId}" data-user-id="${m.id}" data-name="${escapeHtml(m.name)}" title="Видалити учасника з дошки">
              ❌ Видалити
            </button>
          `;
        }
      }

      return `
        <div class="ws-member-item">
          <div class="ws-member-left">
            <div class="ws-member-avatar">${escapeHtml((m.name || 'U').charAt(0).toUpperCase())}</div>
            <div class="ws-member-details">
              <span class="ws-member-name">${escapeHtml(m.name)} ${isSelf ? '(Ви)' : ''}</span>
              <span class="ws-member-user">@${escapeHtml(m.username)}</span>
            </div>
          </div>
          <div class="ws-member-right">
            ${roleBadge}
            ${actionButtons}
          </div>
        </div>
      `;
    }).join("");

    drawer.innerHTML = `
      <div class="ws-members-drawer-header">
        <span>Учасники команди (${members.length})</span>
      </div>
      <div class="ws-members-list-scroll">
        ${membersHtml}
      </div>
    `;

    // Bind promote to admin
    drawer.querySelectorAll(".btn-promote-member").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const targetUserId = Number(btn.dataset.userId);
        const targetName = btn.dataset.name;

        try {
          const pRes = await fetch(`/api/teams/${teamId}/members/${targetUserId}/role`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ role: "admin" })
          });
          const pData = await pRes.json();
          if (pData.success) {
            showToast(`Користувачу "${targetName}" надано права адміністратора!`, "success");
            await loadAndRenderTeamMembersDrawer(teamId, teamName, drawer);
            if (currentWorkspace?.type === "team" && currentWorkspace?.id === teamId) {
              await loadTasks();
            }
          } else {
            showToast(pData.error || "Не вдалося призначити адміністратора", "error");
          }
        } catch (err) {
          showToast("Помилка мережі", "error");
        }
      });
    });

    // Bind demote from admin
    drawer.querySelectorAll(".btn-demote-member").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const targetUserId = Number(btn.dataset.userId);
        const targetName = btn.dataset.name;

        try {
          const dRes = await fetch(`/api/teams/${teamId}/members/${targetUserId}/role`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ role: "member" })
          });
          const dData = await dRes.json();
          if (dData.success) {
            showToast(`Знято статус адміністратора з "${targetName}"`, "info");
            await loadAndRenderTeamMembersDrawer(teamId, teamName, drawer);
            if (currentWorkspace?.type === "team" && currentWorkspace?.id === teamId) {
              await loadTasks();
            }
          } else {
            showToast(dData.error || "Не вдалося зняти роль адміністратора", "error");
          }
        } catch (err) {
          showToast("Помилка мережі", "error");
        }
      });
    });

    // Bind kick buttons
    drawer.querySelectorAll(".btn-kick-member").forEach(kickBtn => {
      kickBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const targetUserId = Number(kickBtn.dataset.userId);
        const targetName = kickBtn.dataset.name;

        if (!confirm(`Ви дійсно бажаєте видалити "${targetName}" з команди?`)) {
          return;
        }

        try {
          const kickRes = await fetch(`/api/teams/${teamId}/members/${targetUserId}`, { method: "DELETE" });
          const kickData = await kickRes.json();
          if (kickData.success) {
            showToast(`Користувача "${targetName}" видалено з команди`, "success");
            await loadTeams();
            await loadAndRenderTeamMembersDrawer(teamId, teamName, drawer);
            if (currentWorkspace?.type === "team" && currentWorkspace?.id === teamId) {
              await switchWorkspace(currentWorkspace, false);
            }
          } else {
            showToast(kickData.error || "Не вдалося видалити учасника", "error");
          }
        } catch (err) {
          showToast("Помилка мережі при видаленні учасника", "error");
        }
      });
    });
  } catch (err) {
    drawer.innerHTML = `<div style="font-size:12px; color:#DC2626; padding:6px;">Помилка завантаження учасників</div>`;
  }
}

function switchWsTab(tab) {
  const tabList = document.getElementById("tab-ws-list");
  const tabCreate = document.getElementById("tab-ws-create");
  const tabJoin = document.getElementById("tab-ws-join");

  const viewList = document.getElementById("ws-view-list");
  const formCreate = document.getElementById("create-team-form");
  const formJoin = document.getElementById("join-team-form");
  const errorBox = document.getElementById("ws-error-msg");

  errorBox.style.display = "none";
  [tabList, tabCreate, tabJoin].forEach(t => t?.classList.remove("active"));
  [viewList, formCreate, formJoin].forEach(v => { if (v) v.style.display = "none"; });

  if (tab === "list") {
    tabList?.classList.add("active");
    if (viewList) viewList.style.display = "block";
    renderWorkspaceList();
  } else if (tab === "create") {
    tabCreate?.classList.add("active");
    if (formCreate) formCreate.style.display = "flex";
  } else if (tab === "join") {
    tabJoin?.classList.add("active");
    if (formJoin) formJoin.style.display = "flex";
  }
}

/* ==========================================================
   DYNAMIC BOARD COLUMNS MANAGEMENT
   ========================================================== */

async function loadBoardColumns() {
  try {
    const teamParam = (currentWorkspace && currentWorkspace.type === "team")
      ? currentWorkspace.id
      : "solo";

    const res = await fetch(`/api/columns?teamId=${teamParam}`);
    const data = await res.json();
    if (data.success) {
      currentColumns = data.columns || [];
      renderBoardColumns();
    } else {
      showToast(data.error || "Не вдалося завантажити колонки", "error");
    }
  } catch (e) {
    console.error("Failed to load columns:", e);
  }
}

function getColumnIcon(statusKey, colName = "") {
  const lower = (statusKey + " " + colName).toLowerCase();
  // Check completed / done first to avoid "виконано" matching "викон"
  if (lower.includes("done") || lower.includes("заверш") || lower.includes("готов") || lower.includes("виконано")) return "✅";
  if (lower.includes("in-progress") || lower.includes("процес") || lower.includes("робот") || lower.includes("роб")) return "⚡";
  if (lower.includes("todo") || lower.includes("до викон") || lower.includes("черг") || lower.includes("план") || lower.includes("викон")) return "📋";
  if (lower.includes("test") || lower.includes("тест")) return "🧪";
  if (lower.includes("review") || lower.includes("рев")) return "👀";
  if (lower.includes("block") || lower.includes("блок")) return "⛔";
  return "📌";
}

function getDoneColumn() {
  if (!currentColumns || currentColumns.length === 0) return null;
  // 1. Check explicit done status keys
  const byKey = currentColumns.find(c => c.status_key === "done" || c.status_key === "completed" || c.status_key === "finished");
  if (byKey) return byKey;

  // 2. By column name match: "виконано", "завершено", "готово", "done", explicitly excluding "до викон" / "todo"
  const byName = currentColumns.find(c => {
    const name = (c.name || "").toLowerCase().trim();
    if (name.includes("до викон") || name.includes("todo")) return false;
    return name.includes("виконано") || name.includes("заверш") || name.includes("готов") || name.includes("done");
  });
  if (byName) return byName;

  // 3. Fallback: last column if more than 1 column
  if (currentColumns.length > 1) {
    return currentColumns[currentColumns.length - 1];
  }
  return currentColumns[0];
}

function renderBoardColumns() {
  const board = document.getElementById("kanban-board");
  const mobileTabs = document.getElementById("mobile-board-tabs");
  const mobileTargetsRow = document.getElementById("mobile-drag-targets-row");
  if (!board) return;

  const isAdminOrOwner = currentWorkspace?.type === "solo" || currentWorkspace?.role === "owner" || currentWorkspace?.role === "admin";

  // 1. Render Columns on Board
  let columnsHtml = "";
  currentColumns.forEach((col, idx) => {
    const icon = getColumnIcon(col.status_key, col.name);
    const isFirstColumn = idx === 0 || col.status_key === "todo";

    let adminControls = "";
    if (isAdminOrOwner) {
      adminControls = `
        <div class="column-actions-group">
          <button type="button" class="btn-col-action btn-edit-col" data-col-id="${col.id}" data-col-name="${escapeHtml(col.name)}" onclick="openEditColumnModal(this.dataset.colId, this.dataset.colName)" title="Редагувати назву колонки">✏️</button>
          ${currentColumns.length > 1 ? `
            <button type="button" class="btn-col-action btn-delete-col" data-col-id="${col.id}" data-col-name="${escapeHtml(col.name)}" onclick="handleDeleteColumn(this.dataset.colId, this.dataset.colName)" title="Видалити колонку">🗑️</button>
          ` : ''}
        </div>
      `;
    }

    // Quick add task input inside the first column ("До виконання")
    let quickAddHtml = "";
    if (isFirstColumn) {
      quickAddHtml = `
        <div class="quick-add-task-box">
          <form class="quick-add-task-form" id="quick-add-task-form" data-status="${col.status_key}">
            <input type="text" class="quick-add-task-input" id="quick-add-task-input" placeholder="+ Додати задачу... (натисніть Enter)" maxlength="200" autocomplete="off" required>
            <button type="submit" class="quick-add-task-btn" title="Додати задачу">+</button>
          </form>
        </div>
      `;
    }

    columnsHtml += `
      <div class="kanban-column" id="column-${col.status_key}" data-status="${col.status_key}">
        <div class="column-header">
          <div class="column-title-group">
            <span class="column-icon">${icon}</span>
            <h2 class="column-title">${escapeHtml(col.name)}</h2>
          </div>
          ${adminControls}
          <span class="column-count-badge" id="count-col-${col.status_key}">0</span>
        </div>
        ${quickAddHtml}
        <div class="column-dropzone" id="dropzone-${col.status_key}" data-status="${col.status_key}">
          <!-- Task cards -->
        </div>
      </div>
    `;
  });

  // If Admin / Owner, append Add Column card at the end of board
  if (isAdminOrOwner) {
    columnsHtml += `
      <div class="add-column-card">
        <button type="button" class="btn-add-column" id="btn-add-column" onclick="openAddColumnModal()">
          <span>+ Додати колонку</span>
        </button>
      </div>
    `;
  }

  board.innerHTML = columnsHtml;

  // 2. Render Mobile Board Tabs
  if (mobileTabs) {
    let tabsHtml = currentColumns.map((col, idx) => {
      const icon = getColumnIcon(col.status_key, col.name);
      return `
        <button class="mobile-board-tab ${idx === 0 ? 'active' : ''}" data-col="${col.status_key}" type="button">
          ${icon} ${escapeHtml(col.name)} (<span id="mob-count-col-${col.status_key}">0</span>)
        </button>
      `;
    }).join("");
    if (isAdminOrOwner) {
      tabsHtml += `
        <button class="mobile-board-tab mobile-add-col-tab" id="mob-btn-add-column" type="button" onclick="openAddColumnModal()" title="Додати нову колонку">
          ➕ Нова колонка
        </button>
      `;
    }
    mobileTabs.innerHTML = tabsHtml;
    initMobileBoardTabs();
  }

  // 3. Render Floating Mobile Drag Targets
  if (mobileTargetsRow) {
    let targetsHtml = currentColumns.map(col => {
      const icon = getColumnIcon(col.status_key, col.name);
      return `
        <div class="mobile-drop-target" data-status="${col.status_key}">
          <span class="mdt-icon">${icon}</span>
          <span class="mdt-title">${escapeHtml(col.name)}</span>
        </div>
      `;
    }).join("");
    mobileTargetsRow.innerHTML = targetsHtml;
  }

  // 4. Setup Drag & Drop on freshly rendered dropzones
  setupDragAndDrop();

  // 5. Bind quick add task form listener
  const quickAddForm = document.getElementById("quick-add-task-form");
  if (quickAddForm) {
    quickAddForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!currentUser) {
        openAuthModal();
        return;
      }
      const input = quickAddForm.querySelector(".quick-add-task-input");
      const title = input.value.trim();
      if (!title) return;

      const targetStatus = quickAddForm.dataset.status || (currentColumns[0]?.status_key ?? "todo");
      const teamParam = (currentWorkspace && currentWorkspace.type === "team") ? currentWorkspace.id : null;

      try {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            status: targetStatus,
            difficulty: "mid",
            teamId: teamParam,
            assigneeIds: [currentUser.id]
          })
        });
        const data = await res.json();
        if (data.success) {
          input.value = "";
          showToast(`Задачу "${title}" успішно додано!`, "success");
          await loadTasks();
        } else {
          showToast(data.error || "Не вдалося створити задачу", "error");
        }
      } catch (err) {
        showToast("Помилка зв'язку із сервером", "error");
      }
    });
  }

  // 6. Bind Column Admin Action Listeners
  if (isAdminOrOwner) {
    document.getElementById("btn-add-column")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openAddColumnModal();
    });
    document.getElementById("mob-btn-add-column")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openAddColumnModal();
    });

    board.querySelectorAll(".btn-edit-col").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditColumnModal(btn.dataset.colId, btn.dataset.colName);
      });
    });

    board.querySelectorAll(".btn-delete-col").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleDeleteColumn(btn.dataset.colId, btn.dataset.colName);
      });
    });
  }

  // Re-render tasks into freshly created dropzones if tasks are already loaded
  if (allTasks && allTasks.length > 0) {
    renderBoard();
  }
}

/* ==========================================================
   DATA LOADING (TASKS)
   ========================================================== */

function populateAssigneeOptions() {
  // 1. Filter dropdown
  const filterSelect = document.getElementById("filter-assignee");
  if (filterSelect) {
    const prevFilterVal = filterSelect.value;
    filterSelect.innerHTML = `
      <option value="">Усі користувачі</option>
      <option value="me">Тільки призначені мені</option>
    `;
    allUsers.forEach(u => {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = `${u.name} (@${u.username})`;
      filterSelect.appendChild(opt);
    });
    filterSelect.value = prevFilterVal || "";
  }

  // 2. Task modal checklist
  const checklist = document.getElementById("task-assignees-checklist");
  if (checklist) {
    checklist.innerHTML = "";
    allUsers.forEach(u => {
      const initials = (u.name || u.username).slice(0, 2).toUpperCase();
      const item = document.createElement("label");
      item.className = "assignee-checkbox-item";
      item.innerHTML = `
        <input type="checkbox" value="${u.id}" class="user-assignee-cb">
        <span class="assignee-checkbox-avatar">${escapeHtml(initials)}</span>
        <span>${escapeHtml(u.name)}</span>
      `;
      const cb = item.querySelector("input");
      cb.addEventListener("change", () => {
        item.classList.toggle("selected", cb.checked);
      });
      checklist.appendChild(item);
    });
  }
}

async function loadTasks() {
  if (!currentUser) return;
  try {
    const teamParam = (currentWorkspace && currentWorkspace.type === "team")
      ? currentWorkspace.id
      : "solo";

    const res = await fetch(`/api/tasks?teamId=${teamParam}`);
    const data = await res.json();
    if (data.success) {
      allTasks = data.tasks || [];
      renderBoard();
    } else {
      showToast(data.error || "Помилка завантаження задач", "error");
    }
  } catch (e) {
    showToast("Неможливо з'єднатися із сервером", "error");
  }
}

/* ==========================================================
   BOARD & TASKS RENDERING
   ========================================================== */

function renderEmptyBoard() {
  currentColumns.forEach(c => {
    const dropzone = document.getElementById(`dropzone-${c.status_key}`);
    if (dropzone) {
      dropzone.innerHTML = `<div class="empty-col-placeholder">Увійдіть, щоб переглянути задачі</div>`;
    }
    const countBadge = document.getElementById(`count-col-${c.status_key}`);
    if (countBadge) countBadge.textContent = "0";
    const mobCountBadge = document.getElementById(`mob-count-col-${c.status_key}`);
    if (mobCountBadge) mobCountBadge.textContent = "0";
  });
  updateDashboardStats([]);
  renderTagChips([]);
}

function renderBoard() {
  const filterAssignee = document.getElementById("filter-assignee")?.value || "";
  const filterTagInput = document.getElementById("filter-tag")?.value.trim().toLowerCase() || "";

  // Filter tasks
  const filteredTasks = allTasks.filter(task => {
    // Assignee filter
    if (filterAssignee === "me") {
      if (!currentUser) return false;
      const isAssigned = task.is_all_assignees ||
        (Array.isArray(task.assignees) && task.assignees.some(a => a.id === currentUser.id)) ||
        task.assignee_id === currentUser.id;
      if (!isAssigned) return false;
    } else if (filterAssignee) {
      const targetUid = Number(filterAssignee);
      const isAssigned = task.is_all_assignees ||
        (Array.isArray(task.assignees) && task.assignees.some(a => a.id === targetUid)) ||
        task.assignee_id === targetUid;
      if (!isAssigned) return false;
    }

    // Tag filter from input
    if (filterTagInput) {
      const hasMatch = task.tags.some(t => t.toLowerCase().includes(filterTagInput));
      if (!hasMatch) return false;
    }

    // Tag filter from active chip
    if (activeTagFilter) {
      const hasChipMatch = task.tags.some(t => t.toLowerCase() === activeTagFilter.toLowerCase());
      if (!hasChipMatch) return false;
    }

    return true;
  });

  // Initialize counts for all current columns
  const counts = {};
  currentColumns.forEach(col => {
    counts[col.status_key] = 0;
    const dropzone = document.getElementById(`dropzone-${col.status_key}`);
    if (dropzone) {
      dropzone.innerHTML = "";
    }
  });

  // Distribute tasks into columns
  filteredTasks.forEach(task => {
    let targetDropzone = document.getElementById(`dropzone-${task.status}`);
    let taskStatus = task.status;
    if (!targetDropzone && currentColumns.length > 0) {
      taskStatus = currentColumns[0].status_key;
      targetDropzone = document.getElementById(`dropzone-${taskStatus}`);
    }
    if (counts[taskStatus] !== undefined) {
      counts[taskStatus]++;
    }
    if (targetDropzone) {
      targetDropzone.appendChild(createTaskCardElement(task));
    }
  });

  // Empty state placeholders & badges
  currentColumns.forEach(c => {
    const col = document.getElementById(`dropzone-${c.status_key}`);
    if (col && counts[c.status_key] === 0) {
      col.innerHTML = `<div class="empty-col-placeholder">Немає задач у цьому списку</div>`;
    }
    const badge = document.getElementById(`count-col-${c.status_key}`);
    if (badge) badge.textContent = counts[c.status_key] || 0;
    const mobBadge = document.getElementById(`mob-count-col-${c.status_key}`);
    if (mobBadge) mobBadge.textContent = counts[c.status_key] || 0;
  });

  updateDashboardStats(filteredTasks);
  renderTagChips(allTasks);
}

function createTaskCardElement(task) {
  const card = document.createElement("div");
  card.className = "task-card";
  card.dataset.taskId = task.id;

  const isAdminOrOwner = currentWorkspace?.type === "solo" || currentWorkspace?.role === "owner" || currentWorkspace?.role === "admin";
  const isCreator = currentUser && (currentUser.id === task.creator_id);
  const isAssignee = currentUser && (
    task.is_all_assignees ||
    (Array.isArray(task.assignees) && task.assignees.some(a => a.id === currentUser.id)) ||
    task.assignee_id === currentUser.id
  );

  const canManage = isCreator || isAdminOrOwner;
  const canMove = isAssignee || canManage;

  if (canMove) {
    card.classList.add("is-draggable");
    card.setAttribute("draggable", "true");
  } else {
    card.classList.add("not-draggable");
  }

  // Priority Pill: Low (ez), Mid, High (oh fu..)
  const diffClass = (task.difficulty === "low" || task.difficulty === "ez") ? "low"
    : (task.difficulty === "high" || task.difficulty === "oh fu..") ? "high"
    : "mid";
  const diffLabel = diffClass === "low" ? "Низький" : diffClass === "high" ? "Високий" : "Середній";

  // Tags HTML
  const tagsHtml = task.tags && task.tags.length
    ? task.tags.map(t => `<span class="task-tag-pill" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join("")
    : "";

  // Actions for creator / admin
  let creatorActionsHtml = "";
  if (canManage) {
    creatorActionsHtml = `
      <div class="task-actions">
        ${canMove ? `<button class="btn-icon-action move-task-btn" title="Перемістити задачу" aria-label="Move task">⇄</button>` : ""}
        <button class="btn-icon-action edit-task-btn" title="Редагувати задачу" aria-label="Edit task">✏️</button>
        <button class="btn-icon-action delete delete-task-btn" title="Видалити задачу" aria-label="Delete task">🗑️</button>
      </div>
    `;
  } else if (canMove) {
    creatorActionsHtml = `
      <div class="task-actions">
        <button class="btn-icon-action move-task-btn" title="Перемістити задачу" aria-label="Move task">⇄</button>
      </div>
    `;
  }

  // Assignee rendering HTML
  let assigneesHtml = "";
  if (task.is_all_assignees) {
    assigneesHtml = `<span class="badge-all-users" title="Призначено на всіх користувачів простору">👥 Всім</span>`;
  } else if (task.assignees && task.assignees.length > 0) {
    if (task.assignees.length === 1) {
      assigneesHtml = `<span>👤 <strong>${escapeHtml(task.assignees[0].name)}</strong></span>`;
    } else {
      const names = task.assignees.map(a => a.name).join(", ");
      const avatars = task.assignees.map(a => `<span class="mini-avatar" title="${escapeHtml(a.name)}">${escapeHtml((a.name || a.username).slice(0, 1).toUpperCase())}</span>`).join("");
      assigneesHtml = `
        <div class="task-assignees-badge" title="${escapeHtml(names)}">
          <span>👥 <strong>${task.assignees.length} викон.</strong></span>
          <div class="assignees-avatars-group">${avatars}</div>
        </div>
      `;
    }
  } else {
    assigneesHtml = `<span>👤 <strong>${escapeHtml(task.assignee_name || 'Не призначено')}</strong></span>`;
  }

  // Drag permission hint
  let dragHintHtml = "";
  if (isAdminOrOwner) {
    dragHintHtml = `<span class="task-drag-hint can-drag" title="Ви маєте права адміністратора дошки">👑 Адмін (тягни)</span>`;
  } else if (isAssignee) {
    dragHintHtml = `<span class="task-drag-hint can-drag" title="Ви є виконавцем цієї задачі">⋮⋮ Виконавець (тягни)</span>`;
  } else if (isCreator) {
    dragHintHtml = `<span class="task-drag-hint can-drag" title="Ви є автором цієї задачі">⋮⋮ Автор (тягни)</span>`;
  } else {
    dragHintHtml = `<span class="task-drag-hint locked" title="Переміщувати можуть виконавці та адміністратори">🔒 Лише виконавці / адмін</span>`;
  }

  // Dynamic Quick Move buttons between columns
  let quickMovesHtml = "";
  if (canMove && currentColumns.length > 1) {
    const colIdx = currentColumns.findIndex(c => c.status_key === task.status);
    const prevCol = colIdx > 0 ? currentColumns[colIdx - 1] : null;
    const nextCol = (colIdx >= 0 && colIdx < currentColumns.length - 1) ? currentColumns[colIdx + 1] : null;

    if (prevCol || nextCol) {
      quickMovesHtml = `
        <div class="task-quick-moves ${prevCol && nextCol ? 'dual' : ''}">
          ${prevCol ? `
            <button type="button" class="btn-quick-move btn-move-prev" data-move-to="${prevCol.status_key}" title="Перемістити в ${escapeHtml(prevCol.name)}">
              <span class="btn-qm-arrow">◀</span>
              <span>${escapeHtml(prevCol.name)}</span>
            </button>
          ` : ''}
          ${nextCol ? `
            <button type="button" class="btn-quick-move btn-move-next" data-move-to="${nextCol.status_key}" title="Перемістити в ${escapeHtml(nextCol.name)}">
              <span>${escapeHtml(nextCol.name)}</span>
              <span class="btn-qm-arrow">▶</span>
            </button>
          ` : ''}
        </div>
      `;
    }
  }

  card.innerHTML = `
    <div class="task-top-row">
      <span class="diff-pill ${diffClass}">${escapeHtml(diffLabel)}</span>
      ${creatorActionsHtml}
    </div>

    <div class="task-title">${escapeHtml(task.title)}</div>
    ${task.description ? `<div class="task-description">${escapeHtml(task.description)}</div>` : ""}

    ${tagsHtml ? `<div class="task-tags-list">${tagsHtml}</div>` : ""}

    <div class="task-footer">
      <div class="task-users-info">
        <div class="task-user-row">
          ${assigneesHtml}
        </div>
        <div class="task-user-row" style="font-size: 10px; color: var(--text-subtle);">
          <span>Автор: ${escapeHtml(task.creator_name)}</span>
        </div>
      </div>
      ${dragHintHtml}
    </div>
    ${quickMovesHtml}
  `;

  // Bind move modal button
  const moveBtn = card.querySelector(".move-task-btn");
  if (moveBtn) {
    moveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openMoveTaskModal(task);
    });
  }

  // Bind edit & delete events
  if (canManage) {
    const editBtn = card.querySelector(".edit-task-btn");
    if (editBtn) {
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditTaskModal(task);
      });
    }

    const deleteBtn = card.querySelector(".delete-task-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm(`Видалити задачу "${task.title}"?`)) {
          await deleteTask(task.id);
        }
      });
    }
  }

  // Tag pill clicks filter board
  card.querySelectorAll(".task-tag-pill").forEach(pill => {
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      const clickedTag = pill.dataset.tag;
      activeTagFilter = (activeTagFilter === clickedTag) ? "" : clickedTag;
      renderBoard();
    });
  });

  // DRAG AND DROP & QUICK MOVE EVENTS ON CARD
  if (canMove) {
    card.querySelectorAll(".btn-quick-move").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const targetStatus = btn.dataset.moveTo;
        if (targetStatus) {
          await updateTaskStatus(task.id, targetStatus);
        }
      });
    });

    attachTouchDragEvents(card, task);

    card.addEventListener("dragstart", (e) => {
      draggedTaskId = task.id;
      card.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(task.id));
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("is-dragging");
      draggedTaskId = null;
      document.querySelectorAll(".column-dropzone").forEach(dz => dz.classList.remove("drag-over"));
    });
  } else {
    card.addEventListener("click", () => {
      showToast("Переміщувати задачу можуть лише призначені виконавці або адміністратори!", "info");
    });
  }

  return card;
}

/* ==========================================================
   TASK STATUS UPDATING & DRAG AND DROP
   ========================================================== */

let currentTaskForMove = null;

function openMoveTaskModal(task) {
  currentTaskForMove = task;
  const nameEl = document.getElementById("move-task-modal-name");
  const optionsGrid = document.getElementById("move-options-grid");
  if (nameEl) {
    nameEl.textContent = task.title;
  }

  if (optionsGrid) {
    optionsGrid.innerHTML = currentColumns.map(col => {
      const icon = getColumnIcon(col.status_key, col.name);
      const isCurrent = col.status_key === task.status;
      return `
        <button type="button" class="btn-move-option ${isCurrent ? 'current-status' : ''}" data-status="${col.status_key}">
          <span class="mvo-icon">${icon}</span>
          <div class="mvo-text">
            <strong>${escapeHtml(col.name)}</strong>
          </div>
        </button>
      `;
    }).join("");

    optionsGrid.querySelectorAll(".btn-move-option").forEach(btn => {
      btn.addEventListener("click", async () => {
        const targetStatus = btn.dataset.status;
        if (currentTaskForMove && targetStatus) {
          closeModal("move-task-modal-backdrop");
          await updateTaskStatus(currentTaskForMove.id, targetStatus);
        }
      });
    });
  }

  openModal("move-task-modal-backdrop");
}

async function updateTaskStatus(taskId, targetStatus) {
  taskId = Number(taskId);
  const task = allTasks.find(t => t.id === taskId);
  if (!task) return;
  if (task.status === targetStatus) return;

  const isAdminOrOwner = currentWorkspace?.type === "solo" || currentWorkspace?.role === "owner" || currentWorkspace?.role === "admin";
  const isCreator = currentUser && (currentUser.id === task.creator_id);
  const isAssigned = currentUser && (
    task.is_all_assignees ||
    (Array.isArray(task.assignees) && task.assignees.some(a => a.id === currentUser.id)) ||
    task.assignee_id === currentUser.id
  );

  if (!isAssigned && !isCreator && !isAdminOrOwner) {
    showToast("Переміщувати статус задачі можуть лише призначені виконавці, автор або адміністратори!", "error");
    return;
  }

  // Optimistic UI update
  const prevStatus = task.status;
  task.status = targetStatus;
  renderBoard();

  // Backend sync
  try {
    const res = await fetch(`/api/tasks/${taskId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: targetStatus })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      // Revert
      task.status = prevStatus;
      renderBoard();
      showToast(data.error || "Не вдалося змінити статус", "error");
    } else {
      const col = currentColumns.find(c => c.status_key === targetStatus);
      const colName = col ? col.name : targetStatus;
      showToast(`Задачу переміщено в «${colName}»`, "success");
    }
  } catch (err) {
    task.status = prevStatus;
    renderBoard();
    showToast("Помилка зв'язку із сервером", "error");
  }
}

function setupDragAndDrop() {
  const dropzones = document.querySelectorAll(".column-dropzone");

  dropzones.forEach(dropzone => {
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      dropzone.classList.add("drag-over");
    });

    dropzone.addEventListener("dragleave", (e) => {
      if (!dropzone.contains(e.relatedTarget)) {
        dropzone.classList.remove("drag-over");
      }
    });

    dropzone.addEventListener("drop", async (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag-over");

      const targetStatus = dropzone.dataset.status;
      const taskId = Number(draggedTaskId || e.dataTransfer.getData("text/plain"));

      if (taskId && targetStatus) {
        await updateTaskStatus(taskId, targetStatus);
      }
    });
  });
}

/* ==========================================================
   DASHBOARD STATS & TAGS CHIPS
   ========================================================== */

function updateDashboardStats(tasks) {
  const total = tasks.length;
  const doneColumn = getDoneColumn();
  const doneStatus = doneColumn ? doneColumn.status_key : "done";
  const doneCount = tasks.filter(t => t.status === doneStatus).length;
  const pct = total === 0 ? 0 : Math.round((doneCount / total) * 100);

  // Donut meter
  const pctEl = document.getElementById("completion-pct");
  const meterEl = document.getElementById("completion-meter");
  const summaryEl = document.getElementById("completion-summary");

  if (pctEl) pctEl.innerText = `${pct}%`;
  if (summaryEl) summaryEl.innerText = `${doneCount} із ${total} задач виконано`;
  if (meterEl) {
    const offset = 251.2 - (251.2 * pct) / 100;
    meterEl.style.strokeDashoffset = offset;
  }

  // Priority counts (low, mid, high)
  const lowCount = tasks.filter(t => t.difficulty === "low" || t.difficulty === "ez").length;
  const midCount = tasks.filter(t => t.difficulty === "mid").length;
  const highCount = tasks.filter(t => t.difficulty === "high" || t.difficulty === "oh fu..").length;

  const countEzEl = document.getElementById("count-ez");
  const countMidEl = document.getElementById("count-mid");
  const countOhFuEl = document.getElementById("count-oh-fu");

  if (countEzEl) countEzEl.innerText = `${lowCount} низький`;
  if (countMidEl) countMidEl.innerText = `${midCount} середній`;
  if (countOhFuEl) countOhFuEl.innerText = `${highCount} високий`;
}

function renderTagChips(tasks) {
  const container = document.getElementById("tag-chips-container");
  if (!container) return;

  const tagSet = new Set();
  tasks.forEach(t => {
    if (Array.isArray(t.tags)) {
      t.tags.forEach(tag => tagSet.add(tag.trim()));
    }
  });

  if (tagSet.size === 0) {
    container.innerHTML = `<span style="font-size: 11px; color: var(--text-subtle);">Теги відсутні</span>`;
    return;
  }

  container.innerHTML = "";
  tagSet.forEach(tag => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `tag-chip ${activeTagFilter.toLowerCase() === tag.toLowerCase() ? "active" : ""}`;
    chip.textContent = `#${tag}`;
    chip.addEventListener("click", () => {
      activeTagFilter = (activeTagFilter.toLowerCase() === tag.toLowerCase()) ? "" : tag;
      renderBoard();
    });
    container.appendChild(chip);
  });
}

/* ==========================================================
   TASK ACTIONS: CREATE, EDIT, DELETE
   ========================================================== */

function updateAssigneesChecklistState(isAll) {
  const checklist = document.getElementById("task-assignees-checklist");
  const hint = document.getElementById("assignees-hint");
  if (checklist) {
    checklist.style.opacity = isAll ? "0.4" : "1";
    checklist.style.pointerEvents = isAll ? "none" : "auto";
    if (isAll) {
      checklist.querySelectorAll(".user-assignee-cb").forEach(cb => {
        cb.checked = true;
        cb.closest(".assignee-checkbox-item")?.classList.add("selected");
      });
    }
  }
  if (hint) {
    hint.innerText = isAll
      ? "👥 Задачу призначено на ВСІХ учасників цього простору! Будь-хто зможе змінювати її статус."
      : "Оберіть одного або кількох виконавців (або увімкніть «Призначити на всіх»)";
  }
}

function openCreateTaskModal() {
  if (!currentUser) {
    openAuthModal();
    return;
  }

  document.getElementById("task-modal-title").innerText = "Створити задачу";
  document.getElementById("task-id-input").value = "";
  document.getElementById("task-title-input").value = "";
  document.getElementById("task-desc-input").value = "";
  document.getElementById("task-tags-input").value = "";

  // Default priority: mid
  const diffRadios = document.querySelectorAll('input[name="task-difficulty"]');
  diffRadios.forEach(r => r.checked = (r.value === "mid"));

  // Default assign to all: false
  const assignAllCb = document.getElementById("task-assign-all-checkbox");
  if (assignAllCb) {
    assignAllCb.checked = false;
    updateAssigneesChecklistState(false);
  }

  // Populate column selector
  const colSelect = document.getElementById("task-column-select");
  if (colSelect) {
    colSelect.innerHTML = currentColumns.map(col => `
      <option value="${col.status_key}">${getColumnIcon(col.status_key, col.name)} ${escapeHtml(col.name)}</option>
    `).join("");
    const activeTab = document.querySelector(".mobile-board-tab.active")?.dataset.col;
    if (activeTab && currentColumns.some(c => c.status_key === activeTab)) {
      colSelect.value = activeTab;
    } else if (currentColumns[0]) {
      colSelect.value = currentColumns[0].status_key;
    }
  }

  // Check current user by default in checklist
  const checklist = document.getElementById("task-assignees-checklist");
  if (checklist) {
    checklist.querySelectorAll(".user-assignee-cb").forEach(cb => {
      const isMe = currentUser && Number(cb.value) === currentUser.id;
      cb.checked = isMe;
      cb.closest(".assignee-checkbox-item")?.classList.toggle("selected", isMe);
    });
  }

  openModal("task-modal-backdrop");
}

function openEditTaskModal(task) {
  document.getElementById("task-modal-title").innerText = "Редагувати задачу";
  document.getElementById("task-id-input").value = task.id;
  document.getElementById("task-title-input").value = task.title;
  document.getElementById("task-desc-input").value = task.description || "";
  document.getElementById("task-tags-input").value = (task.tags || []).join(", ");

  let normDiff = task.difficulty;
  if (normDiff === "ez") normDiff = "low";
  if (normDiff === "oh fu..") normDiff = "high";

  const diffRadios = document.querySelectorAll('input[name="task-difficulty"]');
  diffRadios.forEach(r => {
    r.checked = (r.value === normDiff || (r.value === "low" && task.difficulty === "ez") || (r.value === "high" && task.difficulty === "oh fu.."));
  });

  const assignAllCb = document.getElementById("task-assign-all-checkbox");
  if (assignAllCb) {
    assignAllCb.checked = Boolean(task.is_all_assignees);
    updateAssigneesChecklistState(task.is_all_assignees);
  }

  // Populate column selector
  const colSelect = document.getElementById("task-column-select");
  if (colSelect) {
    colSelect.innerHTML = currentColumns.map(col => `
      <option value="${col.status_key}" ${col.status_key === task.status ? 'selected' : ''}>${getColumnIcon(col.status_key, col.name)} ${escapeHtml(col.name)}</option>
    `).join("");
    colSelect.value = task.status;
  }

  const checklist = document.getElementById("task-assignees-checklist");
  if (checklist) {
    const assignedIds = new Set((task.assignees || []).map(a => Number(a.id)));
    if (task.assignee_id) assignedIds.add(Number(task.assignee_id));

    checklist.querySelectorAll(".user-assignee-cb").forEach(cb => {
      const isAssigned = assignedIds.has(Number(cb.value));
      cb.checked = isAssigned;
      cb.closest(".assignee-checkbox-item")?.classList.toggle("selected", isAssigned);
    });
  }

  openModal("task-modal-backdrop");
}

async function handleTaskFormSubmit(e) {
  e.preventDefault();
  const taskId = document.getElementById("task-id-input").value;
  const title = document.getElementById("task-title-input").value.trim();
  const description = document.getElementById("task-desc-input").value.trim();
  const tagsStr = document.getElementById("task-tags-input").value;
  const isAllAssignees = document.getElementById("task-assign-all-checkbox").checked;

  let difficulty = "mid";
  const checkedDiff = document.querySelector('input[name="task-difficulty"]:checked');
  if (checkedDiff) {
    difficulty = checkedDiff.value;
  }

  const tags = tagsStr.split(",").map(t => t.trim()).filter(Boolean);

  const assigneeIds = [];
  document.querySelectorAll(".user-assignee-cb:checked").forEach(cb => {
    assigneeIds.push(Number(cb.value));
  });

  const colSelect = document.getElementById("task-column-select");
  const selectedStatus = colSelect ? colSelect.value : (currentColumns[0]?.status_key || "todo");

  const teamParam = (currentWorkspace && currentWorkspace.type === "team")
    ? currentWorkspace.id
    : null;

  try {
    let res;
    if (taskId) {
      // Edit task
      res = await fetch(`/api/tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          status: selectedStatus,
          difficulty,
          tags,
          assigneeIds,
          isAllAssignees
        })
      });
    } else {
      // Create task (default to selected column)
      res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          status: selectedStatus,
          difficulty,
          tags,
          assigneeIds,
          isAllAssignees,
          teamId: teamParam
        })
      });
    }

    const data = await res.json();
    if (data.success) {
      closeModal("task-modal-backdrop");
      showToast(taskId ? "Задачу оновлено" : "Задачу створено", "success");
      await loadTasks();
    } else {
      showToast(data.error || "Помилка при збереженні", "error");
    }
  } catch (err) {
    showToast("Помилка зв'язку із сервером", "error");
  }
}

async function deleteTask(taskId) {
  try {
    const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
    const data = await res.json();
    if (data.success) {
      showToast("Задачу видалено", "info");
      await loadTasks();
    } else {
      showToast(data.error || "Не вдалося видалити", "error");
    }
  } catch (e) {
    showToast("Помилка зв'язку із сервером", "error");
  }
}

/* ==========================================================
   MODALS & EVENT BINDINGS
   ========================================================== */

function openAddColumnModal() {
  const modal = document.getElementById("add-column-modal-backdrop");
  if (!modal) {
    const colName = prompt("Введіть назву нової колонки:");
    if (colName && colName.trim()) {
      createColumnDirectly(colName.trim());
    }
    return;
  }
  const input = document.getElementById("new-column-name-input");
  if (input) input.value = "";
  openModal("add-column-modal-backdrop");
  setTimeout(() => {
    document.getElementById("new-column-name-input")?.focus();
  }, 60);
}

function openEditColumnModal(colId, colName) {
  const modal = document.getElementById("edit-column-modal-backdrop");
  if (!modal) {
    const newName = prompt("Введіть нову назву колонки:", colName);
    if (newName && newName.trim() && newName.trim() !== colName) {
      editColumnDirectly(colId, newName.trim());
    }
    return;
  }
  const idInput = document.getElementById("edit-column-id-input");
  const nameInput = document.getElementById("edit-column-name-input");
  if (idInput) idInput.value = colId;
  if (nameInput) nameInput.value = colName || "";
  openModal("edit-column-modal-backdrop");
  setTimeout(() => {
    document.getElementById("edit-column-name-input")?.focus();
  }, 60);
}

async function handleDeleteColumn(colId, colName) {
  if (!confirm(`Видалити колонку "${colName}"? Усі задачі з цієї колонки будуть автоматично перенесені в іншу колонку.`)) {
    return;
  }

  const teamParam = (currentWorkspace && currentWorkspace.type === "team") ? currentWorkspace.id : "solo";
  try {
    const res = await fetch(`/api/columns/${colId}?teamId=${teamParam}`, { method: "DELETE" });
    const data = await res.json();
    if (data.success) {
      showToast(`Колонку "${colName}" успішно видалено!`, "success");
      await loadBoardColumns();
      await loadTasks();
    } else {
      showToast(data.error || "Не вдалося видалити колонку", "error");
    }
  } catch (err) {
    showToast("Помилка зв'язку із сервером", "error");
  }
}

async function createColumnDirectly(name) {
  const teamParam = (currentWorkspace && currentWorkspace.type === "team") ? currentWorkspace.id : "solo";
  try {
    const res = await fetch("/api/columns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId: teamParam, name })
    });
    const data = await res.json();
    if (data.success) {
      closeModal("add-column-modal-backdrop");
      showToast(`Колонку "${name}" успішно створено!`, "success");
      await loadBoardColumns();
      await loadTasks();
    } else {
      showToast(data.error || "Помилка додавання колонки", "error");
    }
  } catch (err) {
    showToast("Помилка зв'язку із сервером", "error");
  }
}

async function editColumnDirectly(colId, name) {
  const teamParam = (currentWorkspace && currentWorkspace.type === "team") ? currentWorkspace.id : "solo";
  try {
    const res = await fetch(`/api/columns/${colId}?teamId=${teamParam}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (data.success) {
      closeModal("edit-column-modal-backdrop");
      showToast(`Назву колонки змінено на "${name}"`, "success");
      await loadBoardColumns();
      await loadTasks();
    } else {
      showToast(data.error || "Помилка редагування колонки", "error");
    }
  } catch (err) {
    showToast("Помилка зв'язку із сервером", "error");
  }
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) {
    console.error("Modal not found for id:", id);
    return;
  }
  modal.style.display = "flex";
  modal.style.opacity = "1";
  modal.style.visibility = "visible";
  modal.style.pointerEvents = "auto";
  void modal.offsetWidth;
  modal.classList.add("active");
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove("active");
  modal.style.opacity = "0";
  modal.style.visibility = "hidden";
  modal.style.pointerEvents = "none";
  modal.style.display = "none";
}

// Expose modal helpers globally to window
window.openModal = openModal;
window.closeModal = closeModal;
window.openAddColumnModal = openAddColumnModal;
window.openEditColumnModal = openEditColumnModal;
window.handleDeleteColumn = handleDeleteColumn;
window.createColumnDirectly = createColumnDirectly;
window.editColumnDirectly = editColumnDirectly;

function openAuthModal() {
  const err = document.getElementById("auth-error-msg");
  if (err) err.style.display = "none";
  switchAuthTab("login");
  openModal("auth-modal-backdrop");
}

function switchAuthTab(tab) {
  const tabLogin = document.getElementById("tab-login");
  const tabRegister = document.getElementById("tab-register");
  const formLogin = document.getElementById("login-form");
  const formRegister = document.getElementById("register-form");
  const errorBox = document.getElementById("auth-error-msg");

  if (errorBox) errorBox.style.display = "none";

  if (tab === "login") {
    tabLogin?.classList.add("active");
    tabRegister?.classList.remove("active");
    if (formLogin) formLogin.style.display = "flex";
    if (formRegister) formRegister.style.display = "none";
  } else {
    tabRegister?.classList.add("active");
    tabLogin?.classList.remove("active");
    if (formRegister) formRegister.style.display = "flex";
    if (formLogin) formLogin.style.display = "none";
  }
}

function setupEventListeners() {
  // Workspace button
  document.getElementById("btn-workspace-switch")?.addEventListener("click", openWorkspaceModal);
  document.getElementById("btn-close-workspace-modal")?.addEventListener("click", () => closeModal("workspace-modal-backdrop"));
  document.getElementById("workspace-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "workspace-modal-backdrop") closeModal("workspace-modal-backdrop");
  });

  // Workspace tabs
  document.getElementById("tab-ws-list")?.addEventListener("click", () => switchWsTab("list"));
  document.getElementById("tab-ws-create")?.addEventListener("click", () => switchWsTab("create"));
  document.getElementById("tab-ws-join")?.addEventListener("click", () => switchWsTab("join"));

  // Create team form
  document.getElementById("create-team-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("create-team-name").value.trim();
    const password = document.getElementById("create-team-password").value;
    const errorBox = document.getElementById("ws-error-msg");

    try {
      const res = await fetch("/api/teams/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`Команду "${data.team.name}" створено! Ви власник.`, "success");
        await loadTeams();
        await switchWorkspace({ type: "team", id: data.team.id, name: data.team.name, role: "owner" });
        closeModal("workspace-modal-backdrop");
        document.getElementById("create-team-form").reset();
      } else {
        errorBox.innerText = data.error || "Помилка створення команди";
        errorBox.style.display = "block";
      }
    } catch (err) {
      errorBox.innerText = "Помилка зв'язку із сервером";
      errorBox.style.display = "block";
    }
  });

  // Join team form
  document.getElementById("join-team-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("join-team-name").value.trim();
    const password = document.getElementById("join-team-password").value;
    const errorBox = document.getElementById("ws-error-msg");

    try {
      const res = await fetch("/api/teams/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`Ви приєдналися до команди "${data.team.name}"!`, "success");
        await loadTeams();
        await switchWorkspace({ type: "team", id: data.team.id, name: data.team.name, role: "member" });
        closeModal("workspace-modal-backdrop");
        document.getElementById("join-team-form").reset();
      } else {
        errorBox.innerText = data.error || "Помилка приєднання до команди";
        errorBox.style.display = "block";
      }
    } catch (err) {
      errorBox.innerText = "Помилка зв'язку із сервером";
      errorBox.style.display = "block";
    }
  });

  // New task button
  document.getElementById("btn-create-task")?.addEventListener("click", openCreateTaskModal);

  // Task modal close buttons
  document.getElementById("btn-close-task-modal")?.addEventListener("click", () => closeModal("task-modal-backdrop"));
  document.getElementById("btn-cancel-task-modal")?.addEventListener("click", () => closeModal("task-modal-backdrop"));
  document.getElementById("task-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "task-modal-backdrop") closeModal("task-modal-backdrop");
  });

  // Task form submission
  document.getElementById("task-form")?.addEventListener("submit", handleTaskFormSubmit);

  // Auth modal close
  document.getElementById("btn-close-auth-modal")?.addEventListener("click", () => closeModal("auth-modal-backdrop"));
  document.getElementById("auth-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "auth-modal-backdrop") closeModal("auth-modal-backdrop");
  });

  // Auth tabs
  document.getElementById("tab-login")?.addEventListener("click", () => switchAuthTab("login"));
  document.getElementById("tab-register")?.addEventListener("click", () => switchAuthTab("register"));

  // Login form submit
  document.getElementById("login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    const errorBox = document.getElementById("auth-error-msg");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        currentUser = data.user;
        closeModal("auth-modal-backdrop");
        renderAuthHeader();
        showToast(`З поверненням, ${currentUser.name}!`, "success");
        await initWorkspaces();
      } else {
        errorBox.innerText = data.error || "Невірний логін або пароль";
        errorBox.style.display = "block";
      }
    } catch (err) {
      errorBox.innerText = "Помилка зв'язку із сервером";
      errorBox.style.display = "block";
    }
  });

  // Register form submit
  document.getElementById("register-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("reg-username").value.trim();
    const name = document.getElementById("reg-name").value.trim();
    const password = document.getElementById("reg-password").value;
    const errorBox = document.getElementById("auth-error-msg");

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, name, password })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        currentUser = data.user;
        closeModal("auth-modal-backdrop");
        renderAuthHeader();
        showToast(`Вітаємо, ${currentUser.name}! Акаунт успішно створено.`, "success");
        await initWorkspaces();
      } else {
        errorBox.innerText = data.error || "Помилка при реєстрації";
        errorBox.style.display = "block";
      }
    } catch (err) {
      errorBox.innerText = "Помилка зв'язку із сервером";
      errorBox.style.display = "block";
    }
  });

  // Assign to all checkbox toggle
  document.getElementById("task-assign-all-checkbox")?.addEventListener("change", (e) => {
    updateAssigneesChecklistState(e.target.checked);
  });

  // Filters change
  document.getElementById("filter-assignee")?.addEventListener("change", renderBoard);
  document.getElementById("filter-tag")?.addEventListener("input", renderBoard);

  // Quick Move Task modal events
  document.getElementById("btn-close-move-task-modal")?.addEventListener("click", () => closeModal("move-task-modal-backdrop"));
  document.getElementById("move-task-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "move-task-modal-backdrop") closeModal("move-task-modal-backdrop");
  });

  // Global event delegation for Column buttons (Add, Edit, Delete)
  document.addEventListener("click", (e) => {
    const addBtn = e.target.closest("#btn-add-column, #mob-btn-add-column, .btn-add-column, .mobile-add-col-tab");
    if (addBtn) {
      e.preventDefault();
      openAddColumnModal();
      return;
    }

    const editBtn = e.target.closest(".btn-edit-col");
    if (editBtn) {
      e.preventDefault();
      openEditColumnModal(editBtn.dataset.colId, editBtn.dataset.colName);
      return;
    }

    const delBtn = e.target.closest(".btn-delete-col");
    if (delBtn) {
      e.preventDefault();
      handleDeleteColumn(delBtn.dataset.colId, delBtn.dataset.colName);
      return;
    }
  });

  // Add Column Modal events
  document.getElementById("btn-close-add-column-modal")?.addEventListener("click", () => closeModal("add-column-modal-backdrop"));
  document.getElementById("btn-cancel-add-column")?.addEventListener("click", () => closeModal("add-column-modal-backdrop"));
  document.getElementById("add-column-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "add-column-modal-backdrop") closeModal("add-column-modal-backdrop");
  });
  document.getElementById("add-column-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("new-column-name-input").value.trim();
    if (!name) return;
    await createColumnDirectly(name);
  });

  // Edit Column Modal events
  document.getElementById("btn-close-edit-column-modal")?.addEventListener("click", () => closeModal("edit-column-modal-backdrop"));
  document.getElementById("btn-cancel-edit-column")?.addEventListener("click", () => closeModal("edit-column-modal-backdrop"));
  document.getElementById("edit-column-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "edit-column-modal-backdrop") closeModal("edit-column-modal-backdrop");
  });
  document.getElementById("edit-column-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const colId = document.getElementById("edit-column-id-input").value;
    const name = document.getElementById("edit-column-name-input").value.trim();
    if (!name || !colId) return;
    await editColumnDirectly(colId, name);
  });

  // Close any open modal on Escape key
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".modal-backdrop.active").forEach(m => closeModal(m.id));
    }
  });

  // Setup drag and drop on columns
  setupDragAndDrop();
}

/* ==========================================================
   MOBILE & TOUCH ENHANCEMENTS
   ========================================================== */

function initMobileBoardTabs() {
  const tabs = document.querySelectorAll(".mobile-board-tab");
  const board = document.getElementById("kanban-board");
  if (!tabs.length || !board) return;

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      if (tab.id === "mob-btn-add-column") return;
      const colId = `column-${tab.dataset.col}`;
      const column = document.getElementById(colId);
      if (!column) return;

      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      column.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    });
  });

  // Track scroll position to update active tab when user swipes horizontally
  let scrollTimeout;
  board.addEventListener("scroll", () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      const boardRect = board.getBoundingClientRect();
      const boardCenter = boardRect.left + boardRect.width / 2;

      let closestCol = null;
      let minDistance = Infinity;

      currentColumns.forEach(c => {
        const col = document.getElementById(`column-${c.status_key}`);
        if (!col) return;
        const colRect = col.getBoundingClientRect();
        const colCenter = colRect.left + colRect.width / 2;
        const dist = Math.abs(boardCenter - colCenter);
        if (dist < minDistance) {
          minDistance = dist;
          closestCol = c.status_key;
        }
      });

      if (closestCol) {
        tabs.forEach(tab => {
          tab.classList.toggle("active", tab.dataset.col === closestCol);
        });
      }
    }, 80);
  }, { passive: true });
}

let dragAutoScrollTimer = null;

function handleDragAutoScroll(clientX) {
  const board = document.getElementById("kanban-board");
  if (!board) return;

  const edgeMargin = 70; // px threshold from viewport edges
  const scrollSpeed = 16;

  if (clientX < edgeMargin) {
    if (!dragAutoScrollTimer) {
      dragAutoScrollTimer = setInterval(() => {
        board.scrollLeft -= scrollSpeed;
      }, 16);
    }
  } else if (clientX > window.innerWidth - edgeMargin) {
    if (!dragAutoScrollTimer) {
      dragAutoScrollTimer = setInterval(() => {
        board.scrollLeft += scrollSpeed;
      }, 16);
    }
  } else {
    stopDragAutoScroll();
  }
}

function stopDragAutoScroll() {
  if (dragAutoScrollTimer) {
    clearInterval(dragAutoScrollTimer);
    dragAutoScrollTimer = null;
  }
}

function attachTouchDragEvents(card, task) {
  let touchStartPos = { x: 0, y: 0 };
  let isTouchDragging = false;
  let ghostEl = null;
  const mobileTargetsBar = document.getElementById("mobile-drag-targets");

  card.addEventListener("touchstart", (e) => {
    if (e.target.closest("button") || e.target.closest("input") || e.target.closest(".task-tag-pill")) {
      return;
    }
    const touch = e.touches[0];
    touchStartPos = { x: touch.clientX, y: touch.clientY };
    isTouchDragging = false;
  }, { passive: true });

  card.addEventListener("touchmove", (e) => {
    if (!e.touches || e.touches.length === 0) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartPos.x;
    const dy = touch.clientY - touchStartPos.y;

    if (!isTouchDragging && (Math.abs(dx) > 12 || Math.abs(dy) > 12)) {
      isTouchDragging = true;
      draggedTaskId = task.id;
      card.classList.add("is-dragging");

      ghostEl = card.cloneNode(true);
      ghostEl.classList.add("touch-drag-ghost");
      ghostEl.style.width = `${Math.min(card.offsetWidth, 320)}px`;
      document.body.appendChild(ghostEl);

      if (mobileTargetsBar) {
        mobileTargetsBar.classList.add("active");
      }
    }

    if (isTouchDragging && ghostEl) {
      if (e.cancelable) e.preventDefault();
      ghostEl.style.left = `${touch.clientX - 40}px`;
      ghostEl.style.top = `${touch.clientY - 30}px`;

      // Auto-scroll kanban board horizontally near edges
      handleDragAutoScroll(touch.clientX);

      const elem = document.elementFromPoint(touch.clientX, touch.clientY);
      const dropzone = elem?.closest(".column-dropzone");
      const mobileTarget = elem?.closest(".mobile-drop-target");

      document.querySelectorAll(".column-dropzone").forEach(dz => dz.classList.remove("drag-over"));
      document.querySelectorAll(".mobile-drop-target").forEach(mt => mt.classList.remove("drag-over"));

      if (mobileTarget) {
        mobileTarget.classList.add("drag-over");
        const status = mobileTarget.dataset.status;
        const matchingDz = document.getElementById(`dropzone-${status}`);
        if (matchingDz) matchingDz.classList.add("drag-over");
      } else if (dropzone) {
        dropzone.classList.add("drag-over");
        const status = dropzone.dataset.status;
        const matchingMt = document.querySelector(`.mobile-drop-target[data-status="${status}"]`);
        if (matchingMt) matchingMt.classList.add("drag-over");
      }
    }
  }, { passive: false });

  card.addEventListener("touchend", async (e) => {
    stopDragAutoScroll();
    if (mobileTargetsBar) {
      mobileTargetsBar.classList.remove("active");
      document.querySelectorAll(".mobile-drop-target").forEach(mt => mt.classList.remove("drag-over"));
    }

    if (!isTouchDragging) return;
    card.classList.remove("is-dragging");

    if (ghostEl) {
      ghostEl.remove();
      ghostEl = null;
    }

    const touch = e.changedTouches[0];
    const elem = document.elementFromPoint(touch.clientX, touch.clientY);
    const dropzone = elem?.closest(".column-dropzone");
    const mobileTarget = elem?.closest(".mobile-drop-target");

    document.querySelectorAll(".column-dropzone").forEach(dz => dz.classList.remove("drag-over"));

    let targetStatus = null;
    if (mobileTarget) {
      targetStatus = mobileTarget.dataset.status;
    } else if (dropzone) {
      targetStatus = dropzone.dataset.status;
    }

    if (targetStatus && targetStatus !== task.status) {
      await updateTaskStatus(task.id, targetStatus);
    }

    draggedTaskId = null;
    isTouchDragging = false;
  }, { passive: true });

  card.addEventListener("touchcancel", () => {
    stopDragAutoScroll();
    if (mobileTargetsBar) {
      mobileTargetsBar.classList.remove("active");
      document.querySelectorAll(".mobile-drop-target").forEach(mt => mt.classList.remove("drag-over"));
    }
    if (ghostEl) {
      ghostEl.remove();
      ghostEl = null;
    }
    card.classList.remove("is-dragging");
    document.querySelectorAll(".column-dropzone").forEach(dz => dz.classList.remove("drag-over"));
    isTouchDragging = false;
    draggedTaskId = null;
  }, { passive: true });
}

/* ==========================================================
   TOAST HELPER
   ========================================================== */

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerText = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(12px) scale(0.95)";
    toast.style.transition = "all 0.25s ease";
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
