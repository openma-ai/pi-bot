"""Production UI, synthetic metadata/auth only; never talks to a provider."""
import json,subprocess,time
from pathlib import Path
out=Path('artifacts/model-connections-review');out.mkdir(parents=True,exist_ok=True)
checks=[]
def ab(*args,code=None):
 p=subprocess.run(['agent-browser','--session','pibo-connections','--json',*args],input=code,text=True,capture_output=True,timeout=90)
 if p.returncode:raise RuntimeError(p.stderr or p.stdout)
 r=json.loads(p.stdout)
 if not r.get('success'):raise RuntimeError(r)
 return r['data']
def js(code):return ab('eval','--stdin',code=code).get('result')
def act(name,role='button',verb='click',value=None,prefix=False):
 refs=ab('snapshot','-i')['refs'];found=[k for k,v in refs.items() if v['role']==role and (v['name'].startswith(name) if prefix else v['name']==name)]
 assert len(found)==1,(name,refs)
 if verb=='click' and role=='button':
  ab('scrollintoview','@'+found[0]);js('(()=>{const b=[...document.querySelectorAll("button")].find(e=>(e.getAttribute("aria-label")||e.textContent.trim())==='+json.dumps(name)+');const v=b?.closest(".rt-ScrollAreaViewport");if(v){const r=b.getBoundingClientRect(),s=v.getBoundingClientRect();if(r.bottom>s.bottom)v.scrollTop+=r.bottom-s.bottom+8;if(r.top<s.top)v.scrollTop-=s.top-r.top+8;}})()')
  refs=ab('snapshot','-i')['refs'];found=[k for k,v in refs.items() if v['role']==role and (v['name'].startswith(name) if prefix else v['name']==name)]
 args=[verb,'@'+found[0]]+([value] if value is not None else [])
 ab(*args);time.sleep(.15)
def check(name,ok,data=None):
 checks.append({'name':name,'pass':bool(ok),'details':data});(out/'results.json').write_text(json.dumps({'scope':'Synthetic QA, no real accounts or inference','checks':checks},ensure_ascii=False,indent=2));print(name,bool(ok),flush=True);assert ok,name
def frame():return js('(()=>{const r=document.querySelector(".settings-page").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scrollWidth:document.documentElement.scrollWidth}})()')
base='http://127.0.0.1:5208/clients/tauri/test/ui/model-auth-review.html?connections=1&manage=1&native=1'
ab('set','viewport','1440','900');ab('open',base);ab('wait','[aria-label="默认模型"]');baseline=frame()
check('desktop fixed 940x680 centered',baseline['width']==940 and baseline['height']==680 and baseline['x']==250 and baseline['y']==110,baseline)
act('默认模型','combobox');refs=ab('snapshot','-i')['refs'];options=[v['name'] for v in refs.values() if v['role']=='option'];check('same model labels distinguish two accounts',len(options)==2 and any('工作账号' in x for x in options) and any('个人账号' in x for x in options),options);ab('press','Escape')
act('管理连接');check('connected summaries hide duplicate login actions',js('document.querySelectorAll(".pi-connection-row").length===2&&!document.querySelector(".pi-auth-methods")'))
ab('screenshot',str(out/'desktop-connections.png'));act('添加连接');act('连接名称','textbox','fill','Custom QA');act('模型提供商','combobox');act('自定义服务','option',prefix=True)
act('API 地址','textbox','fill','https://example.invalid/v1?key=x');act('保存并继续认证');check('invalid URL stays local',js('window.__MODEL_AUTH_QA__.calls.every(c=>c.path!=="connections/save")'))
act('API 地址','textbox','fill','http://127.0.0.1:4999/v1/');act('模型 ID 1','textbox','fill','qa-local');act('模型名称 1','textbox','fill','Local QA');act('上下文长度 1','spinbutton','fill','32000');act('最大输出 1','spinbutton','fill','4096')
ab('screenshot',str(out/'desktop-endpoint.png'));act('取消并返回');check('cancel does not create connection',js('window.__MODEL_AUTH_QA__.configuration().connections.length===2&&window.__MODEL_AUTH_QA__.calls.every(c=>c.path!=="connections/save")'))
ab('back');time.sleep(.3);check('Back restores editor without creating auth',js('!!document.querySelector(".pi-connection-editor")&&window.__MODEL_AUTH_QA__.calls.every(c=>c.path!=="login")'));ab('forward');time.sleep(.3);check('Forward restores connection list',js('!!document.querySelector(".pi-connections-list")'))
act('添加连接');act('连接名称','textbox','fill','Third QA');act('模型提供商','combobox');act('DeepSeek','option',prefix=True);act('保存并继续认证');check('new provider saves independently',js('window.__MODEL_AUTH_QA__.configuration().connections.length===3&&window.__MODEL_AUTH_QA__.configuration().current.connectionId.startsWith("1111")'))
act('添加 API key');check('auth request targets new connection',js('(()=>{const q=window.__MODEL_AUTH_QA__,c=q.configuration().connections.find(c=>c.name==="Third QA"),r=q.calls.findLast(c=>c.path==="login");return r.connectionId===c.id&&q.flows.size===1})()'))
act('取消登录');check('cancel ends only synthetic pending login',js('[...window.__MODEL_AUTH_QA__.flows.values()].every(f=>f.status==="cancelled")'))
act('返回');check('frame unchanged across subpages',frame()==baseline,frame())
for w,h in [(393,852),(844,390)]:
 ab('set','viewport',str(w),str(h));ab('open',base);ab('wait','[aria-label="默认模型"]');f=frame();check(str(w)+' frame fits viewport',f['x']>=0 and f['y']>=0 and f['width']<=w and f['height']<=h and f['scrollWidth']<=w,f);act('管理连接');act('添加连接');check(str(w)+' editor has no horizontal overflow',js('document.documentElement.scrollWidth<=innerWidth'));ab('screenshot',str(out/(str(w)+'-connections.png')));act('取消并返回');act('关闭设置');check(str(w)+' close works',js('!document.querySelector(".settings-page")'))
ab('open',base+'&old-native=1');ab('wait','.pi-settings-panel');check('old native bridge fails closed',js('document.body.innerText.includes("请更新原生客户端")&&window.__MODEL_AUTH_QA__.calls.every(c=>c.method!=="POST")'))
check('no browser errors',not ab('errors').get('errors',[]));ab('close')
print(json.dumps({'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks)}))
