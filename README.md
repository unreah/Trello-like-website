# 📋 Kanban Flow — Collaborative Kanban & Workspace Platform

A modern, responsive, and collaborative Kanban task management web application inspired by **Trello** and **Slack Workspaces**. Built with Node.js, Express, native SQLite, and vanilla modern JavaScript.

---

## 🌟 Key Features

### 🏢 Slack-Style Corporate Workspaces
- **Multi-Tenant Experience**: Seamlessly switch between a **Personal Solo Space** and **Corporate Team Workspaces**.
- **Team Creation & Joining**: Create password-protected company workspaces or join existing teams via access code.
- **Pre-seeded Corporate Teams**: Includes out-of-the-box workspaces (`vinsoft` and `panasonic`, access code: `1111`) with auto-distributed team members.
- **Team Management**:
  - **Team Owners**: View member lists, remove/kick members, or permanently delete the workspace and its tasks.
  - **Team Members**: Voluntarily leave any workspace at any time.
  - **Task & Member Isolation**: Workspaces strictly isolate tasks, member lists, and assignment dropdowns.

### 📋 Interactive Kanban Board (Trello-style)
- **Three-Column Workflow**: `To Do` (`todo`), `In Progress` (`in-progress`), and `Done` (`done`).
- **Drag & Drop**: Native, smooth drag-and-drop task movement between columns that updates status in real time.
- **Live Progress Tracking**: Dynamic completion rate indicator and donut chart reflecting progress.

### 👥 Flexible Assignment & Permissions
- **Granular Assignees**: Assign tasks to a single teammate, multiple teammates, or everyone in the team (**"Assign to All"**).
- **Execution Guardrails**:
  - Only assigned members (or any team member if assigned to all) can change task status or drag cards between columns.
  - Editing title/description/difficulty and task deletion are reserved exclusively for the task creator.

### ⚡ Task Details & Difficulty Levels
- **Custom Difficulty Badges**:
  - 🟢 `ez` — Easy tasks
  - 🟡 `mid` — Medium complexity
  - 🔴 `oh fu..` — High priority / complex challenges
- **Tagging & Filtering**: Add colored tags to categorize tasks; filter board by tag, assignee, or "Assigned to Me".

### 🎨 Aesthetic Multi-Theme Engine
- Switch on the fly between 4 custom-crafted color palettes:
  - 🏺 **Terracotta** (Warm, earthy cream)
  - 🍬 **Candy Pastel** (Vibrant, cheerful)
  - 🪻 **Lavender** (Cool, calming purple)
  - ⚪ **Neutral** (Minimalist slate)
- Theme preferences are saved per user and persisted across sessions.

### 🔐 Authentication & Security
- User registration and login with cookie-based HTTP-only sessions.
- Secure cryptographic password hashing using Node.js native `crypto.scryptSync` with unique cryptographic salts (`crypto.randomBytes`).
- Session tokens validated with SQLite database persistence.

---

## 🛠️ Tech Stack

- **Backend**: [Node.js](https://nodejs.org/) (v22+ / v24+), [Express 5](https://expressjs.com/)
- **Database**: SQLite via Node.js built-in `node:sqlite` (`DatabaseSync`) — *no external native compilation required!*
- **Cryptography**: Native `node:crypto` (`scryptSync`, `randomBytes`, `timingSafeEqual`)
- **Frontend**: Vanilla ES6+ JavaScript, CSS3 variables, Semantic HTML5
- **Icons & UI**: Modern SVG & emoji-based interface, responsive layout, toast notification system

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) version **22.0.0** or higher (tested on Node v24 with native SQLite support).

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-username/kanban-flow.git
   cd kanban-flow
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the server**:
   ```bash
   npm start
   ```
   Or run in development mode with automatic restart:
   ```bash
   npm run dev
   ```

4. **Open in browser**:
   Navigate to [http://localhost:3000](http://localhost:3000)

---

## 🧪 Default Test Accounts & Workspaces

The database automatically seeds with default corporate teams:

| Workspace | Password / Invite Code | Role | Description |
| :--- | :--- | :--- | :--- |
| **vinsoft** | `1111` | Member / Owner | Pre-populated engineering team |
| **panasonic** | `1111` | Member / Owner | Pre-populated enterprise team |
| **Solo** | *N/A* | Private | Personal space accessible only to you |

*Note: You can register a new account anytime and choose to work solo, join `vinsoft` / `panasonic`, or create your own custom corporate team.*

---

## 📁 Project Structure

```
.
├── database.sqlite        # SQLite database (auto-created on start)
├── package.json           # Node.js project manifest & scripts
├── public/                # Frontend assets
│   ├── index.html         # Main SPA layout & modal dialogues
│   ├── css/
│   │   └── style.css      # Design system, themes, and Kanban styling
│   └── js/
│       └── main.js        # SPA client logic, drag & drop, state management
└── src/
    ├── db.js              # SQLite schema, migrations, queries, and auth crypto
    └── server.js          # Express app, RESTful routes, and permission middleware
```

---

## 📡 REST API Overview

### Authentication
- `POST /api/auth/register` — Create a new user account
- `POST /api/auth/login` — Sign in and create session cookie
- `POST /api/auth/logout` — Invalidate session
- `GET /api/auth/me` — Get current logged-in user profile

### Workspaces / Teams
- `GET /api/teams` — List teams for the authenticated user
- `POST /api/teams/create` — Create a new corporate team with password
- `POST /api/teams/join` — Join a team using team name and password
- `GET /api/teams/:id/members` — Fetch member list for a team
- `POST /api/teams/:id/leave` — Leave a corporate team (members only)
- `DELETE /api/teams/:id/members/:userId` — Kick a user from team (owner only)
- `DELETE /api/teams/:id` — Delete entire team and its tasks (owner only)

### Tasks
- `GET /api/tasks?teamId=...` — Retrieve tasks scoped by workspace
- `POST /api/tasks` — Create task in active workspace
- `PUT /api/tasks/:id` — Update task details (creator only)
- `PATCH /api/tasks/:id/status` — Move task / update status (assignees only)
- `DELETE /api/tasks/:id` — Delete task (creator only)

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
