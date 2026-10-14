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
