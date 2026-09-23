import express from 'express';
import {
  createUser,
  authenticateUser,
  getAllUsers,
  createSession,
  getUserBySession,
  deleteSession,
  setUserTheme,
  createTeam,
  joinTeam,
  getUserTeams,
  getTeamMembers,
  getTeamById,
  isUserInTeam,
  getTeamRole,
  removeUserFromTeam,
  deleteTeam,
  getTasks,
  getTaskById,
  createTask,
  updateTask,
  updateTaskStatus,
  deleteTask,
  isUserAssigned
} from './db.js';

const app = express();

// Helper to parse cookies from headers
function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (!rc) return list;
  rc.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const key = parts.shift().trim();
    if (key) {
      list[key] = decodeURIComponent(parts.join('='));
    }
  });
  return list;
}

// Global middlewares
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb' }));

// Auth session middleware
app.use((req, res, next) => {
  const cookies = parseCookies(req);
  const token = cookies.session || (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));
  if (token) {
    const user = getUserBySession(token);
    if (user) {
      req.user = user;
      req.sessionToken = token;
    }
  }
  next();
});

// Guard middleware for protected routes
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Будь ласка, увійдіть у свій акаунт' });
  }
  next();
}

/* ==========================================================
   AUTH ROUTES
   ========================================================== */

app.post('/api/auth/register', (req, res) => {
  try {
    const { username, name, password } = req.body || {};
    if (!username || !name || !password) {
      return res.status(400).json({ success: false, error: "Усі поля обов'язкові" });
    }

    const user = createUser(username, name, password);
    const token = createSession(user.id);

    res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
    res.json({ success: true, user });
  } catch (err) {
    console.error('Register error:', err);
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ success: false, error: 'Користувач із таким логіном вже існує' });
    }
    res.status(400).json({ success: false, error: err.message || 'Помилка при реєстрації' });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Введіть логін та пароль' });
    }

    const user = authenticateUser(username, password);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Невірний логін або пароль' });
    }

    const token = createSession(user.id);
    res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
    res.json({ success: true, user });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Помилка при вході' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  if (req.sessionToken) {
    deleteSession(req.sessionToken);
  }
  res.setHeader('Set-Cookie', 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax');
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ success: true, user: req.user || null });
});

/* ==========================================================
   USERS ROUTES
   ========================================================== */

app.get('/api/users', requireAuth, (req, res) => {
  try {
    const users = getAllUsers();
    res.json({ success: true, users });
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ==========================================================
   TEAMS & WORKSPACES ROUTES (SLACK STYLE)
   ========================================================== */

app.get('/api/teams', requireAuth, (req, res) => {
  try {
    const teams = getUserTeams(req.user.id);
    res.json({ success: true, teams });
  } catch (err) {
    console.error('Get teams error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/teams/create', requireAuth, (req, res) => {
  try {
    const { name, password } = req.body || {};
    if (!name || !password) {
      return res.status(400).json({ success: false, error: 'Вкажіть назву команди та пароль' });
    }
    const team = createTeam(name, password, req.user.id);
    res.json({ success: true, team });
  } catch (err) {
    console.error('Create team error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/teams/join', requireAuth, (req, res) => {
  try {
    const { name, password } = req.body || {};
    if (!name || !password) {
      return res.status(400).json({ success: false, error: 'Вкажіть назву команди та пароль' });
    }
    const team = joinTeam(name, password, req.user.id);
    res.json({ success: true, team });
  } catch (err) {
    console.error('Join team error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/teams/:id/members', requireAuth, (req, res) => {
  try {
    const teamId = Number(req.params.id);
    if (!isUserInTeam(teamId, req.user.id)) {
      return res.status(403).json({ success: false, error: 'Ви не є учасником цієї команди' });
    }
    const members = getTeamMembers(teamId);
    res.json({ success: true, members });
  } catch (err) {
    console.error('Get team members error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Leave team (for regular members)
app.post('/api/teams/:id/leave', requireAuth, (req, res) => {
  try {
    const teamId = Number(req.params.id);
    if (!isUserInTeam(teamId, req.user.id)) {
      return res.status(400).json({ success: false, error: 'Ви не є учасником цієї команди' });
    }

    const role = getTeamRole(teamId, req.user.id);
    if (role === 'owner') {
      return res.status(400).json({
        success: false,
        error: 'Власник не може покинути команду. Ви можете видалити команду або передати права.'
      });
    }

    removeUserFromTeam(teamId, req.user.id);
    res.json({ success: true, message: 'Ви успішно вийшли з команди' });
  } catch (err) {
    console.error('Leave team error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Remove/kick a user from team (owner only)
app.delete('/api/teams/:id/members/:userId', requireAuth, (req, res) => {
  try {
    const teamId = Number(req.params.id);
    const targetUserId = Number(req.params.userId);

    const requesterRole = getTeamRole(teamId, req.user.id);
    if (requesterRole !== 'owner') {
      return res.status(403).json({ success: false, error: 'Тільки власник команди може видаляти учасників' });
    }

    if (targetUserId === req.user.id) {
      return res.status(400).json({ success: false, error: 'Власник не може видалити самого себе з команди' });
    }

    if (!isUserInTeam(teamId, targetUserId)) {
      return res.status(404).json({ success: false, error: 'Цього користувача немає в команді' });
    }

    removeUserFromTeam(teamId, targetUserId);
    res.json({ success: true, message: 'Користувача видалено з команди' });
  } catch (err) {
    console.error('Kick user error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete team and all its workspace data (owner only)
app.delete('/api/teams/:id', requireAuth, (req, res) => {
  try {
    const teamId = Number(req.params.id);
    const team = getTeamById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, error: 'Команду не знайдено' });
    }

    const requesterRole = getTeamRole(teamId, req.user.id);
    if (requesterRole !== 'owner') {
      return res.status(403).json({ success: false, error: 'Тільки власник може видалити корпоративне середовище' });
    }

    deleteTeam(teamId);
    res.json({ success: true, message: `Команду "${team.name}" успішно видалено` });
  } catch (err) {
    console.error('Delete team error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ==========================================================
   TASKS ROUTES (WITH WORKSPACE & PERMISSION CHECKS)
   ========================================================== */

// Get tasks for active workspace (teamId or 'solo')
app.get('/api/tasks', requireAuth, (req, res) => {
  try {
    const { teamId, assigneeId, tag } = req.query;

    if (teamId && teamId !== 'solo') {
      const tId = Number(teamId);
      if (!isUserInTeam(tId, req.user.id)) {
        return res.status(403).json({ success: false, error: 'Доступ до задач цієї команди заборонено' });
      }
    }

    const tasks = getTasks({
      teamId: teamId === 'solo' ? null : teamId,
      userId: req.user.id,
      assigneeId,
      tag
    });
    res.json({ success: true, tasks });
  } catch (err) {
    console.error('Get tasks error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create task: in team workspace or solo
app.post('/api/tasks', requireAuth, (req, res) => {
  try {
    const { title, description, status, difficulty, tags, assigneeIds, assigneeId, isAllAssignees, teamId } = req.body || {};
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Назва задачі обов’язкова' });
    }

    let targetTeamId = null;
    if (teamId && teamId !== 'solo') {
      targetTeamId = Number(teamId);
      if (!isUserInTeam(targetTeamId, req.user.id)) {
        return res.status(403).json({ success: false, error: 'Ви не є учасником цієї команди' });
      }
    }

    let finalAssigneeIds = [];
    if (Array.isArray(assigneeIds)) {
      finalAssigneeIds = assigneeIds;
    } else if (assigneeId) {
      finalAssigneeIds = [assigneeId];
    } else if (!isAllAssignees) {
      finalAssigneeIds = [req.user.id];
    }

    const task = createTask({
      title,
      description,
      status: status || 'todo',
      difficulty: difficulty || 'mid',
      tags: tags || [],
      creatorId: req.user.id,
      assigneeIds: finalAssigneeIds,
      isAllAssignees: Boolean(isAllAssignees),
      teamId: targetTeamId
    });

    res.json({ success: true, task });
  } catch (err) {
    console.error('Create task error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Edit task: only creator can edit
app.put('/api/tasks/:id', requireAuth, (req, res) => {
  try {
    const taskId = Number(req.params.id);
    const existing = getTaskById(taskId);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Задачу не знайдено' });
    }

    if (existing.creator_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'Редагування дозволено лише для задач, які ви створили!'
      });
    }

    const { title, description, difficulty, tags, assigneeIds, assigneeId, isAllAssignees } = req.body || {};
    let finalAssigneeIds = undefined;
    if (Array.isArray(assigneeIds)) {
      finalAssigneeIds = assigneeIds;
    } else if (assigneeId !== undefined) {
      finalAssigneeIds = [assigneeId];
    }

    const updated = updateTask(taskId, {
      title,
      description,
      difficulty,
      tags,
      assigneeIds: finalAssigneeIds,
      isAllAssignees
    });

    res.json({ success: true, task: updated });
  } catch (err) {
    console.error('Update task error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Update task status (Drag & Drop): allowed for any assignee or anyone if assigned to all!
app.patch('/api/tasks/:id/status', requireAuth, (req, res) => {
  try {
    const taskId = Number(req.params.id);
    const existing = getTaskById(taskId);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Задачу не знайдено' });
    }

    if (!isUserAssigned(existing, req.user.id)) {
      return res.status(403).json({
        success: false,
        error: 'Редагувати статус (переміщувати між колонками) може лише призначений виконавець або будь-хто, якщо задача для всіх!'
      });
    }

    const { status } = req.body || {};
    if (!['todo', 'in-progress', 'done'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Недійсний статус' });
    }

    const updated = updateTaskStatus(taskId, status);
    res.json({ success: true, task: updated });
  } catch (err) {
    console.error('Status update error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete task: only creator can delete
app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  try {
    const taskId = Number(req.params.id);
    const existing = getTaskById(taskId);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Задачу не знайдено' });
    }

    if (existing.creator_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'Видалення дозволено лише для задач, які ви створили!'
      });
    }

    deleteTask(taskId);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete task error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

/* ==========================================================
   SETTINGS ROUTES
   ========================================================== */

app.post('/api/settings/theme', requireAuth, (req, res) => {
  try {
    const { theme } = req.body || {};
    if (theme) {
      setUserTheme(req.user.id, theme);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Theme setting error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

export default app;