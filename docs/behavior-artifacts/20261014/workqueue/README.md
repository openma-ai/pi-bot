# WorkQueue engineering fixture

Build a small runnable Python project using the standard library only. Tests are an immutable acceptance contract.

`Queue(path)` owns a SQLite connection and migrates legacy databases. Schema v1 contains `tasks(id TEXT PRIMARY KEY,title TEXT,status TEXT)` with `PRAGMA user_version=1`. v2 preserves records, fills owner `unknown`, adds dependencies and event history, and sets user_version=2. Existing schema v2 reopens without mutation. `close()` closes the connection.

API:
- `add(id,title,owner,dependencies=None)`: create pending task. IDs/owner/title must be nonempty strings. Dependencies must already exist; duplicates/self/unknown dependencies reject. Duplicate task IDs reject. Validation errors are ValueError or KeyError. No partial insert/events on failure.
- `get(id)`: dict with id,title,owner,status. Unknown id raises KeyError.
- `list(owner=None,status=None)`: list of dicts, sorted by id, both filters work together.
- `start(id)`: pending -> running, only if all dependencies done. Invalid transition rejects.
- `complete(id)`: running -> done returns True; already done returns False without another event. Other transitions reject.
- `cancel(id)`: pending/running -> cancelled returns True; already cancelled returns False without another event. Done rejects.
- `complete_many(ids)`: all-or-nothing transaction, applies complete to each ID; invalid member rolls back every state/event in that batch.
- `events(id)`: list of persisted transition dicts with `action`, in order; add/start/complete/cancel only when a real mutation occurred.
- Every method must remain usable after a rejected transaction. Two Queue connections to the same file must observe committed changes. Use parameterized SQL.

CLI `python -m workqueue.cli --db PATH` subcommands:
- add ID --title TEXT --owner OWNER [--depends ID ...]
- start ID, complete ID, cancel ID: JSON success object
- list [--owner OWNER] [--status STATUS]: JSON array
- export --format csv: header `owner,total,done,completion_rate`, owners sorted, ratio six decimals, all task states count in total.
- Validation errors: nonzero exit, a useful stderr message, no traceback and no corrupt database. --help works.

Storage and CLI are separate modules so two bots can implement separate files and integrate them. Add practical README usage examples after implementation. Do not change tests.

## CLI usage

All commands use the same entry point, `python -m workqueue.cli --db PATH`,
where `PATH` is the SQLite database file. Successful commands print a single
JSON document to stdout; validation errors exit non-zero with a short message
on stderr and never print a traceback.

Create a task:

```console
$ python -m workqueue.cli --db queue.sqlite add x --title "CLI task" --owner bob
{"id": "x", "title": "CLI task", "owner": "bob", "status": "pending"}
```

Add a dependent task (the dependency must already exist):

```console
$ python -m workqueue.cli --db queue.sqlite add y --title "Follow up" --owner bob --depends x
{"id": "y", "title": "Follow up", "owner": "bob", "status": "pending"}
```

Drive the lifecycle. `start` moves a pending task to running, `complete` moves
a running task to done, and `cancel` cancels a pending or running task:

```console
$ python -m workqueue.cli --db queue.sqlite start x
{"id": "x", "title": "CLI task", "owner": "bob", "status": "running"}

$ python -m workqueue.cli --db queue.sqlite complete x
{"id": "x", "title": "CLI task", "owner": "bob", "status": "done", "changed": true}

$ python -m workqueue.cli --db queue.sqlite cancel y
{"id": "y", "title": "Follow up", "owner": "bob", "status": "cancelled", "changed": true}
```

Repeating `complete`/`cancel` is idempotent: the status stays the same and
`"changed"` is `false`. Starting a task whose dependency is not done is a
validation error:

```console
$ python -m workqueue.cli --db queue.sqlite start y
error: dependency not done: x
$ echo $?
1
```

List tasks, optionally filtered by owner and/or status. Tasks are sorted by id:

```console
$ python -m workqueue.cli --db queue.sqlite list --owner bob
[{"id": "x", "title": "CLI task", "owner": "bob", "status": "done"}, {"id": "y", "title": "Follow up", "owner": "bob", "status": "cancelled"}]

$ python -m workqueue.cli --db queue.sqlite list --status done
[{"id": "x", "title": "CLI task", "owner": "bob", "status": "done"}]
```

Export per-owner aggregates as CSV. Owners are sorted ascending, every task
state counts toward `total`, only `done` counts toward `done`, and
`completion_rate` always has exactly six decimals:

```console
$ python -m workqueue.cli --db queue.sqlite export --format csv
owner,total,done,completion_rate
alice,2,1,0.500000
bob,1,0,0.000000
```

`--help` lists every subcommand, including `export`:

```console
$ python -m workqueue.cli --help
usage: workqueue.cli [-h] --db PATH {add,start,complete,cancel,list,export} ...

Manage a WorkQueue SQLite database.

options:
  -h, --help  show this help message and exit
  --db PATH   path to the SQLite queue database

subcommands:
  {add,start,complete,cancel,list,export}
```
