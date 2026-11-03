-- Esquema inicial do Night (blueprint §13).

CREATE TABLE projects (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  description    text NOT NULL DEFAULT '',
  repo_path      text,
  default_branch text,
  allowed_paths  text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived'))
);
CREATE UNIQUE INDEX projects_name_lower ON projects (lower(name));

CREATE TABLE ideas (
  id         text PRIMARY KEY,
  project_id text REFERENCES projects (id) ON DELETE SET NULL,
  title      text NOT NULL,
  transcript text NOT NULL,
  notes      text NOT NULL DEFAULT '',
  tags       text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  status     text NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox', 'reviewed', 'promoted', 'discarded')),
  -- Busca em PT e EN: "ideias" acha "ideia", "parsers" acha "parser".
  search     tsvector GENERATED ALWAYS AS (
    to_tsvector('portuguese', title || ' ' || transcript || ' ' || notes) ||
    to_tsvector('english', title || ' ' || transcript || ' ' || notes)
  ) STORED
);
CREATE INDEX ideas_search ON ideas USING gin (search);
CREATE INDEX ideas_project ON ideas (project_id, created_at DESC);

CREATE TABLE tasks (
  id             text PRIMARY KEY,
  project_id     text NOT NULL REFERENCES projects (id),
  objective      text NOT NULL,
  scope          text NOT NULL,
  status         text NOT NULL CHECK (status IN ('captured', 'queued', 'planning', 'running', 'testing',
                   'review-ready', 'awaiting-approval', 'accepted', 'rejected', 'failed', 'cancelled')),
  primary_agent  text NOT NULL CHECK (primary_agent IN ('claude', 'codex')),
  review_agent   text CHECK (review_agent IN ('claude', 'codex')),
  worktree_path  text,
  branch         text,
  base_ref       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  result_summary text,
  approval_state text NOT NULL DEFAULT 'none' CHECK (approval_state IN ('none', 'pending', 'approved', 'rejected'))
);
CREATE INDEX tasks_status ON tasks (status);

CREATE TABLE task_events (
  id           text PRIMARY KEY,
  task_id      text NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  event_type   text NOT NULL,
  source       text NOT NULL,
  message      text NOT NULL,
  artifact_ref text
);
CREATE INDEX task_events_task ON task_events (task_id, at);

CREATE TABLE approvals (
  id           text PRIMARY KEY,
  task_id      text NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  action       text NOT NULL CHECK (action IN ('merge', 'deploy', 'publish', 'spend', 'delete', 'network')),
  scope        text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decision     text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'rejected')),
  decided_at   timestamptz
);
CREATE INDEX approvals_pending ON approvals (requested_at) WHERE decision = 'pending';
