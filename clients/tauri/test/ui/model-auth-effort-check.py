"""Focused save/effort regression. Local fixture only; no real auth or inference."""
import json, os, subprocess, time
from pathlib import Path

base = os.environ.get('PIBO_QA_URL', 'http://127.0.0.1:5208/clients/tauri/test/ui/model-auth-review.html')
session = 'pibo-effort-qa-20261028'
out = Path('artifacts/model-effort-review')
out.mkdir(parents=True, exist_ok=True)
checks = []
def ab(*args):
    result = subprocess.run(['agent-browser', '--session', session, '--json', *args], capture_output=True, text=True, timeout=25)
    if result.returncode: raise RuntimeError(result.stderr or result.stdout)
    data = json.loads(result.stdout)
    if not data.get('success'): raise RuntimeError(data)
    return data.get('data', {})
def js(code): return ab('eval', code).get('result')
def snapshot(): return ab('snapshot', '-i')
def click(name, role='button'):
    matches = [ref for ref, item in snapshot().get('refs', {}).items() if item.get('name') == name and item.get('role') == role]
    if len(matches) != 1: raise AssertionError({'target': name, 'role': role, 'snapshot': snapshot()})
    ab('scrollintoview', '@' + matches[0])
    matches = [ref for ref, item in snapshot().get('refs', {}).items() if item.get('name') == name and item.get('role') == role]
    ab('click', '@' + matches[0]); time.sleep(.15); snapshot()
def config(): return js('window.__MODEL_AUTH_QA__.configuration().current')
def count(path): return js('window.__MODEL_AUTH_QA__.calls.filter(c=>c.path===' + json.dumps(path) + ').length')
def save():
    (out / 'results.json').write_text(json.dumps({'scope': 'One focused real-component Chromium suite with isolated fake auth and model data',
        'checks': checks, 'passed': sum(c['pass'] for c in checks), 'failed': sum(not c['pass'] for c in checks),
        'limits': ['No real OAuth, model request or user configuration', 'Mobile viewport simulation only, no native device regression'],
        'screenshots': ['01-unsupported-minimal.png', '02-supported-choices.png', '03-off-saved.png']}, ensure_ascii=False, indent=2))
def check(name, condition, detail=None):
    checks.append({'check': name, 'pass': bool(condition), 'detail': detail}); save(); print(name + ': ' + str(bool(condition)), flush=True)
    if not condition: raise AssertionError(name)
def openq(query='', selector='[aria-label="模型提供商"]'):
    ab('open', base + ('?' + query if query else '')); ab('wait', selector); snapshot()
def more():
    ab('find', 'text', '更多选项', 'click', '--exact'); snapshot()
def enabled(name): return js('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()===' + json.dumps(name) + '&&!b.disabled)')

try:
    ab('set', 'viewport', '393', '852')
    openq(); click('Sign in with ChatGPT'); ab('wait', '.pi-login-fallback')
    js('window.__MODEL_AUTH_QA__.complete()'); ab('wait', '[aria-label="默认模型"]'); snapshot()
    check('Mock credential completion still requires explicit model selection', config()['model'] == '' and count('model') == 0)
    click('默认模型', 'combobox'); click('QA fixture model OpenAI · qa-model', 'option')
    check('Existing synthetic fixture supports default high and enables completion', enabled('完成设置'))
    click('完成设置'); time.sleep(.25)
    check('Existing provider-first save succeeds once and closes settings', count('model') == 1 and config()['thinkingLevel'] == 'high' and not js('!!document.querySelector(".settings-page")'))
    click('打开隔离模型设置'); ab('wait', '[aria-label="默认模型"]'); snapshot()
    check('Reopen restores model without false dirty state', config()['model'] == 'qa-model' and not enabled('保存更改') and not js('document.body.textContent.includes("有未保存的更改")'))
    more(); click('思考强度', 'combobox')
    options = [item['name'] for item in snapshot().get('refs', {}).values() if item.get('role') == 'option']
    check('Synthetic model picker uses its explicit fixture capability set', options == ['关闭', '低', '标准', '高'], options)
    ab('press', 'Escape'); snapshot()

    openq('configured=1&effort=gpt-6-sol&thinking=minimal', '[aria-label="默认模型"]')
    check('Unsupported historical minimal is preserved without an automatic save', config()['thinkingLevel'] == 'minimal' and count('model') == 0)
    check('Unsupported effort explains required choice and disables save', not enabled('保存更改') and js('document.body.textContent.includes("当前选择「最低」不受此模型支持")'))
    ab('screenshot', str(out / '01-unsupported-minimal.png'))
    more(); click('思考强度', 'combobox')
    options = [item['name'] for item in snapshot().get('refs', {}).values() if item.get('role') == 'option']
    check('gpt-6-sol exposes SDK six choices with no unsupported minimal', options == ['关闭', '低', '标准', '高', '更高', '最高'], options)
    ab('screenshot', str(out / '02-supported-choices.png'))
    click('关闭', 'option')
    check('Explicit off selection is a local draft until save', enabled('保存更改') and config()['thinkingLevel'] == 'minimal' and count('model') == 0)
    click('保存更改'); time.sleep(.2)
    check('Explicit off saves once without residual dirty state', config()['thinkingLevel'] == 'off' and count('model') == 1 and not enabled('保存更改') and not js('document.body.textContent.includes("有未保存的更改")'))
    ab('screenshot', str(out / '03-off-saved.png'))
    result = js('fetch("/qa/pi/model",{method:"POST",body:JSON.stringify({provider:"openai",model:"gpt-6-sol",thinkingLevel:"minimal"})}).then(r=>r.status)')
    check('Mock server enforces the same unsupported-effort rejection', result == 400 and config()['thinkingLevel'] == 'off')
    openq('configured=1&effort=gpt-6-sol&thinking=off', '[aria-label="默认模型"]')
    check('Existing off remains unchanged and creates no save', config()['thinkingLevel'] == 'off' and count('model') == 0 and not enabled('保存更改'))
    check('Select emits no controlled/uncontrolled warning', not js('window.__MODEL_AUTH_QA__.warnings.filter(v=>/controlled|uncontrolled/.test(v))'))
    print(json.dumps({'passed': len(checks), 'failed': 0}), flush=True)
except Exception as error:
    checks.append({'check': 'Focused suite completed', 'pass': False, 'error': str(error)}); save(); raise
finally:
    save()
    print(json.dumps({'browserClosed': ab('close').get('closed')}), flush=True)
