import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../database.sqlite');
const db = new DatabaseSync(dbPath);

// Enable foreign keys
db.exec('PRAGMA foreign_keys = ON;');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team_members (
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member', -- 'owner', 'admin', 'member'
    joined_at TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS board_columns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE, -- NULL for solo/personal workspace
    name TEXT NOT NULL,
    status_key TEXT NOT NULL,
    color TEXT DEFAULT '',
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    difficulty TEXT NOT NULL DEFAULT 'mid', -- 'low', 'mid', 'high'
    tags TEXT DEFAULT '[]',
    creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    is_all_assignees INTEGER NOT NULL DEFAULT 0,
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_assignees (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme TEXT NOT NULL DEFAULT 'theme-terracotta'
  );
`);

// Migration: Check if tasks table has old restrictive CHECK constraints
try {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get()?.sql || '';
  if (tableSql.includes('CHECK(status') || tableSql.includes('CHECK(difficulty')) {
    // Migrate tasks table to remove check constraints
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
      CREATE TABLE tasks_temp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        difficulty TEXT NOT NULL DEFAULT 'mid',
        tags TEXT DEFAULT '[]',
        creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        is_all_assignees INTEGER NOT NULL DEFAULT 0,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO tasks_temp (id, title, description, status, difficulty, tags, creator_id, assignee_id, is_all_assignees, team_id, created_at, updated_at)
      SELECT id, title, description, status, 
        CASE 
          WHEN difficulty = 'ez' THEN 'low'
          WHEN difficulty = 'oh fu..' THEN 'high'
          ELSE difficulty 
        END,
        tags, creator_id, assignee_id, is_all_assignees, team_id, created_at, updated_at
      FROM tasks;

      DROP TABLE tasks;
      ALTER TABLE tasks_temp RENAME TO tasks;
    `);
    db.exec('PRAGMA foreign_keys = ON;');
  }
} catch (e) {
  console.warn('Tasks table migration note:', e.message);
}

// Convert any legacy difficulty values in existing database
try {
  db.exec(`
    UPDATE tasks SET difficulty = 'low' WHERE difficulty = 'ez';
    UPDATE tasks SET difficulty = 'high' WHERE difficulty = 'oh fu..';
  `);
} catch (e) {}

/* ==========================================================
   PASSWORD & CRYPTO HELPERS
   ========================================================== */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const checkHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(checkHash, 'hex'));
}

/* ==========================================================
   USER & AUTH HELPERS
   ========================================================== */

export function createUser(username, name, password) {
  const cleanUsername = username.trim();
  const cleanName = name.trim();
  if (!cleanUsername || !cleanName || !password) {
    throw new Error("Усі поля є обов'язковими");
  }
  if (cleanUsername.length < 3) {
    throw new Error("Юзернейм має містити щонайменше 3 символи");
  }
  if (password.length < 4) {
    throw new Error("Пароль має містити щонайменше 4 символи");
  }

  const { hash, salt } = hashPassword(password);
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO users (username, name, password_hash, salt, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(cleanUsername, cleanName, hash, salt, now);

  const getStmt = db.prepare('SELECT id, username, name, created_at FROM users WHERE username = ?');
  const newUser = getStmt.get(cleanUsername);

  // Note: New users are NOT automatically assigned to any corporate teams.
  // They start with a clean personal workspace and join or create teams explicitly.

  return newUser;
}

export function authenticateUser(username, password) {
  const cleanUsername = username.trim();
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  const user = stmt.get(cleanUsername);
  if (!user) {
    return null;
  }
  const isValid = verifyPassword(password, user.password_hash, user.salt);
  if (!isValid) {
    return null;
  }
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    created_at: user.created_at
  };
}

export function getAllUsers() {
  const stmt = db.prepare('SELECT id, username, name FROM users ORDER BY name ASC');
  return stmt.all();
}

export function getUserById(id) {
  const stmt = db.prepare('SELECT id, username, name, created_at FROM users WHERE id = ?');
  return stmt.get(id);
}

/* ==========================================================
   SESSION HELPERS
   ========================================================== */

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

  const stmt = db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(token, userId, now.toISOString(), expiresAt.toISOString());
  return token;
}

export function getUserBySession(token) {
  if (!token) return null;
  const stmt = db.prepare(`
    SELECT u.id, u.username, u.name, u.created_at, s.expires_at, us.theme
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    LEFT JOIN user_settings us ON us.user_id = u.id
    WHERE s.token = ?
  `);
  const row = stmt.get(token);
  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    deleteSession(token);
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    name: row.name,
    created_at: row.created_at,
    theme: row.theme || 'theme-terracotta'
  };
}

export function deleteSession(token) {
  const stmt = db.prepare('DELETE FROM sessions WHERE token = ?');
  stmt.run(token);
}

export function setUserTheme(userId, theme) {
  const stmt = db.prepare(`
    INSERT INTO user_settings (user_id, theme)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme
  `);
  stmt.run(userId, theme);
}

/* ==========================================================
   TEAMS & WORKSPACES HELPERS
   ========================================================== */

export function createTeam(name, password, ownerId) {
  const cleanName = name.trim().toLowerCase();
  if (!cleanName || !password) {
    throw new Error('Назва команди та пароль обов’язкові');
  }
  if (cleanName.length < 2) {
    throw new Error('Назва команди має бути не менше 2 символів');
  }

  const existing = db.prepare('SELECT id FROM teams WHERE name = ?').get(cleanName);
  if (existing) {
    throw new Error(`Команда з назвою "${cleanName}" вже існує`);
  }

  const { hash, salt } = hashPassword(password);
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO teams (name, password_hash, salt, owner_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(cleanName, hash, salt, ownerId, now);

  const teamId = db.prepare('SELECT last_insert_rowid() as id').get().id;

  // Add owner to team members as 'owner'
  db.prepare(`
    INSERT INTO team_members (team_id, user_id, role, joined_at)
    VALUES (?, ?, 'owner', ?)
  `).run(teamId, ownerId, now);

  // Initialize default 3 columns for this team
  initDefaultColumnsForTeam(teamId);

  return getTeamById(teamId);
}

export function joinTeam(name, password, userId) {
  const cleanName = name.trim().toLowerCase();
  const team = db.prepare('SELECT * FROM teams WHERE name = ?').get(cleanName);
  if (!team) {
    throw new Error(`Команду "${cleanName}" не знайдено`);
  }

  const isValid = verifyPassword(password, team.password_hash, team.salt);
  if (!isValid) {
    throw new Error('Невірний пароль для приєднання до команди');
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO team_members (team_id, user_id, role, joined_at)
    VALUES (?, ?, 'member', ?)
  `).run(team.id, userId, now);

  return getTeamById(team.id);
}

export function getTeamById(teamId) {
  const stmt = db.prepare(`
    SELECT t.id, t.name, t.owner_id, t.created_at,
      COUNT(tm.user_id) as member_count
    FROM teams t
    LEFT JOIN team_members tm ON tm.team_id = t.id
    WHERE t.id = ?
    GROUP BY t.id
  `);
  return stmt.get(teamId);
}

export function getUserTeams(userId) {
  const stmt = db.prepare(`
    SELECT t.id, t.name, t.owner_id, tm.role, tm.joined_at,
      (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
    FROM team_members tm
    JOIN teams t ON tm.team_id = t.id
    WHERE tm.user_id = ?
    ORDER BY t.name ASC
  `);
  return stmt.all(userId);
}

export function getTeamMembers(teamId) {
  const stmt = db.prepare(`
    SELECT u.id, u.username, u.name, tm.role, tm.joined_at
    FROM team_members tm
    JOIN users u ON tm.user_id = u.id
    WHERE tm.team_id = ?
    ORDER BY 
      CASE tm.role 
        WHEN 'owner' THEN 1 
        WHEN 'admin' THEN 2 
        ELSE 3 
      END,
      u.name ASC
  `);
  return stmt.all(teamId);
}

export function isUserInTeam(teamId, userId) {
  if (!teamId || !userId) return false;
  const row = db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
  return Boolean(row);
}

export function getTeamRole(teamId, userId) {
  if (!teamId || !userId) return null;
  const row = db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
  return row ? row.role : null;
}

export function isTeamAdmin(teamId, userId) {
  if (!teamId || !userId) return false;
  const role = getTeamRole(teamId, userId);
  return role === 'owner' || role === 'admin';
}

export function updateMemberRole(teamId, targetUserId, newRole) {
  const tId = Number(teamId);
  const uId = Number(targetUserId);

  if (!['admin', 'member'].includes(newRole)) {
    throw new Error("Недійсна роль користувача");
  }

  const team = getTeamById(tId);
  if (!team) throw new Error("Команду не знайдено");
  if (team.owner_id === uId) {
    throw new Error("Неможливо змінити роль власника команди");
  }

  const stmt = db.prepare(`
    UPDATE team_members 
    SET role = ? 
    WHERE team_id = ? AND user_id = ?
  `);
  stmt.run(newRole, tId, uId);

  return true;
}

export function removeUserFromTeam(teamId, userId) {
  const tId = Number(teamId);
  const uId = Number(userId);

  // 1. Remove from team_members
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(tId, uId);

  // 2. Remove user assignments from tasks belonging to this team
  db.prepare(`
    DELETE FROM task_assignees 
    WHERE user_id = ? AND task_id IN (SELECT id FROM tasks WHERE team_id = ?)
  `).run(uId, tId);

  // 3. Fallback primary assignee to task creator if it was this user
  db.prepare(`
    UPDATE tasks 
    SET assignee_id = creator_id 
    WHERE team_id = ? AND assignee_id = ?
  `).run(tId, uId);

  return true;
}

export function deleteTeam(teamId) {
  const tId = Number(teamId);

  // 1. Remove assignments for all tasks belonging to this team
  db.prepare(`
    DELETE FROM task_assignees 
    WHERE task_id IN (SELECT id FROM tasks WHERE team_id = ?)
  `).run(tId);

  // 2. Remove all tasks belonging to this team
  db.prepare('DELETE FROM tasks WHERE team_id = ?').run(tId);

  // 3. Remove team members
  db.prepare('DELETE FROM team_members WHERE team_id = ?').run(tId);

  // 4. Remove custom columns for this team
  db.prepare('DELETE FROM board_columns WHERE team_id = ?').run(tId);

  // 5. Delete the team itself
  db.prepare('DELETE FROM teams WHERE id = ?').run(tId);

  return true;
}

/* ==========================================================
   DYNAMIC BOARD COLUMNS HELPERS
   ========================================================== */

function initDefaultColumnsForTeam(teamId) {
  const now = new Date().toISOString();
  const defaultCols = [
    { name: 'До виконання', status_key: 'todo', order_index: 0 },
    { name: 'В процесі', status_key: 'in-progress', order_index: 1 },
    { name: 'Виконано', status_key: 'done', order_index: 2 }
  ];

  const stmt = db.prepare(`
    INSERT INTO board_columns (team_id, name, status_key, color, order_index, created_at)
    VALUES (?, ?, ?, '', ?, ?)
  `);

  for (const c of defaultCols) {
    stmt.run(teamId, c.name, c.status_key, c.order_index, now);
  }
}

export function getBoardColumns(teamId = null) {
  const targetTeamId = (teamId && teamId !== 'solo') ? Number(teamId) : null;

  let query = 'SELECT * FROM board_columns WHERE ';
  if (targetTeamId === null) {
    query += 'team_id IS NULL ORDER BY order_index ASC, id ASC';
  } else {
    query += 'team_id = ? ORDER BY order_index ASC, id ASC';
  }

  const stmt = db.prepare(query);
  let cols = targetTeamId === null ? stmt.all() : stmt.all(targetTeamId);

  if (cols.length === 0) {
    initDefaultColumnsForTeam(targetTeamId);
    cols = targetTeamId === null ? stmt.all() : stmt.all(targetTeamId);
  }

  return cols;
}

export function createBoardColumn({ teamId = null, name, color = '' }) {
  const cleanName = (name || '').trim();
  if (!cleanName) {
    throw new Error('Назва колонки є обов’язковою');
  }

  const targetTeamId = (teamId && teamId !== 'solo') ? Number(teamId) : null;

  // Generate unique status key
  const randomSuffix = Math.random().toString(36).substring(2, 7);
  const slug = cleanName
    .toLowerCase()
    .replace(/[^a-z0-9а-яіїєґ]/gi, '-')
    .substring(0, 15);
  const statusKey = `col_${slug}_${randomSuffix}`;

  // Get max order_index
  const maxOrderQuery = targetTeamId === null
    ? 'SELECT MAX(order_index) as max_order FROM board_columns WHERE team_id IS NULL'
    : 'SELECT MAX(order_index) as max_order FROM board_columns WHERE team_id = ?';
  const maxRow = targetTeamId === null
    ? db.prepare(maxOrderQuery).get()
    : db.prepare(maxOrderQuery).get(targetTeamId);
  const nextOrder = (maxRow?.max_order ?? -1) + 1;

  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO board_columns (team_id, name, status_key, color, order_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(targetTeamId, cleanName, statusKey, color || '', nextOrder, now);

  const colId = db.prepare('SELECT last_insert_rowid() as id').get().id;
  return db.prepare('SELECT * FROM board_columns WHERE id = ?').get(colId);
}

export function updateBoardColumn(columnId, { name, color }) {
  const col = db.prepare('SELECT * FROM board_columns WHERE id = ?').get(Number(columnId));
  if (!col) {
    throw new Error('Колонку не знайдено');
  }

  const cleanName = name !== undefined ? name.trim() : col.name;
  if (!cleanName) {
    throw new Error('Назва колонки не може бути порожньою');
  }
  const cleanColor = color !== undefined ? color : col.color;

  db.prepare(`
    UPDATE board_columns 
    SET name = ?, color = ? 
    WHERE id = ?
  `).run(cleanName, cleanColor, Number(columnId));

  return db.prepare('SELECT * FROM board_columns WHERE id = ?').get(Number(columnId));
}

export function deleteBoardColumn(columnId) {
  const colId = Number(columnId);
  const col = db.prepare('SELECT * FROM board_columns WHERE id = ?').get(colId);
  if (!col) {
    throw new Error('Колонку не знайдено');
  }

  // Check remaining count of columns
  const allCols = getBoardColumns(col.team_id);
  if (allCols.length <= 1) {
    throw new Error('Неможливо видалити останню колонку на дошці');
  }

  // Find a fallback column
  const fallbackCol = allCols.find(c => c.id !== colId) || allCols[0];

  // Move any tasks in this column to fallback column
  if (col.team_id === null) {
    db.prepare(`
      UPDATE tasks 
      SET status = ?, updated_at = ? 
      WHERE team_id IS NULL AND status = ?
    `).run(fallbackCol.status_key, new Date().toISOString(), col.status_key);
  } else {
    db.prepare(`
      UPDATE tasks 
      SET status = ?, updated_at = ? 
      WHERE team_id = ? AND status = ?
    `).run(fallbackCol.status_key, new Date().toISOString(), col.team_id, col.status_key);
  }

  // Delete the column
  db.prepare('DELETE FROM board_columns WHERE id = ?').run(colId);

  return { success: true, fallbackStatus: fallbackCol.status_key };
}

/* ==========================================================
   TASK HELPERS
   ========================================================== */

export function isUserAssigned(task, userId) {
  if (!task || !userId) return false;
  if (task.is_all_assignees) return true;
  if (Array.isArray(task.assignees)) {
    return task.assignees.some(a => Number(a.id) === Number(userId));
  }
  if (task.assignee_id && Number(task.assignee_id) === Number(userId)) return true;
  return false;
}

export function canUserManageTask(task, userId) {
  if (!task || !userId) return false;
  const uId = Number(userId);
  if (task.creator_id === uId) return true;
  if (task.team_id && isTeamAdmin(task.team_id, uId)) return true;
  return false;
}

export function canUserMoveTask(task, userId) {
  if (!task || !userId) return false;
  const uId = Number(userId);
  if (isUserAssigned(task, uId)) return true;
  if (task.creator_id === uId) return true;
  if (task.team_id && isTeamAdmin(task.team_id, uId)) return true;
  return false;
}

export function getTasks({ teamId, userId, assigneeId, tag } = {}) {
  let query = `
    SELECT 
      t.id, t.title, t.description, t.status, t.difficulty, t.tags,
      t.creator_id, t.assignee_id, t.is_all_assignees, t.team_id, t.created_at, t.updated_at,
      u_c.name AS creator_name, u_c.username AS creator_username
    FROM tasks t
    JOIN users u_c ON t.creator_id = u_c.id
    WHERE 1=1
  `;
  const params = [];

  // Filter by Workspace/Team
  if (teamId === 'solo' || teamId === null || teamId === undefined || teamId === '') {
    query += ' AND t.team_id IS NULL';
    if (userId) {
      query += ` AND (
        t.creator_id = ? 
        OR t.assignee_id = ? 
        OR t.id IN (SELECT task_id FROM task_assignees WHERE user_id = ?)
      )`;
      params.push(Number(userId), Number(userId), Number(userId));
    }
  } else {
    query += ' AND t.team_id = ?';
    params.push(Number(teamId));
  }

  // Filter by assignee
  if (assigneeId) {
    query += ` AND (
      t.is_all_assignees = 1
      OR t.id IN (SELECT task_id FROM task_assignees WHERE user_id = ?)
      OR t.assignee_id = ?
    )`;
    params.push(Number(assigneeId), Number(assigneeId));
  }

  query += ' ORDER BY t.id DESC';

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);

  // Fetch all assignees for tasks
  const assigneesStmt = db.prepare(`
    SELECT ta.task_id, u.id, u.username, u.name
    FROM task_assignees ta
    JOIN users u ON ta.user_id = u.id
  `);
  const allTaskAssignees = assigneesStmt.all();
  const assigneesByTaskId = {};
  for (const a of allTaskAssignees) {
    if (!assigneesByTaskId[a.task_id]) {
      assigneesByTaskId[a.task_id] = [];
    }
    assigneesByTaskId[a.task_id].push({ id: a.id, username: a.username, name: a.name });
  }

  return rows
    .map(row => {
      let parsedTags = [];
      try {
        parsedTags = JSON.parse(row.tags);
      } catch (e) {
        parsedTags = [];
      }

      // Normalize difficulty to low / mid / high
      let diff = row.difficulty;
      if (diff === 'ez') diff = 'low';
      if (diff === 'oh fu..') diff = 'high';

      return {
        ...row,
        difficulty: diff,
        tags: Array.isArray(parsedTags) ? parsedTags : [],
        is_all_assignees: Boolean(row.is_all_assignees),
        assignees: assigneesByTaskId[row.id] || []
      };
    })
    .filter(row => {
      if (tag && tag.trim()) {
        const cleanTag = tag.trim().toLowerCase();
        return row.tags.some(t => t.toLowerCase() === cleanTag);
      }
      return true;
    });
}

export function getTaskById(id) {
  const stmt = db.prepare(`
    SELECT 
      t.id, t.title, t.description, t.status, t.difficulty, t.tags,
      t.creator_id, t.assignee_id, t.is_all_assignees, t.team_id, t.created_at, t.updated_at,
      u_c.name AS creator_name, u_c.username AS creator_username
    FROM tasks t
    JOIN users u_c ON t.creator_id = u_c.id
    WHERE t.id = ?
  `);
  const row = stmt.get(id);
  if (!row) return null;

  let parsedTags = [];
  try {
    parsedTags = JSON.parse(row.tags);
  } catch (e) {
    parsedTags = [];
  }

  const assigneesStmt = db.prepare(`
    SELECT u.id, u.username, u.name
    FROM task_assignees ta
    JOIN users u ON ta.user_id = u.id
    WHERE ta.task_id = ?
  `);
  const assignees = assigneesStmt.all(id);

  let diff = row.difficulty;
  if (diff === 'ez') diff = 'low';
  if (diff === 'oh fu..') diff = 'high';

  return {
    ...row,
    difficulty: diff,
    tags: Array.isArray(parsedTags) ? parsedTags : [],
    is_all_assignees: Boolean(row.is_all_assignees),
    assignees
  };
}

export function createTask({
  title,
  description = '',
  status = 'todo',
  difficulty = 'mid',
  tags = [],
  creatorId,
  creator_id,
  assigneeIds = [],
  assignee_ids,
  isAllAssignees = false,
  is_all_assignees,
  teamId = null,
  team_id
}) {
  const actualCreatorId = creatorId ?? creator_id;
  const actualAssigneeIds = assigneeIds.length ? assigneeIds : (assignee_ids || []);
  const actualIsAll = isAllAssignees || is_all_assignees || false;
  const actualTeamId = teamId ?? team_id ?? null;
  const cleanTitle = (title || '').trim();
  if (!cleanTitle) {
    throw new Error('Назва задачі обов’язкова');
  }

  // Normalize difficulty
  let normalizedDiff = 'mid';
  if (difficulty === 'low' || difficulty === 'ez') normalizedDiff = 'low';
  else if (difficulty === 'high' || difficulty === 'oh fu..' || difficulty === 'critical') normalizedDiff = 'high';
  else normalizedDiff = 'mid';

  const tagsJson = JSON.stringify(
    Array.isArray(tags)
      ? tags.map(t => String(t).trim()).filter(Boolean)
      : []
  );

  const now = new Date().toISOString();
  const isAll = actualIsAll ? 1 : 0;
  const primaryAssigneeId = actualAssigneeIds && actualAssigneeIds.length ? Number(actualAssigneeIds[0]) : actualCreatorId;
  const targetTeamId = actualTeamId ? Number(actualTeamId) : null;

  const stmt = db.prepare(`
    INSERT INTO tasks (title, description, status, difficulty, tags, creator_id, assignee_id, is_all_assignees, team_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(cleanTitle, description || '', status || 'todo', normalizedDiff, tagsJson, actualCreatorId, primaryAssigneeId, isAll, targetTeamId, now, now);

  const lastIdStmt = db.prepare('SELECT last_insert_rowid() as id');
  const lastId = lastIdStmt.get().id;

  if (Array.isArray(actualAssigneeIds) && actualAssigneeIds.length > 0) {
    const insertAssignee = db.prepare(`
      INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)
    `);
    for (const uid of actualAssigneeIds) {
      if (uid) insertAssignee.run(lastId, Number(uid));
    }
  }

  return getTaskById(lastId);
}

export function updateTask(id, {
  title,
  description,
  difficulty,
  tags,
  assigneeIds,
  isAllAssignees,
  status
}) {
  const task = getTaskById(id);
  if (!task) {
    throw new Error('Задачу не знайдено');
  }

  const newTitle = title !== undefined ? title.trim() : task.title;
  if (!newTitle) {
    throw new Error('Назва задачі не може бути порожньою');
  }
  const newDesc = description !== undefined ? description : task.description;

  let newDiff = task.difficulty;
  if (difficulty) {
    if (difficulty === 'low' || difficulty === 'ez') newDiff = 'low';
    else if (difficulty === 'high' || difficulty === 'oh fu..' || difficulty === 'critical') newDiff = 'high';
    else newDiff = 'mid';
  }

  const newIsAll = isAllAssignees !== undefined ? (isAllAssignees ? 1 : 0) : (task.is_all_assignees ? 1 : 0);
  const newTags = tags !== undefined
    ? JSON.stringify(Array.isArray(tags) ? tags.map(t => String(t).trim()).filter(Boolean) : [])
    : JSON.stringify(task.tags);

  const newStatus = status !== undefined && status.trim() ? status.trim() : task.status;

  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE tasks
    SET title = ?, description = ?, difficulty = ?, tags = ?, is_all_assignees = ?, status = ?, updated_at = ?
    WHERE id = ?
  `);
  stmt.run(newTitle, newDesc, newDiff, newTags, newIsAll, newStatus, now, id);

  if (assigneeIds !== undefined && Array.isArray(assigneeIds)) {
    db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(id);
    const insertAssignee = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)');
    for (const uid of assigneeIds) {
      if (uid) insertAssignee.run(id, Number(uid));
    }
  }

  return getTaskById(id);
}

export function updateTaskStatus(id, status) {
  if (!status || !status.trim()) {
    throw new Error('Недійсний статус задачі');
  }
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE tasks
    SET status = ?, updated_at = ?
    WHERE id = ?
  `);
  stmt.run(status.trim(), now, id);
  return getTaskById(id);
}

export function deleteTask(id) {
  const stmt = db.prepare('DELETE FROM tasks WHERE id = ?');
  stmt.run(id);
}

export function cleanDatabase() {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    DELETE FROM sessions;
    DELETE FROM task_assignees;
    DELETE FROM tasks;
    DELETE FROM board_columns;
    DELETE FROM team_members;
    DELETE FROM teams;
    DELETE FROM user_settings;
    DELETE FROM users;
  `);
  db.exec('PRAGMA foreign_keys = ON;');
}

export default db;
