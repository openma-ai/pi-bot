"""Persistent SQLite work queue with schema migration and event history.

The public API is intentionally small: :class:`Queue` wraps a single SQLite
connection and exposes task creation, queries, lifecycle transitions and
event history.  All mutations are committed immediately so that independent
connections to the same database file observe each other's committed work.

Schema versions
---------------
* v1 -- legacy databases: ``tasks(id, title, status)`` only.
* v2 -- adds ``owner`` to ``tasks`` plus ``dependencies`` and ``events``
  tables.  v1 rows are preserved and their owner is filled with ``unknown``.
"""

import contextlib
import sqlite3


class Queue:
    """A tiny, dependency-free work queue backed by a SQLite file."""

    SCHEMA_VERSION = 2

    def __init__(self, path):
        self.path = path
        # isolation_level=None -> autocommit; we manage explicit transactions.
        self.con = sqlite3.connect(path, isolation_level=None, timeout=10.0)
        self.con.row_factory = sqlite3.Row
        self._migrate()

    # ------------------------------------------------------------------
    # schema / migration
    # ------------------------------------------------------------------
    def _create_schema(self):
        self.con.execute(
            "CREATE TABLE IF NOT EXISTS tasks ("
            "id TEXT PRIMARY KEY, "
            "title TEXT NOT NULL, "
            "owner TEXT NOT NULL, "
            "status TEXT NOT NULL)"
        )
        self.con.execute(
            "CREATE TABLE IF NOT EXISTS dependencies ("
            "task_id TEXT NOT NULL, "
            "depends_on TEXT NOT NULL, "
            "PRIMARY KEY (task_id, depends_on))"
        )
        self.con.execute(
            "CREATE TABLE IF NOT EXISTS events ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "task_id TEXT NOT NULL, "
            "action TEXT NOT NULL, "
            "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        )

    def _migrate(self):
        version = self.con.execute("PRAGMA user_version").fetchone()[0]
        row = self.con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"
        ).fetchone()
        has_tasks = row is not None

        if not has_tasks:
            # Fresh database (or empty file): build v2 from scratch.
            with self._tx():
                self._create_schema()
                self.con.execute(
                    "PRAGMA user_version=%d" % self.SCHEMA_VERSION
                )
            return

        columns = [
            r[1] for r in self.con.execute("PRAGMA table_info(tasks)").fetchall()
        ]
        if version >= self.SCHEMA_VERSION and "owner" in columns:
            # Already current: reopen without mutating anything.
            return

        with self._tx():
            if "owner" not in columns:
                self.con.execute("ALTER TABLE tasks ADD COLUMN owner TEXT")
            self.con.execute(
                "UPDATE tasks SET owner='unknown'"
                " WHERE owner IS NULL OR owner=''"
            )
            self._create_schema()
            self.con.execute("PRAGMA user_version=%d" % self.SCHEMA_VERSION)

    @contextlib.contextmanager
    def _tx(self):
        """Explicit (possibly exclusive) transaction with rollback on error."""
        self.con.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.con.execute("COMMIT")
        except BaseException:
            try:
                self.con.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _row_to_dict(row):
        return {key: row[key] for key in row.keys()}

    @staticmethod
    def _check_text(name, value):
        if not isinstance(value, str) or not value:
            raise ValueError("%s must be a nonempty string" % name)

    def _normalize_dependencies(self, task_id, dependencies):
        if dependencies is None:
            return []
        if isinstance(dependencies, str):
            raise ValueError("dependencies must be a sequence of ids")
        deps = list(dependencies)
        for dep in deps:
            if not isinstance(dep, str) or not dep:
                raise ValueError("dependency ids must be nonempty strings")
            if dep == task_id:
                raise ValueError("task %r cannot depend on itself" % (task_id,))
        if len(set(deps)) != len(deps):
            raise ValueError("duplicate dependency ids are not allowed")
        return deps

    def _record(self, task_id, action):
        self.con.execute(
            "INSERT INTO events(task_id, action) VALUES(?, ?)",
            (task_id, action),
        )

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------
    def add(self, id, title, owner, dependencies=None):
        """Create a ``pending`` task, optionally with existing dependencies."""
        self._check_text("id", id)
        self._check_text("title", title)
        self._check_text("owner", owner)
        deps = self._normalize_dependencies(id, dependencies)

        with self._tx():
            duplicate = self.con.execute(
                "SELECT 1 FROM tasks WHERE id=?", (id,)
            ).fetchone()
            if duplicate is not None:
                raise ValueError("duplicate task id: %r" % (id,))
            for dep in deps:
                known = self.con.execute(
                    "SELECT 1 FROM tasks WHERE id=?", (dep,)
                ).fetchone()
                if known is None:
                    raise KeyError("unknown dependency: %r" % (dep,))
            self.con.execute(
                "INSERT INTO tasks(id, title, owner, status)"
                " VALUES(?, ?, ?, 'pending')",
                (id, title, owner),
            )
            for dep in deps:
                self.con.execute(
                    "INSERT INTO dependencies(task_id, depends_on)"
                    " VALUES(?, ?)",
                    (id, dep),
                )
            self._record(id, "add")

    def get(self, id):
        """Return ``id``, ``title``, ``owner`` and ``status`` for ``id``."""
        row = self.con.execute(
            "SELECT id, title, owner, status FROM tasks WHERE id=?", (id,)
        ).fetchone()
        if row is None:
            raise KeyError(id)
        return self._row_to_dict(row)

    def list(self, owner=None, status=None):
        """Return tasks sorted by id, optionally filtered by owner/status."""
        query = "SELECT id, title, owner, status FROM tasks"
        clauses = []
        params = []
        if owner is not None:
            clauses.append("owner=?")
            params.append(owner)
        if status is not None:
            clauses.append("status=?")
            params.append(status)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY id"
        rows = self.con.execute(query, params).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def start(self, id):
        """Move a ``pending`` task to ``running`` once deps are all done."""
        with self._tx():
            row = self.con.execute(
                "SELECT status FROM tasks WHERE id=?", (id,)
            ).fetchone()
            if row is None:
                raise KeyError(id)
            if row["status"] != "pending":
                raise ValueError(
                    "cannot start task in status %r" % (row["status"],)
                )
            deps = [
                r["depends_on"]
                for r in self.con.execute(
                    "SELECT depends_on FROM dependencies WHERE task_id=?",
                    (id,),
                ).fetchall()
            ]
            for dep in deps:
                dep_row = self.con.execute(
                    "SELECT status FROM tasks WHERE id=?", (dep,)
                ).fetchone()
                if dep_row is None or dep_row["status"] != "done":
                    raise ValueError("dependency %r is not done" % (dep,))
            self.con.execute(
                "UPDATE tasks SET status='running'"
                " WHERE id=? AND status='pending'",
                (id,),
            )
            self._record(id, "start")

    def _complete_locked(self, id):
        row = self.con.execute(
            "SELECT status FROM tasks WHERE id=?", (id,)
        ).fetchone()
        if row is None:
            raise KeyError(id)
        if row["status"] == "done":
            return False
        if row["status"] != "running":
            raise ValueError(
                "cannot complete task in status %r" % (row["status"],)
            )
        self.con.execute(
            "UPDATE tasks SET status='done' WHERE id=? AND status='running'",
            (id,),
        )
        self._record(id, "complete")
        return True

    def complete(self, id):
        """Move a ``running`` task to ``done``; idempotent for ``done``."""
        with self._tx():
            return self._complete_locked(id)

    def cancel(self, id):
        """Cancel a ``pending``/``running`` task; idempotent when cancelled."""
        with self._tx():
            row = self.con.execute(
                "SELECT status FROM tasks WHERE id=?", (id,)
            ).fetchone()
            if row is None:
                raise KeyError(id)
            status = row["status"]
            if status == "cancelled":
                return False
            if status not in ("pending", "running"):
                raise ValueError(
                    "cannot cancel task in status %r" % (status,)
                )
            self.con.execute(
                "UPDATE tasks SET status='cancelled' WHERE id=?", (id,)
            )
            self._record(id, "cancel")
            return True

    def complete_many(self, ids):
        """Complete every id atomically; any failure rolls back the batch."""
        id_list = list(ids)
        with self._tx():
            return [self._complete_locked(task_id) for task_id in id_list]

    def events(self, id):
        """Return the task's transition history in insertion order."""
        rows = self.con.execute(
            "SELECT id, task_id, action, created_at FROM events"
            " WHERE task_id=? ORDER BY id",
            (id,),
        ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def close(self):
        """Close the underlying SQLite connection."""
        if self.con is not None:
            self.con.close()
            self.con = None
