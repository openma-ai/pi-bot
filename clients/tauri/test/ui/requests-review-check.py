"""Agent-browser CLI against local fake requests only; no actual runtime or approval."""
import json,subprocess,time,hashlib
from pathlib import Path
root=Path.cwd();out=root/'artifacts/requests-review';out.mkdir(parents=True,exist_ok=True)
base='http://127.0.0.1:5208/clients/tauri/test/ui/requests-review.html';checks=[];shots=[]
def ab(*args,code=None):
 p=subprocess.run(['agent-browser','--session','pibo-requests-qa','--json',*args],input=code,text=True,capture_output=True,timeout=30)
 if p.returncode:raise RuntimeError(p.stderr or p.stdout)
 data=json.loads(p.stdout)
 if not data.get('success'):raise RuntimeError(data)
 return data.get('data',{})
def js(code):return ab('eval','--stdin',code=code).get('result')
def snapshot():return ab('snapshot','-i')
def click(name):
 refs=snapshot()['refs'];ref=next(k for k,v in refs.items() if v['role']=='button' and v['name']==name)
 ab('click','@'+ref);time.sleep(.2);snapshot()
def save():
 (out/'results.json').write_text(json.dumps({'scope':'Fake requests/messages, Chromium viewport simulation, no real approval or OS IME execution','checks':checks,'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks),'screenshots':shots,'sourceHashes':{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in ['src/gui/ConversationRequests.jsx','src/gui/conversation-requests.js','src/gui/request-attention.css','src/gui/composer-keyboard.ts']}},ensure_ascii=False,indent=2))
def check(name,value):
 checks.append({'check':name,'pass':bool(value)});save();print(name,value,flush=True)
 if not value:raise AssertionError(name)
def shot(name):ab('screenshot',str(out/name));shots.append(name);save()
def openq(query=''):
 ab('open',base+query);ab('wait','.request-attention');time.sleep(.3);snapshot()
for w,h in [(1100,760),(393,852),(320,568),(844,390)]:
 ab('set','viewport',str(w),str(h));openq()
 check(f'{w} pending entry visible at message end without horizontal overflow',js('(()=>{const r=document.querySelector(".request-attention").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth&&document.querySelector(".conversation").scrollTop>500})()'))
 check(f'{w} scoped count excludes other bot',js('document.querySelector(".request-attention").textContent.includes("1 项待处理")'))
 check(f'{w} Chinese and literal spaces preserved exactly',js('document.querySelector(".row.user .message-body").textContent===window.__REQUEST_QA__.sample'))
 shot(f'{w}-pending-entry.png');before=js('document.querySelector("header").getBoundingClientRect().top');click('查看请求')
 check(f'{w} view focuses actual card and scrolls only conversation',js('document.activeElement.id==="conversation-request-qa-approval"&&document.querySelector(".conversation").scrollTop<20') and js('document.querySelector("header").getBoundingClientRect().top')==before)
 check(f'{w} viewing does not approve or reject',js('window.__REQUEST_QA__.calls.length===0'))
 # agent-browser scrollintoview checks page visibility but can miss the clipped ancestor.
 # Exercise the message container's own scroll range, as a touch/trackpad scroll does.
 js('(()=>{const c=document.querySelector(".conversation"),b=[...c.querySelectorAll("button")].find(b=>b.textContent==="拒绝"),bottom=b.getBoundingClientRect().bottom,edge=Math.min(c.getBoundingClientRect().bottom,document.querySelector(".composer-area").getBoundingClientRect().top-8);if(bottom>edge)c.scrollTop+=bottom-edge+8})()');snapshot()
 check(f'{w} real card actions reachable above floating input by internal scroll',js('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent==="允许").getBoundingClientRect(),r=document.querySelector(".conversation").getBoundingClientRect(),edge=Math.min(r.bottom,document.querySelector(".composer-area").getBoundingClientRect().top-8);return b.top>=r.top&&b.bottom<=edge})()'));shot(f'{w}-request-card.png')
 click('拒绝');check(f'{w} explicit fake response resolves only selected request',js('window.__REQUEST_QA__.calls.length===1&&window.__REQUEST_QA__.calls[0].requestId==="qa-approval"&&!document.querySelector(".request-attention")'))
ab('set','viewport','1100','760');openq('?missing=1');click('查看请求')
check('Missing message card expands same actionable request without responding',js('!!document.querySelector(".request-attention-fallback")&&window.__REQUEST_QA__.calls.length===0'));shot('missing-card-fallback.png')
ab('fill','[aria-label="消息"]','中文测试 p w d')
js('(()=>{const e=document.querySelector("[aria-label=消息]");e.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:"中"}));e.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,keyCode:229,bubbles:true}));})()');snapshot()
check('Synthetic Chinese IME Enter preserves input and sends nothing',js('window.__REQUEST_QA__.sent.length===0&&document.querySelector("[aria-label=消息]").value==="中文测试 p w d"'))
js('document.querySelector("[aria-label=消息]").dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"中文"}))');ab('press','Enter');snapshot()
check('Ordinary Enter preserves internal spaces in sent fake payload',js('window.__REQUEST_QA__.sent.length===1&&window.__REQUEST_QA__.sent[0]==="中文测试 p w d"'))
save();print(json.dumps({'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks),'screenshots':shots},ensure_ascii=False),flush=True)
