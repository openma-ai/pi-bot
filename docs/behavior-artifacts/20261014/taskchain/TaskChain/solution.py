RELEASE_TAG = "audit-20261013-v3"

class TaskChain:
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"

    def __init__(self):
        self._tasks = {}
        self._notifications = []
        self._unblocked = set()

    def _require(self, task_id):
        if task_id not in self._tasks:
            raise KeyError(task_id)
        return self._tasks[task_id]

    def add_task(self, task_id, dependencies=None):
        if task_id in self._tasks:
            raise ValueError("duplicate task id: %r" % (task_id,))
        if dependencies is None:
            deps = []
        else:
            deps = list(dependencies)
        for dep in deps:
            if dep not in self._tasks:
                raise KeyError(dep)
        self._tasks[task_id] = {
            "status": self.PENDING,
            "dependencies": deps,
            "comments": [],
        }

    def start(self, task_id):
        task = self._require(task_id)
        if task["status"] != self.PENDING:
            raise ValueError("task is not pending: %r" % (task_id,))
        for dep in task["dependencies"]:
            if self._tasks[dep]["status"] != self.COMPLETED:
                raise ValueError("incomplete dependency: %r" % (dep,))
        task["status"] = self.IN_PROGRESS

    def complete(self, task_id):
        task = self._require(task_id)
        if task["status"] != self.IN_PROGRESS:
            raise ValueError("task is not in progress: %r" % (task_id,))
        task["status"] = self.COMPLETED
        self._notifications.append({"kind": "completed", "task_id": task_id})
        for other_id, other in self._tasks.items():
            if other["status"] != self.PENDING:
                continue
            if other_id in self._unblocked:
                continue
            if task_id not in other["dependencies"]:
                continue
            if all(self._tasks[d]["status"] == self.COMPLETED for d in other["dependencies"]):
                self._unblocked.add(other_id)
                self._notifications.append({"kind": "unblocked", "task_id": other_id})

    def add_comment(self, task_id, author, text):
        task = self._require(task_id)
        task["comments"].append({"author": author, "text": text})

    def snapshot(self):
        result = {}
        for task_id, rec in self._tasks.items():
            result[task_id] = {
                "status": rec["status"],
                "dependencies": list(rec["dependencies"]),
                "comments": [dict(c) for c in rec["comments"]],
            }
        return result

    def notifications(self):
        return [dict(n) for n in self._notifications]

    def report(self):
        return {
            "pending": sorted(t for t, r in self._tasks.items() if r["status"] == self.PENDING),
            "in_progress": sorted(t for t, r in self._tasks.items() if r["status"] == self.IN_PROGRESS),
            "completed": sorted(t for t, r in self._tasks.items() if r["status"] == self.COMPLETED),
        }

    def diagram(self):
        lines = ["graph TD"]
        for task_id, rec in self._tasks.items():
            for dep in rec["dependencies"]:
                lines.append("    %s --> %s" % (dep, task_id))
        return "\n".join(lines)