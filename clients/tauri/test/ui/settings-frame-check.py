"""Settings frame geometry across real components, using isolated fake data only."""
import json, subprocess, time
from pathlib import Path

out = Path('artifacts/settings-fixed-final')
out.mkdir(parents=True, exist_ok=True)
checks = []

def ab(*args, code=None):
    p = subprocess.run(['agent-browser', '--session', 'pibo-fixed-settings', '--json', *args], input=code, text=True, capture_output=True, timeout=30)
    if p.returncode:
        raise RuntimeError(p.stderr or p.stdout)
    value = json.loads(p.stdout)
    if not value.get('success'):
        raise RuntimeError(value)
    return value['data']

def js(code):
    return ab('eval', '--stdin', code=code).get('result')

def click(name, role='button'):
    refs = ab('snapshot', '-i')['refs']
    matches = [k for k, v in refs.items() if v['role'] == role and v['name'] == name]
    assert len(matches) == 1, {'target': name, 'role': role, 'refs': refs}
    ab('scrollintoview', '@' + matches[0])
    # Keep nested form actions inside the scroller's visible clip before clicking.
    if role == 'button':
        js('(()=>{const b=[...document.querySelectorAll("button")].find(e=>(e.getAttribute("aria-label")||e.textContent.trim())==='+json.dumps(name)+');const v=b?.closest(".rt-ScrollAreaViewport");if(v){const r=b.getBoundingClientRect(),s=v.getBoundingClientRect();if(r.bottom>s.bottom)v.scrollTop+=r.bottom-s.bottom+8;if(r.top<s.top)v.scrollTop-=s.top-r.top+8;}})()')
    refs = ab('snapshot', '-i')['refs']
    matches = [k for k, v in refs.items() if v['role'] == role and v['name'] == name]
    ab('click', '@' + matches[0])
    time.sleep(.15)
    ab('snapshot', '-i')

def frame():
    return js('(()=>{const d=document.querySelector(".settings-page").getBoundingClientRect(),h=document.querySelector(".settings-header").getBoundingClientRect();return {x:d.x,y:d.y,width:d.width,height:d.height,headerTop:h.top,headerHeight:h.height,docWidth:document.documentElement.scrollWidth,viewWidth:innerWidth,viewHeight:innerHeight}})()')

def check(name, ok, details=None):
    checks.append({'name': name, 'pass': bool(ok), 'details': details})
    (out / 'results.json').write_text(json.dumps({'scope': 'Isolated fake data; no real login, model changes, runtime or credentials', 'checks': checks, 'passed': sum(x['pass'] for x in checks), 'failed': sum(not x['pass'] for x in checks)}, ensure_ascii=False, indent=2))
    print(name, bool(ok), flush=True)
    assert ok, name

try:
    for w, h in [(1440,900), (1100,760), (844,390), (393,852), (320,568)]:
        ab('set', 'viewport', str(w), str(h))
        ab('open', 'http://127.0.0.1:5208/clients/tauri/test/ui/model-auth-review.html?configured=1&account=partial&manage=1&native=1')
        ab('wait', '[aria-label="默认模型"]')
        time.sleep(.2)
        baseline = frame()
        check(f'{w} frame stays centered and within viewport', abs(baseline['x']*2+baseline['width']-w)<1 and abs(baseline['y']*2+baseline['height']-h)<1 and baseline['x']>=0 and baseline['y']>=0 and baseline['docWidth']<=w, baseline)
        if w>=768:
            check(f'{w} desktop fixed size constrained only by viewport', abs(baseline['width']-min(940,w-48))<1 and abs(baseline['height']-min(680,h-64))<1, baseline)
        for route, name, role in [('workspace','工作空间','tab'), ('add-connection','添加连接','button'), ('workspace-return','取消并返回','button'), ('model-return','模型','tab'), ('provider','管理连接','button'), ('provider-return','返回','button')]:
            click(name,role)
            current=frame()
            check(f'{w} {route} preserves frame and header', all(abs(current[k]-baseline[k])<1 for k in ['x','y','width','height','headerTop','headerHeight']), current)
        check(f'{w} navigation does not mutate auth or model', js('window.__MODEL_AUTH_QA__.calls.every(c=>c.method!=="POST")&&window.__MODEL_AUTH_QA__.configuration().current.model==="qa-model"'))
        ab('screenshot',str(out / f'{w}-fixed-settings.png'))
        click('关闭设置')
        check(f'{w} close works', js('!document.querySelector(".settings-page")'))
    errors=ab('errors').get('errors',[])
    check('No browser errors', not errors, errors)
finally:
    ab('close')
print(json.dumps({'passed':sum(x['pass'] for x in checks),'failed':sum(not x['pass'] for x in checks)}),flush=True)
