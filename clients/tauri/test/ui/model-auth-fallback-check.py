"""Only agent-browser CLI, a dedicated session, localhost5208 and fake auth data."""
import json,subprocess,time,traceback,hashlib,sys
from pathlib import Path
ROOT=Path.cwd();OUT=ROOT/'artifacts/model-auth-fallback';OUT.mkdir(parents=True,exist_ok=True)
BASE='http://127.0.0.1:5208/clients/tauri/test/ui/model-auth-review.html';SESSION='pibo-fallback-qa-20261028'
checks=[];shots=[]
def ab(*args,code=None):
 p=subprocess.run(['agent-browser','--session',SESSION,'--json',*args],input=code,capture_output=True,text=True,timeout=30)
 if p.returncode:raise RuntimeError(p.stderr or p.stdout)
 data=json.loads(p.stdout)
 if not data.get('success'):raise RuntimeError(data)
 return data.get('data',{})
def js(code):return ab('eval','--stdin',code=code).get('result')
def snap():return ab('snapshot','-i')
def pause():time.sleep(.2)
def click(name,role='button'):
 refs=snap().get('refs',{});matches=[ref for ref,item in refs.items() if item.get('role')==role and item.get('name')==name]
 if len(matches)!=1:raise AssertionError({'name':name,'role':role,'matches':matches,'refs':refs})
 ab('scrollintoview','@'+matches[0]);pause();refs=snap().get('refs',{});ref=next(ref for ref,item in refs.items() if item.get('role')==role and item.get('name')==name)
 ab('click','@'+ref);pause();snap()
def openq(query=''):
 ab('open',BASE+('?' + query if query else ''));ab('wait','[aria-label="模型提供商"]' if not any(k in query for k in ['configured','ambient']) else '[aria-label="默认模型"]');pause();snap()
def login():click('Sign in with ChatGPT');ab('wait','.pi-login-flow');time.sleep(.7);snap()
def count(path):return js('window.__MODEL_AUTH_QA__.calls.filter(c=>c.path==='+json.dumps(path)+'&&c.method==="POST").length')
def has(selector):return js('!!document.querySelector('+json.dumps(selector)+')')
def text():return js('document.body.textContent')
def fixture(action):js('window.__MODEL_AUTH_Q__.'+action) if False else js('window.__MODEL_AUTH_QA__.'+action)
def save():
 report={'scope':'Isolated fake-auth QA only; no provider grants, real credentials, runtime or user browser access','url':BASE,'session':SESSION,'checks':checks,'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks),'screenshots':shots,'limits':['Chromium viewport simulation; no real iOS/Android keyboard or native WebView execution','Native bridge is explicitly mocked; actual secure-window behavior is covered separately by Rust fixtures'],'sourceHashes':{p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in ['src/gui/PiSettingsDialog.jsx','src/gui/pi-login-presentation.ts','src/gui/brand.css','clients/tauri/test/ui/model-auth-review.jsx']}}
 (OUT/'fallback-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
def check(name,value,details=None):
 checks.append({'check':name,'pass':bool(value),'details':details});save();print(name+': '+str(bool(value)),flush=True)
 if not value:raise AssertionError(name)
def shot(name):ab('screenshot',str(OUT/name));shots.append(str(OUT/name));save()
def expand():
 ab('find','text','无法自动完成？','click','--exact');pause();snap()
def geometry(name,w,h,desktop_cancel=False):
 d=js('(()=>{const d=document.querySelector(".settings-page").getBoundingClientRect(),v=document.querySelector(".settings-body .rt-ScrollAreaViewport").getBoundingClientRect(),b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="取消登录")?.getBoundingClientRect();return {pageWidth:document.documentElement.scrollWidth,dialog:d.toJSON(),viewport:v.toJSON(),cancel:b?.toJSON()}})()')
 check(name+' dialog stays inside viewport',d['pageWidth']<=w and d['dialog']['left']>=-.5 and d['dialog']['right']<=w+.5 and d['dialog']['top']>=-.5 and d['dialog']['bottom']<=h+.5,d)
 if desktop_cancel:check(name+' cancel visible without scrolling',d['cancel']['top']>=d['viewport']['top']-.5 and d['cancel']['bottom']<=d['viewport']['bottom']+.5,d)
def desktop():
 ab('set','viewport','1100','760');openq();login()
 check('Browser waiting shows spinner and SDK link',has('.pi-spinner') and '等待你在浏览器完成登录' in text() and has('a[href="https://example.invalid/isolated-qa-no-oauth"]'))
 check('Manual fallback starts collapsed and hides its password field',js('!document.querySelector(".pi-login-fallback").open&&!document.querySelector("[aria-label=授权回跳地址]").checkVisibility()'))
 geometry('Desktop waiting',1100,760,True);shot('01-isolated-qa-waiting-desktop.png')
 click('打开授权页面','link');check('Fake browser link stays localhost and does not create another grant',ab('get','url').get('url','').startswith(BASE) and count('login')==1 and js('window.__MODEL_AUTH_QA__.calls.some(c=>c.kind==="blocked-fixture-link")'))
 expand();check('Fallback opens only by explicit action and remains password-style',js('document.querySelector(".pi-login-fallback").open&&document.querySelector("[aria-label=授权回跳地址]").type==="password"'))
 ab('fill','[aria-label="授权回跳地址"]','QA-SYNTHETIC-UNSENT-CALLBACK');time.sleep(1.35);snap();check('Fallback draft survives same-prompt polling',js('document.querySelector("[aria-label=授权回跳地址]").value')=='QA-SYNTHETIC-UNSENT-CALLBACK');shot('02-isolated-qa-manual-expanded.png')
 fixture('progress()');ab('wait','--text','正在确认授权结果');pause();snap();check('Token-exchange progress removes fallback and auth links',not has('.pi-login-fallback') and not has('[aria-label="授权回跳地址"]') and not has('a[href="https://example.invalid/isolated-qa-no-oauth"]') and has('.pi-spinner'));shot('03-isolated-qa-exchanging.png')
 fixture('complete()');ab('wait','[aria-label="默认模型"]');pause();snap()
 check('Success enters model selection without choosing or saving a model',js('window.__MODEL_AUTH_QA__.configuration().current.model===""&&document.querySelector("[aria-label=默认模型]").textContent.includes("请选择模型")') and count('model')==0)
 check('Refreshed catalog note does not promise per-model access', '不代表账号拥有每个模型' in text());shot('04-isolated-qa-connected-choose-model.png')
 click('默认模型','combobox');options=[v['name'] for v in snap().get('refs',{}).values() if v.get('role')=='option']
 check('Only configured provider models appear',len(options)==2 and all('OpenAI' in o and 'Codex' not in o for o in options),options)
 click('QA fixture model OpenAI · qa-model','option');check('Model selection remains a draft until explicit save',count('model')==0 and js('window.__MODEL_AUTH_QA__.configuration().current.model===""'))
def device():
 openq();click('设备码登录（可在手机完成）');check('Device entry only changes provider and never starts a grant',count('login')==0 and js('document.querySelector("[aria-label=模型提供商]").textContent.includes("legacy")'));shot('05-isolated-qa-device-entry.png')
 click('OpenAI (ChatGPT Plus/Pro)');ab('wait','[aria-label="登录选项"]');click('登录选项','combobox');click('设备码登录（可在手机授权）','option');click('继续');ab('wait','--text','QA-ONLY');pause();snap()
 check('Explicit device login keeps SDK device-code state and spinner',has('.pi-device-code') and has('.pi-spinner') and not has('.pi-login-fallback') and count('login')==1);shot('06-isolated-qa-device-waiting.png')
 click('取消登录');check('Cancellation does not create a new login or save a model',count('login')==1 and count('model')==0 and js('[...window.__MODEL_AUTH_QA__.flows.values()].every(f=>f.status==="cancelled")'))
def failure_unknown():
 openq('mode=failed');click('Sign in with ChatGPT');ab('wait','[role="alert"]');pause();snap();check('Failed flow stops spinner and leaves explicit recovery',not has('.pi-login-flow') and not has('.pi-spinner') and count('login')==1);shot('07-isolated-qa-failed.png')
 openq('mode=lost-start');click('Sign in with ChatGPT');ab('wait','--text','正在确认登录状态');pause();snap();check('Unknown outcome is shown without a replacement grant',count('login')==1 and has('.pi-spinner'));shot('08-isolated-qa-unknown.png')
 fixture('releaseState()');ab('wait','.pi-login-fallback');pause();snap();check('Unknown outcome recovers by reading the original flow',count('login')==1 and js('window.__MODEL_AUTH_QA__.flows.size===1'))
 click('取消登录');time.sleep(.7);snap();check('Cancelled unknown flow stays closed with no automatic restart',not has('.pi-login-flow') and count('login')==1 and count('model')==0)
 openq('mode=lost-start');click('Sign in with ChatGPT');click('取消登录');fixture('releaseState()');time.sleep(.8);snap();check('Late uncertain read cannot resurrect cancelled UI',not has('.pi-login-flow') and count('login')==1)
def native_remote():
 openq('native=1&remote=1');login();check('Remote runtime note never promises local auto-callback','不会自动到达远端运行环境' in text());shot('09-isolated-qa-remote-native-mock.png')
 click('打开授权页面');check('Native-mock browser link uses only restricted command',js('window.__MODEL_AUTH_QA__.calls.filter(c=>c.command==="pi_settings_open_login").length===1') and count('login')==1)
 expand();check('Native fallback keeps secret input outside main WebView',not has('[aria-label="授权回跳地址"]'));click('粘贴授权回跳地址');check('Native fallback opens only the bound fake secure window',js('window.__MODEL_AUTH_QA__.nativeForms.size===1'))
 fixture('nativeForms.set("other-unfinished-flow","other-prompt")');fixture('complete()');ab('wait','[aria-label="默认模型"]');time.sleep(.3);snap()
 check('Native success cleanup targets only its own flow',js('window.__MODEL_AUTH_QA__.nativeForms.size===1&&window.__MODEL_AUTH_QA__.nativeForms.has("other-unfinished-flow")&&window.__MODEL_AUTH_QA__.calls.filter(c=>c.command==="pi_settings_close_forms").length===1'))
 openq('native=1');login();check('Local native-mock note explains automatic model return','完成后会自动返回模型选择' in text());click('取消登录')
 openq('ambient=1&catalog=failed');check('Configured without stored credential still exposes model selection',has('[aria-label="默认模型"]') and not has('[aria-label="认证管理"]'));check('Catalog failure stays an honest cache note','模型目录刷新未完成' in text() and '逐模型访问权限未经验证' in text());shot('10-isolated-qa-catalog-cache.png')
def mobile():
 for index,(w,h) in enumerate([(393,852),(320,568),(844,390)]):
  ab('set','viewport',str(w),str(h));openq('remote=1');login();geometry(f'{w} waiting',w,h)
  check(f'{w} fallback initially collapsed',js('!document.querySelector(".pi-login-fallback").open'));shot(f'{11+index*2:02d}-isolated-qa-waiting-{w}x{h}.png')
  expand();ab('scrollintoview','[aria-label="授权回跳地址"]');pause();snap();check(f'{w} fallback input visible and password-style',js('document.querySelector("[aria-label=授权回跳地址]").checkVisibility()&&document.querySelector("[aria-label=授权回跳地址]").type==="password"'))
  ab('scrollintoview','button:has-text("取消登录")');pause();snap();geometry(f'{w} expanded',w,h)
  check(f'{w} internal scroll reaches cancel',js('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="取消登录").getBoundingClientRect(),v=document.querySelector(".settings-body .rt-ScrollAreaViewport").getBoundingClientRect();return b.top>=v.top-1&&b.bottom<=v.bottom+1})()'));shot(f'{12+index*2:02d}-isolated-qa-expanded-{w}x{h}.png')
  click('取消登录');check(f'{w} cancel preserves zero model writes and a single login',count('login')==1 and count('model')==0 and not has('.pi-login-flow'))
for name,fn in [('desktop',desktop),('device',device),('failure-unknown',failure_unknown),('native-remote',native_remote),('mobile',mobile)]:
 if len(sys.argv)>1 and name not in sys.argv[1:]:continue
 try:fn()
 except Exception as error:
  checks.append({'check':name+' case completed','pass':False,'error':str(error)});save();print(traceback.format_exc(),flush=True)
save();print(json.dumps({'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks),'screenshots':shots},ensure_ascii=False),flush=True)
raise SystemExit(1 if any(not c['pass'] for c in checks) else 0)
