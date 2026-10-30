"""State transitions and collision geometry; synthetic messages/requests only."""
import json, subprocess, time
from pathlib import Path

out=Path('artifacts/feed-status-final');out.mkdir(parents=True,exist_ok=True)
checks=[]
def ab(*args,code=None):
    # Browser CLI startup on this host exceeded 30s; retain a bounded 90s wait.
    p=subprocess.run(['agent-browser','--session','pibo-feed-state','--json',*args],input=code,text=True,capture_output=True,timeout=90)
    if p.returncode:raise RuntimeError(p.stderr or p.stdout)
    value=json.loads(p.stdout)
    if not value.get('success'):raise RuntimeError(value)
    return value['data']
def js(code):return ab('eval','--stdin',code=code).get('result')
def check(name,passed,details=None):
    checks.append({'name':name,'pass':bool(passed),'details':details})
    (out/'results.json').write_text(json.dumps({'scope':'Real components with fake messages; no real runtime, inference, approval or credentials','checks':checks,'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks)},ensure_ascii=False,indent=2))
    print(name,bool(passed),flush=True)
    assert passed,name
def geometry():
    return js('''(()=>{const feed=document.querySelector('.conversation'),node=document.querySelector('.conversation-status'),composer=document.querySelector('.composer-area'),shell=document.querySelector('.composer-shell'),line=node.querySelector('.activity-line,.request-attention-summary');const bounds=e=>e?.getBoundingClientRect().toJSON();return {feed:bounds(feed),status:bounds(node),line:bounds(line),shell:bounds(shell),clip:getComputedStyle(node).clipPath,translate:new DOMMatrixReadOnly(getComputedStyle(node).transform).m42,scroll:feed.scrollTop,scrollHeight:feed.scrollHeight,docWidth:document.documentElement.scrollWidth,wrapperTransparent:[composer,node].every(e=>{const c=getComputedStyle(e);return c.backgroundColor==='rgba(0, 0, 0, 0)'&&c.backgroundImage==='none'&&c.boxShadow==='none'&&['::before','::after'].every(p=>['none','normal'].includes(getComputedStyle(e,p).content))}),descriptionTransparent:!node.querySelector('.activity-description')||getComputedStyle(node.querySelector('.activity-description')).backgroundColor==='rgba(0, 0, 0, 0)'};})()''')
def phase(value):
    js('window.__REQUEST_QA__.setActivity('+json.dumps(value)+')');time.sleep(.15)

try:
    for w,h in [(1100,760),(393,852),(320,568),(844,390)]:
        for short in [True,False]:
            label=f'{w} '+('short' if short else 'long')
            ab('set','viewport',str(w),str(h))
            ab('open','http://127.0.0.1:5208/clients/tauri/test/ui/requests-review.html?activity=idle'+('&short=1' if short else ''))
            ab('wait','.composer-shell');time.sleep(.15)
            for activity in ['idle','working','queued','attention','idle']:
                phase(activity);g=geometry()
                check(label+' '+activity+' no banner or horizontal overflow',g['wrapperTransparent'] and g['descriptionTransparent'] and g['docWidth']<=w,g)
                if activity!='idle':
                    check(label+' '+activity+' fully visible above capsule after transition',g['line']['top']>=g['feed']['top'] and g['line']['bottom']<=g['shell']['top']-8 and g['clip']=='inset(0px)',g)
            phase('working');rest=geometry()
            ab('screenshot',str(out/(f'{w}-'+('short' if short else 'long')+'-running.png')))
            if not short:
                js('document.querySelector(".conversation").scrollTop-=160');time.sleep(.15);away=geometry()
                check(label+' scroll pushes status down',away['translate']>rest['translate']+40,away)
                old=away['scroll'];phase('attention');waiting=geometry()
                check(label+' waiting transition preserves history position',abs(waiting['scroll']-old)<1,waiting)
                js('document.querySelector(".conversation").scrollTop=100000');time.sleep(.15);returned=geometry()
                check(label+' return to latest restores full request entry',returned['clip']=='inset(0px)' and returned['line']['bottom']<returned['shell']['top']-8,returned)
                phase('working');phase('idle');phase('working');g=geometry()
                check(label+' repeated active transition remains visible',g['clip']=='inset(0px)' and g['line']['bottom']<g['shell']['top']-8,g)
            check(label+' no real action dispatched',js('window.__REQUEST_QA__.calls.length===0&&window.__REQUEST_QA__.sent.length===0'))
    errors=ab('errors').get('errors',[]);check('No browser errors',not errors,errors)
finally:ab('close')
print(json.dumps({'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks)}),flush=True)
