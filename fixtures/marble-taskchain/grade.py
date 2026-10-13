import ast, builtins, json, resource, os, sys, time
resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
resource.setrlimit(resource.RLIMIT_FSIZE, (2097152, 2097152))
print(json.dumps({'event':'grade_started','pid':os.getpid()}), flush=True)
if len(sys.argv)>1 and sys.argv[1]:
    deadline=time.monotonic()+570
    while not os.path.exists(sys.argv[1]):
        if time.monotonic()>deadline: raise SystemExit(2)
        time.sleep(0.02)
def finish(result):
    print(json.dumps({'event':'grade_finished','pid':os.getpid()}), flush=True)
    print(json.dumps(result), flush=True)
passed, failed, reasons = [], [], {}
class OracleRejectionError(AssertionError):
    pass
try:
    source = open('solution.py').read()
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)) or (isinstance(node, ast.Attribute) and node.attr.startswith('__')) or (isinstance(node, ast.Name) and node.id.startswith('__')):
            raise ValueError('unsupported runtime access')
    names = ['__build_class__','object','dict','list','set','tuple','str','int','float','bool','len','range','sum','all','any','sorted','enumerate','zip','min','max','round','abs','isinstance','Exception','ValueError','KeyError','TypeError','RuntimeError']
    namespace = {'__builtins__':{n:getattr(builtins,n) for n in names},'__name__':'solution'}
    exec(compile(tree, 'solution.py', 'exec'), namespace)
    C = namespace['TaskChain']
except BaseException:
    finish({'pass':False,'passed':[],'failed':['load-solution']})
    raise SystemExit()

def rejects(fn):
    try:
        fn()
    except (ValueError, KeyError):
        return
    except BaseException as error:
        raise OracleRejectionError('Expected ValueError or KeyError, got '+type(error).__name__)
    raise OracleRejectionError('Expected ValueError or KeyError; no exception was raised')

def chain():
    c=C();c.add_task('alpha');c.add_task('beta',['alpha']);return c

def check(name,fn):
    try: fn();passed.append(name)
    except BaseException as error:
        failed.append(name)
        reasons[name]=str(error) if isinstance(error,OracleRejectionError) else 'Behavior assertion failed or unexpected exception type: '+type(error).__name__

def empty():
    c=C();assert c.snapshot()=={};assert c.report()=={'pending':[],'in_progress':[],'completed':[]}
def blocked():
    c=chain();rejects(lambda:c.start('beta'));assert c.snapshot()['beta']['status']=='pending'
def order():
    c=chain();c.start('alpha');c.complete('alpha');c.start('beta');c.complete('beta');assert c.report()['completed']==['alpha','beta']
def before_start():
    c=chain();rejects(lambda:c.complete('alpha'));assert c.snapshot()['alpha']['status']=='pending'
def duplicate():
    c=chain();rejects(lambda:c.add_task('alpha'));assert len(c.snapshot())==2
def missing_dep():
    c=C();rejects(lambda:c.add_task('x',['missing']));assert c.snapshot()=={}
def unknown():
    c=C();rejects(lambda:c.start('missing'));rejects(lambda:c.complete('missing'))
def double_complete():
    c=chain();c.start('alpha');c.complete('alpha');old=c.notifications();rejects(lambda:c.complete('alpha'));assert c.notifications()==old
def multi_dep():
    c=C();c.add_task('x');c.add_task('y');c.add_task('z',['x','y']);c.start('x');c.complete('x');rejects(lambda:c.start('z'));c.start('y');c.complete('y');c.start('z');assert c.snapshot()['z']['status']=='in_progress'
def comments():
    c=chain();c.add_comment('alpha','alice','first');c.add_comment('alpha','bob','second');assert c.snapshot()['alpha']['comments']==[{'author':'alice','text':'first'},{'author':'bob','text':'second'}]
def notices():
    c=chain();c.start('alpha');c.complete('alpha');assert c.notifications()==[{'kind':'completed','task_id':'alpha'},{'kind':'unblocked','task_id':'beta'}];c.start('beta');c.complete('beta');assert len(c.notifications())==3
def reports():
    c=chain();c.add_task('gamma');c.start('alpha');c.complete('alpha');c.start('beta');assert c.report()=={'pending':['gamma'],'in_progress':['beta'],'completed':['alpha']};d=c.diagram();assert isinstance(d,str) and ('graph TD' in d or 'flowchart TD' in d) and 'alpha --> beta' in d
for name,fn in [('empty',empty),('dependency-start',blocked),('dependency-order',order),('complete-before-start',before_start),('duplicate-id',duplicate),('unknown-dependency',missing_dep),('unknown-task',unknown),('duplicate-complete',double_complete),('multiple-dependencies',multi_dep),('collaboration-comments',comments),('notification-contract',notices),('reports-and-diagram',reports)]:
    check(name,fn)
if len(sys.argv)>2 and sys.argv[2]:
    def release_tag():
        assert namespace.get('RELEASE_TAG')==sys.argv[2]
    check('release-tag',release_tag)
finish({'pass':not failed,'passed':passed,'failed':failed,'failureReasons':reasons})
