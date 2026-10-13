class TaskChain:
    def __init__(self):
        self.tasks = {}
        self.events = []
    def add_task(self, task_id, dependencies=None):
        dependencies = list(dependencies or [])
        if task_id in self.tasks or any(x not in self.tasks for x in dependencies):
            raise ValueError('invalid task or dependency')
        self.tasks[task_id] = {'status':'pending','dependencies':dependencies,'comments':[]}
    def start(self, task_id):
        task = self.tasks[task_id]
        if task['status'] != 'pending' or any(self.tasks[x]['status'] != 'completed' for x in task['dependencies']):
            raise ValueError('blocked or already started')
        task['status'] = 'in_progress'
    def complete(self, task_id):
        task = self.tasks[task_id]
        if task['status'] != 'in_progress':
            raise ValueError('not started')
        task['status'] = 'completed'
        self.events.append({'kind':'completed','task_id':task_id})
        for name, other in self.tasks.items():
            if other['status']=='pending' and task_id in other['dependencies'] and all(self.tasks[x]['status']=='completed' for x in other['dependencies']):
                self.events.append({'kind':'unblocked','task_id':name})
    def add_comment(self, task_id, author, text):
        self.tasks[task_id]['comments'].append({'author':author,'text':text})
    def snapshot(self):
        return {k: {'status':v['status'],'dependencies':list(v['dependencies']),'comments':[dict(c) for c in v['comments']]} for k,v in self.tasks.items()}
    def notifications(self):
        return [dict(e) for e in self.events]
    def report(self):
        return {s:sorted(k for k,v in self.tasks.items() if v['status']==s) for s in ['pending','in_progress','completed']}
    def diagram(self):
        return 'graph TD\n'+'\n'.join(d+' --> '+k for k,v in self.tasks.items() for d in v['dependencies'])
