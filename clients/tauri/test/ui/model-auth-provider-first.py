"""Incremental provider-first QA; retains the prior reports and screenshots 01–12."""
import runpy,json,time,sys,traceback,hashlib
from pathlib import Path
m=runpy.run_path('clients/tauri/test/ui/model-auth-check.py')
ab,js,click,snapshot=m['ab'],m['js'],m['click'],m['snapshot']
out=Path('artifacts/model-auth-review');checks=[];screenshots=[]
base='http://127.0.0.1:5208/clients/tauri/test/ui/model-auth-review.html'
def save():
 result={'scope':'Provider-first incremental browser QA; fake credentials and OAuth completion only','checks':checks,'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks),'screenshots':screenshots,
 'limits':['Chromium viewport simulation, not native/device keyboard or secure credential-window validation','No real OAuth, provider request, user credentials or runtime data used'],
 'sourceHashes':{p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in ['src/gui/PiSettingsDialog.jsx','src/gui/SettingsPage.jsx','src/gui/brand.css']}}
 (out/'model-auth-provider-first-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
def check(name,value,details=None):
 checks.append({'check':name,'pass':bool(value),'details':details});save();print(name+': '+str(bool(value)),flush=True)
 if not value:raise AssertionError(name)
def shot(name):ab('screenshot',str(out/name));screenshots.append(name);save()
def openq(query='',selector='[aria-label="模型提供商"]'):
 ab('open',base+('?' + query if query else ''));ab('wait',selector);time.sleep(.25);snapshot()
def count(path):return js('window.__MODEL_AUTH_QA__.calls.filter(c=>c.path==='+json.dumps(path)+').length')
def state():return js('window.__MODEL_AUTH_QA__.configuration().current')
def has(selector):return js('!!document.querySelector('+json.dumps(selector)+')')
def no_warnings():return js('window.__MODEL_AUTH_QA__.warnings.filter(v=>/uncontrolled|controlled/.test(v))')
def geometry(label,w,h):
 d=js('(()=>{const e=document.querySelector(".settings-page"),v=document.querySelector(".settings-body .rt-ScrollAreaViewport");return {width:document.documentElement.scrollWidth,dialog:e.getBoundingClientRect().toJSON(),scrollHeight:v.scrollHeight,clientHeight:v.clientHeight}})()')
 check(label+' stays within viewport',d['width']<=w and d['dialog']['left']>=-.5 and d['dialog']['top']>=-.5 and d['dialog']['right']<=w+.5 and d['dialog']['bottom']<=h+.5,d)
def latest_complete(persist=True):
 js('(()=>{const q=window.__MODEL_AUTH_QA__;q.complete([...q.flows.keys()].at(-1),'+str(persist).lower()+')})()')
def run_case(name,fn):
 try:fn()
 except Exception as error:
  checks.append({'check':name+' completed','pass':False,'error':str(error)});save();print(traceback.format_exc(),flush=True)

def first_run():
 for index,(w,h) in enumerate([(393,852),(320,568),(874,402)]):
  ab('set','viewport',str(w),str(h));openq()
  check(f'{w} first run opens provider-first without empty model step',has('[aria-label="认证管理"]') and not has('[aria-label="默认模型"]'))
  check(f'{w} OpenAI default retains independent ChatGPT/API key choices',js('document.querySelector("[aria-label=模型提供商]").textContent.includes("OpenAI")&&["Sign in with ChatGPT","添加 API key"].every(t=>[...document.querySelectorAll("button")].some(b=>b.textContent.trim()===t))'))
  geometry(f'{w} auth',w,h);shot(f'{13+index*3:02d}-provider-first-{w}x{h}.png')
  click('Sign in with ChatGPT');ab('wait','.pi-login-fallback');latest_complete()
  ab('wait','[aria-label="默认模型"]');snapshot()
  check(f'{w} confirmed credential unlocks model selection without auto-select/save',state()['model']=='' and count('model')==0 and js('document.querySelector("[aria-label=默认模型]").textContent.includes("请选择模型")') and not has('.pi-settings-footer'))
  click('默认模型','combobox')
  options=[item['name'] for item in snapshot().get('refs',{}).values() if item.get('role')=='option']
  check(f'{w} model picker lists only credential-backed provider models',len(options)==2 and all('QA fixture' in x and 'OpenAI' in x for x in options) and not any('Codex' in x or 'DeepSeek' in x for x in options),options)
  click('QA fixture model OpenAI · qa-model','option')
  check(f'{w} selecting model is a local draft until explicit completion',state()['model']=='' and count('model')==0)
  check(f'{w} thinking control remains folded under more options',has('details.pi-advanced') and js('!document.querySelector("details.pi-advanced").open'))
  ab('scrollintoview','button:has-text("完成设置")');time.sleep(.1);snapshot();geometry(f'{w} completion',w,h)
  shot(f'{14+index*3:02d}-model-ready-{w}x{h}.png');click('完成设置')
  ab('wait','[role="dialog"]','--state','hidden') if False else time.sleep(.35)
  check(f'{w} completion saves once and closes Settings',count('model')==1 and state()['model']=='qa-model' and not has('.settings-page'))
  click('打开隔离模型设置');ab('wait','[aria-label="默认模型"]');snapshot()
  check(f'{w} reopen restores saved model and sole manage connection entry',js('document.querySelector("[aria-label=默认模型]").textContent.includes("QA fixture model")&&[...document.querySelectorAll(".pi-settings-panel button")].filter(b=>b.textContent.trim()==="管理连接").length===1&&!document.querySelector(".pi-settings-panel").textContent.includes("有未保存的更改")'))
  shot(f'{15+index*3:02d}-configured-{w}x{h}.png')
  click('管理连接');click('返回')
  check(f'{w} auth management roundtrip keeps current model',state()['model']=='qa-model' and js('document.querySelector("[aria-label=默认模型]").textContent.includes("QA fixture model")') and count('model')==1)
  check(f'{w} controlled Select has no ownership warning',not no_warnings(),no_warnings())

def failures():
 ab('set','viewport','393','852');openq();click('Sign in with ChatGPT');ab('wait','.pi-login-fallback');click('取消登录')
 check('First-run cancel stays in auth and does not create a model/grant retry',has('[aria-label="认证管理"]') and not has('[aria-label="默认模型"]') and count('login')==1 and count('model')==0)
 openq('mode=lost-start');click('Sign in with ChatGPT');time.sleep(.25)
 check('Unknown response stays in auth with one grant',has('[aria-label="认证管理"]') and not has('[aria-label="默认模型"]') and count('login')==1 and js('document.body.textContent.includes("正在确认登录状态")'))
 js('window.__MODEL_AUTH_QA__.releaseState()');ab('wait','.pi-login-fallback');snapshot()
 check('Unknown response recovers with reads without choosing a model',count('login')==1 and count('model')==0 and has('[aria-label="认证管理"]'))
 click('取消登录')
 openq();click('Sign in with ChatGPT');ab('wait','.pi-login-fallback');latest_complete(False);time.sleep(.9);snapshot()
 check('Completed login without confirmed credential does not enter model selection',has('[aria-label="认证管理"]') and not has('[aria-label="默认模型"]') and js('document.body.textContent.includes("连接状态尚未确认")'))
 shot('22-credential-unconfirmed.png')
 openq('mode=config-error','[role="alert"]')
 check('Config failure is shown as an error, not empty auth or model configuration',has('[role="alert"]') and not has('[aria-label="模型提供商"]') and not has('[aria-label="默认模型"]') and count('login')==0)
 shot('23-config-load-failed.png');js('window.__MODEL_AUTH_QA__.setMode("")');click('重新加载');ab('wait','[aria-label="模型提供商"]')
 check('Config retry restores provider-first only after actual mock data arrives',has('[aria-label="认证管理"]') and count('login')==0)
 click('模型提供商','combobox');click('OpenAI Codex (legacy) OpenAI (ChatGPT Plus/Pro)','option');click('OpenAI (ChatGPT Plus/Pro)');ab('wait','[aria-label="登录选项"]');click('登录选项','combobox')
 choices=[i['name'] for i in snapshot().get('refs',{}).values() if i.get('role')=='option']
 check('Legacy options are localized for browser and phone device authorization',choices==['浏览器登录','设备码登录（可在手机授权）'],choices)
 click('设备码登录（可在手机授权）','option');click('继续');time.sleep(.8);snapshot()
 check('Localized device option preserves SDK device_code identifier',js('document.body.textContent.includes("QA-ONLY")'))
 check('Legacy selection emits no uncontrolled/controlled warning',not no_warnings(),no_warnings());click('取消登录')

for name,fn in [('first-run',first_run),('failure-states',failures)]:
 if len(sys.argv)==1 or name in sys.argv[1:]:run_case(name,fn)
save();print(json.dumps({'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks),'screenshots':screenshots},ensure_ascii=False),flush=True)
raise SystemExit(1 if any(not c['pass'] for c in checks) else 0)
