/**
 * Trello-style Kanban Planner Application with Slack-like Workspaces
 * Supports personal spaces, corporate teams (vinsoft, panasonic),
 * multi-assignees, drag & drop, difficulty levels (ez, mid, oh fu..),
 * role-based permissions, tags and filters.
 */

// Global State
let currentUser = null;
let userTeams = [];
let currentWorkspace = null; // { type: 'solo'|'team', id: number|null, name: string }
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
    currentWorkspace = { type: "solo", id: null, name: "Особистий простір" };
  } else if (savedWs) {
    const matchedTeam = userTeams.find(t => String(t.id) === String(savedWs));
    if (matchedTeam) {
      currentWorkspace = { type: "team", id: matchedTeam.id, name: matchedTeam.name };
    }
  }

  // If no saved preference, check if user has teams
  if (!currentWorkspace) {
    if (userTeams.length > 0) {
      currentWorkspace = { type: "team", id: userTeams[0].id, name: userTeams[0].name };
    } else {
      currentWorkspace = { type: "solo", id: null, name: "Особистий простір" };
    }
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

  if (!wrapper || !currentWorkspace) return;
  wrapper.style.display = "flex";

  if (currentWorkspace.type === "solo") {
    iconEl.innerText = "👤";
    nameEl.innerText = "Особистий";
  } else {
    iconEl.innerText = "🏢";
    nameEl.innerText = currentWorkspace.name;
  }
}

async function switchWorkspace(ws, notify = true) {
  currentWorkspace = ws;
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
      } else {
        allUsers = [currentUser];
      }
    } catch (e) {
      allUsers = [currentUser];
    }
  }

  populateAssigneeOptions();
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
    const membersWord = formatMembersCount(t.member_count);

    return `
      <div class="ws-card ${isTeamActive ? 'active' : ''}" id="ws-card-${t.id}">
        <div class="ws-card-main" data-type="team" data-id="${t.id}" data-name="${escapeHtml(t.name)}">
          <div class="ws-card-left">
            <div class="ws-card-icon">🏢</div>
            <div class="ws-card-info">
              <div class="ws-card-title-row">
                <span class="ws-card-title">Команда ${escapeHtml(t.name)}</span>
                <span class="ws-role-pill ${isOwner ? 'owner' : ''}">
                  ${isOwner ? '👑 Власник' : 'Учасник'}
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
          ${isOwner ? `
            <button type="button" class="btn-ws-subaction btn-manage-members" data-id="${t.id}" data-name="${escapeHtml(t.name)}" title="Переглянути та видалити учасників">
              👥 Учасники (${t.member_count})
            </button>
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
        await switchWorkspace({ type: "solo", id: null, name: "Особистий простір" });
      } else {
        const id = Number(cardMain.dataset.id);
        const name = cardMain.dataset.name;
        await switchWorkspace({ type: "team", id, name });
      }
      closeModal("workspace-modal-backdrop");
    });
  });

  // Bind members button (owner)
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

      if (!confirm(`Ви дійсно бажаєте безповоротно видалити корпоративне середовище "${teamName}"? Усі задачі цієї команди будуть видалені.`)) {
        return;
      }

      try {
        const res = await fetch(`/api/teams/${teamId}`, { method: "DELETE" });
        const data = await res.json();
        if (data.success) {
          showToast(`Команду "${teamName}" успішно видалено`, "success");
          if (currentWorkspace?.type === "team" && currentWorkspace?.id === teamId) {
            await switchWorkspace({ type: "solo", id: null, name: "Особистий простір" });
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

  // Bind leave team button (member)
  container.querySelectorAll(".btn-leave-team").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const teamId = Number(btn.dataset.id);
      const teamName = btn.dataset.name;

      if (!confirm(`Ви дійсно бажаєте вийти з корпоративної команди "${teamName}"?`)) {
        return;
      }

      try {
        const res = await fetch(`/api/teams/${teamId}/leave`, { method: "POST" });
        const data = await res.json();
        if (data.success) {
          showToast(`Ви вийшли з команди "${teamName}"`, "info");
          if (currentWorkspace?.type === "team" && currentWorkspace?.id === teamId) {
            await switchWorkspace({ type: "solo", id: null, name: "Особистий простір" });
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
    let membersHtml = members.map(m => {
      const isSelf = currentUser && m.id === currentUser.id;
      const isOwner = m.role === "owner";
      return `
        <div class="ws-member-item">
          <div class="ws-member-left">
            <div class="ws-member-avatar">${escapeHtml((m.name || 'U').charAt(0).toUpperCase())}</div>
            <div class="ws-member-details">
              <span class="ws-member-name">${escapeHtml(m.name)} ${isSelf ? '(Ви)' : ''}</span>
              <span class="ws-member-user">@${escapeHtml(m.username)}</span>
            </div>
          </div>
          <div>
            ${isOwner ? `
              <span class="ws-member-role-badge owner">👑 Власник</span>
            ` : `
              <button type="button" class="btn-kick-member" data-team-id="${teamId}" data-user-id="${m.id}" data-name="${escapeHtml(m.name)}" title="Видалити учасника з команди">
                ❌ Видалити
              </button>
            `}
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
   DATA LOADING (TASKS)
   ========================================================== */

function populateAssigneeOptions() {
  // 1. Filter dropdown
  const filterSelect = document.getElementById("filter-assignee");
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
  ["todo", "in-progress", "done"].forEach(status => {
    const dropzone = document.getElementById(`dropzone-${status}`);
    if (dropzone) {
      dropzone.innerHTML = `<div class="empty-col-placeholder">Увійдіть, щоб переглянути задачі</div>`;
    }
    const countBadge = document.getElementById(`count-col-${status}`);
    if (countBadge) countBadge.textContent = "0";
    const mobCountBadge = document.getElementById(`mob-count-col-${status}`);
    if (mobCountBadge) mobCountBadge.textContent = "0";
  });
  updateDashboardStats([]);
  renderTagChips([]);
}

function renderBoard() {
  const filterAssignee = document.getElementById("filter-assignee").value;
  const filterTagInput = document.getElementById("filter-tag").value.trim().toLowerCase();

  // Filter tasks
  const filteredTasks = allTasks.filter(task => {
    // Assignee filter (supports multiple assignees and is_all_assignees)
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

  // Group by status
  const columns = {
    "todo": document.getElementById("dropzone-todo"),
    "in-progress": document.getElementById("dropzone-in-progress"),
    "done": document.getElementById("dropzone-done")
  };

  Object.values(columns).forEach(col => col.innerHTML = "");

  const counts = { "todo": 0, "in-progress": 0, "done": 0 };

  filteredTasks.forEach(task => {
    if (counts[task.status] !== undefined) {
      counts[task.status]++;
    }
    const col = columns[task.status];
    if (col) {
      col.appendChild(createTaskCardElement(task));
    }
  });

  // Empty state placeholders
  Object.keys(columns).forEach(status => {
    const col = columns[status];
    if (counts[status] === 0) {
      col.innerHTML = `<div class="empty-col-placeholder">Немає задач у цьому списку</div>`;
    }
    const badge = document.getElementById(`count-col-${status}`);
    if (badge) badge.textContent = counts[status];
    const mobBadge = document.getElementById(`mob-count-col-${status}`);
    if (mobBadge) mobBadge.textContent = counts[status];
  });

  updateDashboardStats(filteredTasks);
  renderTagChips(allTasks);
}

function createTaskCardElement(task) {
  const card = document.createElement("div");
  card.className = "task-card";
  card.dataset.taskId = task.id;

  const isAssignee = currentUser && (
    task.is_all_assignees ||
    (Array.isArray(task.assignees) && task.assignees.some(a => a.id === currentUser.id)) ||
    task.assignee_id === currentUser.id
  );
  const isCreator = currentUser && (currentUser.id === task.creator_id);

  if (isAssignee) {
    card.classList.add("is-draggable");
    card.setAttribute("draggable", "true");
  } else {
    card.classList.add("not-draggable");
  }

  // Difficulty Pill class & text
  const diffClass = task.difficulty === "ez" ? "ez" : task.difficulty === "mid" ? "mid" : "oh-fu";

  // Tags HTML
  const tagsHtml = task.tags && task.tags.length
    ? task.tags.map(t => `<span class="task-tag-pill" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join("")
    : "";

  // Actions for creator (Edit & Delete)
  let creatorActionsHtml = "";
  if (isCreator) {
    creatorActionsHtml = `
      <div class="task-actions">
        <button class="btn-icon-action edit-task-btn" title="Редагувати задачу" aria-label="Edit task">✏️</button>
        <button class="btn-icon-action delete delete-task-btn" title="Видалити задачу" aria-label="Delete task">🗑️</button>
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
  const dragHintHtml = isAssignee
    ? `<span class="task-drag-hint can-drag" title="Ви можете перетягувати цю задачу між колонками">⋮⋮ Виконавець (тягни)</span>`
    : `<span class="task-drag-hint locked" title="Переміщувати можуть лише призначені виконавці">🔒 Лише виконавці</span>`;

  // Quick move buttons for mobile / touch accessibility
  let quickMovesHtml = "";
  if (isAssignee) {
    const prevStatus = task.status === "done" ? "in-progress" : task.status === "in-progress" ? "todo" : null;
    const nextStatus = task.status === "todo" ? "in-progress" : task.status === "in-progress" ? "done" : null;

    quickMovesHtml = `
      <div class="task-quick-moves">
        ${prevStatus ? `<button type="button" class="btn-quick-move" data-move-to="${prevStatus}" title="Перемістити назад">◀ ${prevStatus === 'in-progress' ? 'В процесі' : 'До виконання'}</button>` : ""}
        ${nextStatus ? `<button type="button" class="btn-quick-move" data-move-to="${nextStatus}" title="Перемістити вперед">${nextStatus === 'in-progress' ? 'В процесі' : 'Виконано'} ▶</button>` : ""}
      </div>
    `;
  }

  card.innerHTML = `
    <div class="task-top-row">
      <span class="diff-pill ${diffClass}">${escapeHtml(task.difficulty)}</span>
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

  // Bind edit & delete events
  if (isCreator) {
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
  if (isAssignee) {
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
      if (!isCreator) {
        showToast("Переміщувати задачу можуть лише призначені виконавці!", "info");
      }
    });
  }

  return card;
}

/* ==========================================================
   DRAG AND DROP ON COLUMNS
   ========================================================== */

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

      if (!taskId) return;

      const task = allTasks.find(t => t.id === taskId);
      if (!task) return;

      if (task.status === targetStatus) return; // No change

      // Permission Check: allowed for any assignee or anyone if assigned to all!
      const isAssigned = currentUser && (
        task.is_all_assignees ||
        (Array.isArray(task.assignees) && task.assignees.some(a => a.id === currentUser.id)) ||
        task.assignee_id === currentUser.id
      );

      if (!isAssigned) {
        showToast("Переміщувати статус задачі можуть лише призначені виконавці!", "error");
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
          showToast(`Статус змінено на "${targetStatus}"`, "success");
        }
      } catch (err) {
        task.status = prevStatus;
        renderBoard();
        showToast("Помилка зв'язку із сервером", "error");
      }
    });
  });
}

/* ==========================================================
   DASHBOARD STATS & TAGS CHIPS
   ========================================================== */

function updateDashboardStats(tasks) {
  const total = tasks.length;
  const doneCount = tasks.filter(t => t.status === "done").length;
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

  // Difficulty counts
  const ezCount = tasks.filter(t => t.difficulty === "ez").length;
  const midCount = tasks.filter(t => t.difficulty === "mid").length;
  const ohFuCount = tasks.filter(t => t.difficulty === "oh fu..").length;

  document.getElementById("count-ez").innerText = `${ezCount} ez`;
  document.getElementById("count-mid").innerText = `${midCount} mid`;
  document.getElementById("count-oh-fu").innerText = `${ohFuCount} oh fu..`;
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

  // Default difficulty: mid
  const diffRadios = document.querySelectorAll('input[name="task-difficulty"]');
  diffRadios.forEach(r => r.checked = (r.value === "mid"));

  // Default assign to all: false
  const assignAllCb = document.getElementById("task-assign-all-checkbox");
  if (assignAllCb) {
    assignAllCb.checked = false;
    updateAssigneesChecklistState(false);
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

  const diffRadios = document.querySelectorAll('input[name="task-difficulty"]');
  diffRadios.forEach(r => r.checked = (r.value === task.difficulty));

  const isAll = Boolean(task.is_all_assignees);
  const assignAllCb = document.getElementById("task-assign-all-checkbox");
  if (assignAllCb) {
    assignAllCb.checked = isAll;
    updateAssigneesChecklistState(isAll);
  }

  const checklist = document.getElementById("task-assignees-checklist");
  if (checklist) {
    checklist.querySelectorAll(".user-assignee-cb").forEach(cb => {
      const isAssigned = isAll || 
        (Array.isArray(task.assignees) && task.assignees.some(a => a.id === Number(cb.value))) || 
        (task.assignee_id === Number(cb.value));
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
  const difficulty = document.querySelector('input[name="task-difficulty"]:checked')?.value || "mid";
  const isAllAssignees = document.getElementById("task-assign-all-checkbox")?.checked || false;
  const checkedBoxes = document.querySelectorAll('#task-assignees-checklist .user-assignee-cb:checked');
  const assigneeIds = Array.from(checkedBoxes).map(cb => Number(cb.value));
  const rawTags = document.getElementById("task-tags-input").value;

  const tags = rawTags.split(",")
    .map(t => t.trim().replace(/^#/, ""))
    .filter(Boolean);

  if (!title) {
    showToast("Вкажіть назву задачі", "error");
    return;
  }

  if (!isAllAssignees && assigneeIds.length === 0) {
    showToast("Оберіть хоча б одного виконавця або увімкніть «Призначити на всіх»", "error");
    return;
  }

  const teamId = (currentWorkspace && currentWorkspace.type === "team")
    ? currentWorkspace.id
    : null;

  try {
    if (taskId) {
      // EDIT existing task
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, difficulty, assigneeIds, isAllAssignees, tags })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast("Задачу успішно оновлено", "success");
        closeModal("task-modal-backdrop");
        await loadTasks();
      } else {
        showToast(data.error || "Помилка при оновленні задачі", "error");
      }
    } else {
      // CREATE new task
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, difficulty, assigneeIds, isAllAssignees, tags, teamId })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast("Задачу створено!", "success");
        closeModal("task-modal-backdrop");
        await loadTasks();
      } else {
        showToast(data.error || "Помилка при створенні задачі", "error");
      }
    }
  } catch (err) {
    showToast("Помилка збереження задачі", "error");
  }
}

async function deleteTask(taskId) {
  try {
    const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("Задачу видалено", "success");
      await loadTasks();
    } else {
      showToast(data.error || "Помилка видалення", "error");
    }
  } catch (err) {
    showToast("Помилка видалення задачі", "error");
  }
}

/* ==========================================================
   MODAL HELPERS
   ========================================================== */

function openModal(id) {
  document.getElementById(id)?.classList.add("active");
}

function closeModal(id) {
  document.getElementById(id)?.classList.remove("active");
}

function openAuthModal() {
  document.getElementById("auth-error-msg").style.display = "none";
  switchAuthTab("login");
  openModal("auth-modal-backdrop");
}

function switchAuthTab(tab) {
  const tabLogin = document.getElementById("tab-login");
  const tabReg = document.getElementById("tab-register");
  const formLogin = document.getElementById("login-form");
  const formReg = document.getElementById("register-form");
  const errorBox = document.getElementById("auth-error-msg");

  errorBox.style.display = "none";

  if (tab === "login") {
    tabLogin.classList.add("active");
    tabReg.classList.remove("active");
    formLogin.style.display = "flex";
    formReg.style.display = "none";
  } else {
    tabReg.classList.add("active");
    tabLogin.classList.remove("active");
    formLogin.style.display = "none";
    formReg.style.display = "flex";
  }
}

/* ==========================================================
   EVENT LISTENERS SETUP
   ========================================================== */

function setupEventListeners() {
  // Workspace Switcher button in header
  document.getElementById("btn-workspace-switch")?.addEventListener("click", openWorkspaceModal);
  document.getElementById("btn-close-workspace-modal")?.addEventListener("click", () => closeModal("workspace-modal-backdrop"));
  document.getElementById("workspace-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "workspace-modal-backdrop") closeModal("workspace-modal-backdrop");
  });

  // Workspace modal tabs
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
        showToast(`Команду "${data.team.name}" успішно створено!`, "success");
        await loadTeams();
        await switchWorkspace({ type: "team", id: data.team.id, name: data.team.name });
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
        await switchWorkspace({ type: "team", id: data.team.id, name: data.team.name });
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
        // Prompt workspace selection after login
        openWorkspaceModal();
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
        showToast(`Вітаємо, ${currentUser.name}! Акаунт створено.`, "success");
        await initWorkspaces();
        // Prompt workspace selection after register
        openWorkspaceModal();
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

      ["todo", "in-progress", "done"].forEach(status => {
        const col = document.getElementById(`column-${status}`);
        if (!col) return;
        const colRect = col.getBoundingClientRect();
        const colCenter = colRect.left + colRect.width / 2;
        const dist = Math.abs(boardCenter - colCenter);
        if (dist < minDistance) {
          minDistance = dist;
          closestCol = status;
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

function attachTouchDragEvents(card, task) {
  let touchStartPos = { x: 0, y: 0 };
  let isTouchDragging = false;
  let ghostEl = null;

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

    if (!isTouchDragging && (Math.abs(dx) > 14 || Math.abs(dy) > 14)) {
      isTouchDragging = true;
      draggedTaskId = task.id;
      card.classList.add("is-dragging");

      ghostEl = card.cloneNode(true);
      ghostEl.classList.add("touch-drag-ghost");
      ghostEl.style.width = `${card.offsetWidth}px`;
      document.body.appendChild(ghostEl);
    }

    if (isTouchDragging && ghostEl) {
      if (e.cancelable) e.preventDefault();
      ghostEl.style.left = `${touch.clientX - 40}px`;
      ghostEl.style.top = `${touch.clientY - 30}px`;

      const elem = document.elementFromPoint(touch.clientX, touch.clientY);
      const dropzone = elem?.closest(".column-dropzone");
      document.querySelectorAll(".column-dropzone").forEach(dz => dz.classList.remove("drag-over"));
      if (dropzone) {
        dropzone.classList.add("drag-over");
      }
    }
  }, { passive: false });

  card.addEventListener("touchend", async (e) => {
    if (!isTouchDragging) return;
    card.classList.remove("is-dragging");

    if (ghostEl) {
      ghostEl.remove();
      ghostEl = null;
    }

    const touch = e.changedTouches[0];
    const elem = document.elementFromPoint(touch.clientX, touch.clientY);
    const dropzone = elem?.closest(".column-dropzone");
    document.querySelectorAll(".column-dropzone").forEach(dz => dz.classList.remove("drag-over"));

    if (dropzone && draggedTaskId) {
      const newStatus = dropzone.dataset.status;
      if (newStatus && newStatus !== task.status) {
        await updateTaskStatus(task.id, newStatus);
      }
    }
    draggedTaskId = null;
    isTouchDragging = false;
  }, { passive: true });

  card.addEventListener("touchcancel", () => {
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