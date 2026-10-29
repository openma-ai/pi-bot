"""Synthetic reactions only. Requires the repo-root Vite QA server on loopback 5208."""
import json
import os
import subprocess
from pathlib import Path

SESSION = 'pibo-reactions'
BASE = 'http://127.0.0.1:5208/src/gui/reactions-qa.html'
OUT = Path(os.environ.get('PIBO_REACTION_QA_DIR', '/tmp/pibo-reaction-qa'))
OUT.mkdir(parents=True, exist_ok=True)

def browser(*args):
    result = subprocess.run(['agent-browser', '--session', SESSION, *args], check=True, text=True, capture_output=True, timeout=180)
    return result.stdout

browser('open', BASE)
browser('snapshot', '-i')
checks = browser('eval', r'''(async()=>{
  const checks=[];
  const tick=()=>new Promise(resolve=>setTimeout(resolve,60));
  const button=name=>[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent)===name);
  const click=async name=>{const b=button(name);if(!b)throw Error('Missing control '+name);b.click();await tick();};
  const check=(name,ok)=>{if(!ok)throw Error(name);checks.push(name);};
  const status=()=>document.querySelector('output').textContent;
  await click('添加表情');await click('取消选择表情');
  check('cancel picker creates no mutation',status().includes('requests=0')&&!document.querySelector('.message-reaction-picker'));
  await click('添加表情');
  document.querySelector('.message-reaction-picker').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();
  check('Escape closes picker',!document.querySelector('.message-reaction-picker'));
  await click('添加表情');
  const heart=button('使用 ❤️');heart.click();heart.click();await tick();
  check('duplicate pending clicks send one set',status().includes('requests=1; pending=1')&&button('添加表情').disabled);
  await click('消息二');await click('完成请求');
  check('late result does not affect different message',status().includes('message=two')&&!button('❤️ 表情'));
  await click('消息一');
  check('restored snapshot reflects persisted original message',button('❤️ 表情')?.getAttribute('aria-pressed')==='true'&&button('❤️ 表情')?.textContent.includes('2'));
  await click('❤️ 表情');await click('完成请求');
  check('toggle removes own reaction and retains other actor',button('❤️ 表情')?.getAttribute('aria-pressed')==='false'&&button('❤️ 表情')?.textContent.includes('1'));
  await click('添加表情');await click('使用 👍');await click('失败请求');
  check('failed mutation is recoverable and never fake success',!!document.querySelector('.message-reaction-error')&&!button('👍 表情')&&!button('添加表情').disabled);
  await click('使用 👍');await click('完成请求');await click('恢复快照');
  check('retry and refreshed snapshot preserve confirmed reaction',button('👍 表情')?.getAttribute('aria-pressed')==='true'&&!document.querySelector('.message-reaction-error'));
  return checks;
})()''')
browser('set', 'viewport', '320', '640')
browser('find', 'role', 'button', 'click', '--name', '添加表情')
browser('snapshot', '-i')
geometry = browser('eval', r'''(()=>{
  const picker=document.querySelector('.message-reaction-picker').getBoundingClientRect();
  const article=document.querySelector('article').getBoundingClientRect();
  const next=document.querySelector('article').nextElementSibling.getBoundingClientRect();
  if(document.documentElement.scrollWidth>innerWidth||picker.right>innerWidth||next.top<article.bottom)throw Error('Narrow picker overflow or content overlap');
  return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,picker:{left:picker.left,right:picker.right,height:picker.height},followingTop:next.top,articleBottom:article.bottom};
})()''')
browser('screenshot', str(OUT/'reaction-narrow.png'))
browser('set', 'viewport', '1100', '800')
browser('screenshot', str(OUT/'reaction-desktop.png'))
(OUT/'result.json').write_text(json.dumps({'checks':checks,'geometry':geometry,'synthetic':True},ensure_ascii=False,indent=2))
print(checks)
print(geometry)
print('Synthetic screenshots and result:', OUT)
