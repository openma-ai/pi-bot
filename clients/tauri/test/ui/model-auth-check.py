"""Agent-browser QA of real settings components with isolated fake auth data only."""
import subprocess,json,time,traceback,sys
from pathlib import Path
out=Path('artifacts/model-auth-review');out.mkdir(parents=True,exist_ok=True)
base='http://127.0.0.1:5208/clients/tauri/test/ui/model-auth-review.html'
checks=[];shots=[]
report_name='model-auth-results.json' if len(sys.argv)==1 else 'model-auth-'+ '-'.join(sys.argv[1:])+'-results.json'
def ab(*args):
 p=subprocess.run(['agent-browser','--session','pibo-model-auth-qa','--json',*args],capture_output=True,text=True,timeout=25)
 if p.returncode:raise RuntimeError(p.stderr or p.stdout)
 d=json.loads(p.stdout)
 if not d.get('success'):raise RuntimeError(d)
 return d.get('data',{})
def js(code):return ab('eval',code).get('result')
def snapshot():return ab('snapshot','-i')
def wait(seconds=.25):time.sleep(seconds)
def click(name,role='button'):
 refs=snapshot().get('refs',{})
 matches=[ref for ref,item in refs.items() if item.get('role')==role and item.get('name')==name]
 if len(matches)!=1:raise AssertionError({'target':name,'role':role,'matches':matches,'refs':refs})
 ab('scrollintoview','@'+matches[0]);wait(.05)
 refs=snapshot().get('refs',{})
 ref=next(ref for ref,item in refs.items() if item.get('role')==role and item.get('name')==name)
 ab('click','@'+ref);wait();snapshot()
def input_value(label='Pi 登录输入'):return js('document.querySelector('+json.dumps('[aria-label="'+label+'"]')+').value')
def openq(query=''):
 ab('open',base+('?' + query if query else ''));ab('wait','[aria-label="模型提供商"]');wait();snapshot()
def shot(name):
 ab('screenshot',str(out/name));shots.append(name)
def save():
 (out/report_name).write_text(json.dumps({'fixture':'Isolated QA, all auth mocked, no real provider/network/native login','checks':checks,'screenshots':shots,'limits':['Desktop Chromium browser only; viewport dimensions simulate mobile, no iOS/Android keyboard or native credential-window validation','No real OAuth grant, model request, model credentials, or daemon data used']},ensure_ascii=False,indent=2))
def check(name,value,details=None):
 checks.append({'check':name,'pass':bool(value),'details':details});save();print(name+': '+str(bool(value)),flush=True)
 if not value:raise AssertionError(name)
def auth():
 if not js('!!document.querySelector("[aria-label=认证管理]")'):click('管理连接')
def fallback():
 ab('wait','.pi-login-fallback');ab('find','text','无法自动完成？','click','--exact');wait();snapshot()
 ab('wait','[aria-label="授权回跳地址"]')
def legacy():
 click('模型提供商','combobox');click('OpenAI Codex (legacy) OpenAI (ChatGPT Plus/Pro)','option')
def login():click('OpenAI (ChatGPT Plus/Pro)')
def choose(option):
 ab('wait','[aria-label="登录选项"]')
 click('登录选项','combobox');click(option,'option');click('继续')
def count(path):return js('window.__MODEL_AUTH_QA__.calls.filter(c=>c.path==='+json.dumps(path)+').length')
def run_case(name,fn):
 try:fn();check(name+' completed',True)
 except Exception as error:
  checks.append({'check':name+' completed','pass':False,'error':str(error)});save();print(traceback.format_exc(),flush=True)

def initial():
 ab('set','viewport','1100','760');openq()
 check('Disconnected opens directly in provider connection',js('!!document.querySelector("[aria-label=认证管理]")&&!document.querySelector("[aria-label=默认模型]")'))
 check('Disconnected has no thinking, save button, or dirty state',js('!["思考强度","保存更改","有未保存的更改"].some(t=>document.querySelector(".pi-settings-panel").textContent.includes(t))'))
 check('Model page uses compact desktop dialog',js('document.querySelector(".settings-page").getBoundingClientRect().height')<=480)
 shot('01-disconnected-desktop.png');auth()
 check('Authentication defaults to openai',js('document.querySelector("[aria-label=模型提供商]").textContent.includes("OpenAI")&&!document.querySelector("[aria-label=模型提供商]").textContent.includes("legacy")'))
 check('ChatGPT and API key are separate visible actions',js('["Sign in with ChatGPT","添加 API key"].every(t=>[...document.querySelectorAll("button")].some(e=>e.textContent.trim()===t))'))
 shot('02-openai-auth-desktop.png')
 check('Browsing authentication does not create a dirty model draft',js('!document.querySelector(".pi-settings-panel").textContent.includes("有未保存的更改")'))
 check('Browsing authentication makes no login request',count('login')==0)

def lifecycle():
 openq('mode=late-start');auth();legacy()
 js('(()=>{const button=[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="OpenAI (ChatGPT Plus/Pro)");button.click();button.click()})()');wait();snapshot()
 check('Duplicate start clicks dispatch one login',count('login')==1)
 click('取消登录');js('window.__MODEL_AUTH_QA__.releaseStart()');wait(.8);snapshot()
 check('Late start is cancelled again and cannot reopen auth UI',js('!document.querySelector(".pi-login-flow")&&window.__MODEL_AUTH_QA__.calls.filter(c=>c.path.endsWith("/cancel")).length===2&&[...window.__MODEL_AUTH_QA__.flows.values()].every(f=>f.status==="cancelled")'))
 login();choose('设备码登录（可在手机授权）');wait(.8);snapshot()
 check('Legacy device-code option renders mocked code and authorization link',js('document.body.textContent.includes("QA-ONLY")&&[...document.querySelectorAll("a")].some(a=>a.href==="https://example.invalid/isolated-qa-no-oauth")'))
 shot('03-legacy-device-desktop.png');click('取消登录')
 login();choose('浏览器登录');fallback()
 ab('fill','[aria-label="授权回跳地址"]','QA-only-unsent-callback-draft');before=js('window.__MODEL_AUTH_QA__.calls.filter(c=>c.method==="GET"&&c.path.startsWith("login/")).length')
 wait(1.5);snapshot()
 check('Auth draft survives repeated same-prompt polling',input_value('授权回跳地址')=='QA-only-unsent-callback-draft')
 check('Draft retention was observed across at least two polls',js('window.__MODEL_AUTH_QA__.calls.filter(c=>c.method==="GET"&&c.path.startsWith("login/")).length')>=before+2)
 shot('04-draft-preserved-desktop.png')
 js('window.__MODEL_AUTH_QA__.setMode("late-answer")');before=js('window.__MODEL_AUTH_QA__.calls.filter(c=>c.path.endsWith("/input")).length')
 js('(()=>{const b=[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="提交备用回跳地址");b.click();b.click()})()');wait();snapshot()
 check('Duplicate answer clicks dispatch one input',js('window.__MODEL_AUTH_QA__.calls.filter(c=>c.path.endsWith("/input")).length')==before+1)
 click('取消登录');js('window.__MODEL_AUTH_QA__.releaseAnswer()');wait(.8);snapshot()
 check('Cancelled late answer cannot complete or resurrect UI',js('!document.querySelector(".pi-login-flow")&&[...window.__MODEL_AUTH_QA__.flows.values()].every(f=>f.status==="cancelled")'))

def uncertain():
 openq('mode=lost-start');auth();click('Sign in with ChatGPT');wait();snapshot()
 check('Lost start response shows uncertain state rather than starting again',js('document.body.textContent.includes("正在确认登录状态")') and count('login')==1)
 shot('05-uncertain-desktop.png');js('window.__MODEL_AUTH_QA__.releaseState()');wait(.8);snapshot()
 check('Uncertain start recovers its existing flow via GET only',count('login')==1 and js('!!document.querySelector(".pi-login-fallback")&&!document.body.textContent.includes("正在确认登录状态")'))
 click('取消登录');check('First-run cancel remains in provider connection',js('!!document.querySelector("[aria-label=模型提供商]")&&[...window.__MODEL_AUTH_QA__.flows.values()].every(f=>f.status==="cancelled")'))

def geometry():
 for w,h in [(393,852),(320,568),(874,402)]:
  ab('set','viewport',str(w),str(h));openq();auth();click('添加 API key');wait(.8);snapshot()
  ab('fill','[aria-label="Pi 登录输入"]','QA-FAKE-KEY-DO-NOT-USE');wait(.7)
  d=js('(()=>{const el=document.querySelector(".settings-page"),v=document.querySelector(".settings-body .rt-ScrollAreaViewport");return {width:innerWidth,height:innerHeight,docWidth:document.documentElement.scrollWidth,dialog:el.getBoundingClientRect().toJSON(),viewport:v.getBoundingClientRect().toJSON(),scrollHeight:v.scrollHeight,clientHeight:v.clientHeight}})()')
  check(f'Viewport {w}x{h}: no horizontal or outer dialog overflow',d['docWidth']<=w and d['dialog']['left']>=-.5 and d['dialog']['right']<=w+.5 and d['dialog']['top']>=-.5 and d['dialog']['bottom']<=h+.5,d)
  js('document.querySelector(".settings-body .rt-ScrollAreaViewport").scrollTop=10000');wait()
  bottom=js('(()=>{const b=[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="取消登录"),v=document.querySelector(".settings-body .rt-ScrollAreaViewport");return {button:b.getBoundingClientRect().toJSON(),viewport:v.getBoundingClientRect().toJSON(),scrollTop:v.scrollTop}})()')
  check(f'Viewport {w}x{h}: internal scroll reaches cancel action',bottom['button']['bottom']<=bottom['viewport']['bottom']+.5 and bottom['button']['top']>=bottom['viewport']['top']-.5,bottom)
  check(f'Viewport {w}x{h}: input remains after polling and scrolling',input_value()=='QA-FAKE-KEY-DO-NOT-USE')
  shot(f'06-auth-{w}x{h}.png');click('取消登录');click('关闭设置');check(f'Viewport {w}x{h}: close exits modal',js('!document.querySelector(".settings-page")'))

if __name__=='__main__':
 for name,fn in [('initial',initial),('lifecycle',lifecycle),('uncertain',uncertain),('geometry',geometry)]:
  if not sys.argv[1:] or name in sys.argv[1:]:run_case(name,fn)
 save();print(json.dumps({'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks),'screenshots':shots},ensure_ascii=False),flush=True)
 raise SystemExit(1 if any(not c['pass'] for c in checks) else 0)
