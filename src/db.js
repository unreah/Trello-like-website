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
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('todo', 'in-progress', 'done')),
    difficulty TEXT NOT NULL CHECK(difficulty IN ('ez', 'mid', 'oh fu..')),
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

// Migrations
try {
  db.exec('ALTER TABLE tasks ADD COLUMN is_all_assignees INTEGER NOT NULL DEFAULT 0;');
} catch (e) {}

try {
  db.exec('ALTER TABLE tasks ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE;');
} catch (e) {}

try {
  db.exec(`
    INSERT OR IGNORE INTO task_assignees (task_id, user_id)
    SELECT id, assignee_id FROM tasks WHERE assignee_id IS NOT NULL;
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

  // Automatically assign new users alternately to vinsoft or panasonic teams
  try {
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const teamName = (totalUsers % 2 === 1) ? 'vinsoft' : 'panasonic';
    const team = db.prepare('SELECT id FROM teams WHERE name = ?').get(teamName);
    if (team) {
      db.prepare(`
        INSERT OR IGNORE INTO team_members (team_id, user_id, role, joined_at)
        VALUES (?, ?, 'member', ?)
      `).run(team.id, newUser.id, now);
    }
  } catch (e) {
    // ignore
  }

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

export function initPresetTeams() {
  const presetTeams = [
    { name: 'vinsoft', password: '1111' },
    { name: 'panasonic', password: '1111' }
  ];

  const now = new Date().toISOString();
  presetTeams.forEach(pt => {
    const existing = db.prepare('SELECT id FROM teams WHERE name = ?').get(pt.name);
    if (!existing) {
      const { hash, salt } = hashPassword(pt.password);
      db.prepare(`
        INSERT INTO teams (name, password_hash, salt, created_at)
        VALUES (?, ?, ?, ?)
      `).run(pt.name, hash, salt, now);
    }
  });

  // Distribute all users across both teams
  try {
    const vinsoft = db.prepare('SELECT id FROM teams WHERE name = ?').get('vinsoft');
    const panasonic = db.prepare('SELECT id FROM teams WHERE name = ?').get('panasonic');
    const allUsers = db.prepare('SELECT id FROM users ORDER BY id ASC').all();

    allUsers.forEach((u, idx) => {
      const teamId = (idx % 2 === 0) ? vinsoft.id : panasonic.id;
      db.prepare(`
        INSERT OR IGNORE INTO team_members (team_id, user_id, role, joined_at)
        VALUES (?, ?, 'member', ?)
      `).run(teamId, u.id, now);
    });
  } catch (e) {
    console.error('Error distributing users across teams:', e);
  }
}

// Seed preset teams on load
initPresetTeams();

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

  // Add owner to team members
  db.prepare(`
    INSERT INTO team_members (team_id, user_id, role, joined_at)
    VALUES (?, ?, 'owner', ?)
  `).run(teamId, ownerId, now);

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
    ORDER BY u.name ASC
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

  // 4. Delete the team itself
  db.prepare('DELETE FROM teams WHERE id = ?').run(tId);

  return true;
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
    // Solo / Personal tasks: team_id IS NULL, and visible only to creator/assignee
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
    // Corporate team tasks
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

  // Fetch all assignees for all tasks
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
      return {
        ...row,
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

  return {
    ...row,
    tags: Array.isArray(parsedTags) ? parsedTags : [],
    is_all_assignees: Boolean(row.is_all_assignees),
    assignees
  };
}

export function createTask({
  title,
  description,
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
  if (!['todo', 'in-progress', 'done'].includes(status)) {
    status = 'todo';
  }
  if (!['ez', 'mid', 'oh fu..'].includes(difficulty)) {
    difficulty = 'mid';
  }

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
  stmt.run(cleanTitle, description || '', status, difficulty, tagsJson, actualCreatorId, primaryAssigneeId, isAll, targetTeamId, now, now);

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
  isAllAssignees
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
  const newDiff = ['ez', 'mid', 'oh fu..'].includes(difficulty) ? difficulty : task.difficulty;
  const newIsAll = isAllAssignees !== undefined ? (isAllAssignees ? 1 : 0) : (task.is_all_assignees ? 1 : 0);
  const newTags = tags !== undefined
    ? JSON.stringify(Array.isArray(tags) ? tags.map(t => String(t).trim()).filter(Boolean) : [])
    : JSON.stringify(task.tags);

  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE tasks
    SET title = ?, description = ?, difficulty = ?, tags = ?, is_all_assignees = ?, updated_at = ?
    WHERE id = ?
  `);
  stmt.run(newTitle, newDesc, newDiff, newTags, newIsAll, now, id);

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
  if (!['todo', 'in-progress', 'done'].includes(status)) {
    throw new Error('Недійсний статус задачі');
  }
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE tasks
    SET status = ?, updated_at = ?
    WHERE id = ?
  `);
  stmt.run(status, now, id);
  return getTaskById(id);
}

export function deleteTask(id) {
  const stmt = db.prepare('DELETE FROM tasks WHERE id = ?');
  stmt.run(id);
}

export default db;
