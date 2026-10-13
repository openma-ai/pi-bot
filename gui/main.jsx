import {Tabs} from '@radix-ui/themes';
import {DesktopPanel} from './DesktopPanel.jsx';
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme, Avatar, Button, TextField, TextArea, Heading, Text, Badge, Dialog, Flex, Callout, Select, Checkbox } from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import './style.css';
const colors = ['#d89614', '#13a8a8', '#9254de', '#1677ff'];
const labels = {
    queued: '待处理', processing: '处理中', processed: '已处理', uncertain: '待核查', failed: '失败', delivered: '已送达', active: '运行中', paused: '已暂停', completed: '已完成', cancelled: '已取消', expired: '已到期', received: '已发送'
};
const time = n => new Date(n).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai'
});
function displayText(m) {
    if (['schedule', 'monitor'].includes(m.sourceKind)) {
        try {
            const e = JSON.parse(m.text);
            return (m.sourceKind === 'schedule' ? '定时任务已触发：' : '监控发现变化：') + (e.prompt || e.observation || '');
        }
        catch {
        }
    }
    return m.text;
}
function Picker({ value, onChange, items, label }) {
    return <Select.Root value={value || undefined} onValueChange={onChange}><Select.Trigger aria-label={label} placeholder={label}/><Select.Content>{items.map(i => <Select.Item key={i.id} value={i.id}>{i.name}</Select.Item>)}</Select.Content></Select.Root>;
}
function App() {
    const [data, setData] = useState({
        bots: [], groups: [], messages: [], states: {}
    }), [view, setView] = useState('chat'), [selected, setSelected] = useState(''), [groupId, setGroupId] = useState(''), [groupTarget, setGroupTarget] = useState('');
    const [draft, setDraft] = useState(''), [search, setSearch] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const [adding, setAdding] = useState(false), [name, setName] = useState(''), [newGroup, setNewGroup] = useState(false), [members, setMembers] = useState([]), [details, setDetails] = useState(false);
    const [peerA, setPeerA] = useState(''), [peerB, setPeerB] = useState(''), [peerScope, setPeerScope] = useState('direct');
    const [routineKind, setRoutineKind] = useState(''), [prompt, setPrompt] = useState(''), [when, setWhen] = useState(''), [interval, setIntervalMinutes] = useState(''), [watchPath, setWatchPath] = useState(''), [routineGroup, setRoutineGroup] = useState('direct');
    const [result, setResult] = useState(''), [answer, setAnswer] = useState(''), [mentionIndex, setMentionIndex] = useState(0), [hideMentions, setHideMentions] = useState(false);
    const end = useRef(null), composer = useRef(null);
    async function refresh() {
        try {
            const r = await fetch('/api/state');
            if (!r.ok)
                throw Error('连接失败');
            const d = await r.json();
            setData(d);
            setSelected(s => s || d.bots[0]?.id);
            setPeerA(s => s || d.bots[0]?.id);
            setPeerB(s => s || d.bots[1]?.id);
            setError('');
        }
        catch (e) {
            setError(e.message);
        }
    }
    useEffect(() => {
        refresh();
        const t = setInterval(refresh, 1000);
        return () => clearInterval(t);
    }, []);
    const bot = data.bots.find(b => b.id === selected), group = data.groups.find(g => g.id === groupId), state = data.states[selected];
    const botName = id => data.bots.find(b => b.id === id)?.name || id;
    const groupBots = data.bots.filter(b => group?.memberIds.includes(b.id));
    const scopeMatches = m => peerScope === 'direct' ? m.channelId.startsWith('local:') : m.channelId === peerScope;
    const peerMessages = data.messages.filter(m => m.sourceKind === 'bot' && m.direction === 'inbound' && scopeMatches(m) && ((m.sender === peerA && m.recipient === peerB) || (m.sender === peerB && m.recipient === peerA)));
    const peerTasks = new Set(peerMessages.map(m => m.taskId));
    const shared = (data.groupMessages || []).filter(m => m.channelId === groupId && (m.direction !== 'outbound' || m.status === 'delivered'));
    const sharedIds = new Set(shared.map(m => m.messageId));
    const legacy = data.messages.filter(m => m.channelId === groupId && m.sourceKind !== 'job' && !m.groupMessageId && !sharedIds.has(m.messageId) && !(m.direction === 'inbound' && m.sourceKind === 'bot'));
    const groupMessages = [...shared, ...legacy].sort((a, b) => a.receivedAt - b.receivedAt);
    const messages = view === 'group' ? groupMessages : view === 'peers' ? data.messages.filter(m => peerMessages.includes(m) || (peerTasks.has(m.taskId) && m.direction === 'outbound') || (m.sourceKind === 'user' && m.recipient === peerA && m.text.startsWith('协作任务：') && m.text.includes(peerB) && scopeMatches(m))) : data.messages.filter(m => m.botId === selected && m.channelId === (bot?.channelId || `local:${selected}`) && m.sourceKind !== 'job' && !(m.direction === 'inbound' && m.sourceKind === 'bot'));
    const mentionMatch = view === 'group' && !hideMentions ? draft.match(/(?:^|\s)@([^\s]*)$/) : null;
    const mentionOptions = mentionMatch ? [...groupBots.map(b => b.name), '全体成员'].filter(name => name.includes(mentionMatch[1])) : [];
    function chooseMention(name) {
        setDraft(s => s.replace(/(^|\s)@[^\s]*$/, (_match, space) => space + '@' + name + ' '));
        setMentionIndex(0);
        setHideMentions(false);
        requestAnimationFrame(() => composer.current?.focus());
    }
    const scrollKey = messages.map(m => m.direction + m.messageId).join('|');
    useEffect(() => {
        end.current?.scrollIntoView({
            behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
        });
    }, [view, selected, groupId, peerA, peerB, peerScope, scrollKey]);
    async function post(path, body) {
        const r = await fetch('/api/' + path, {
            method: 'POST', headers: {
                'Content-Type': 'application/json', 'X-Gui-Token': data.token
            }, body: JSON.stringify(body)
        });
        const v = await r.json();
        if (!r.ok)
            throw Error(v.error);
        await refresh();
        return v;
    }
    async function send() {
        if (!draft.trim() || busy)
            return;
        setBusy(true);
        setNotice('');
        try {
            const to = view === 'group' ? groupBots[0]?.id : view === 'peers' ? peerA : selected;
            if (!to || view === 'peers' && (!peerB || peerA === peerB))
                throw Error('请选择不同的 bot');
            const text = view === 'peers' ? `协作任务：${draft}\n请使用 send_to_bot 将任务交给 ${botName(peerB)}（${peerB}）。对方完成后使用 send_to_bot 将结果返回给你（${peerA}）；你核验后使用 send_message 给用户最终结果。你负责最终回复。不要互相发确认或闲聊，不要创建额外任务。` : draft;
            await post('message', {
                to, text, key: crypto.randomUUID(), groupId: view === 'group' ? groupId : view === 'peers' && peerScope !== 'direct' ? peerScope : undefined
            });
            setDraft('');
        }
        catch (e) {
            setNotice(e.message);
        }
        finally {
            setBusy(false);
        }
    }
    const action = async (kind, r, act) => {
        try {
            const v = await post('routine/action', {
                botId: r.botId, kind, id: r.id, action: act
            });
            if (act === 'dry-run')
                setNotice(v.decision === 'error' ? '试运行失败：' + v.error : '试运行通过：' + v.decision);
        }
        catch (e) {
            setNotice(e.message);
        }
    };
    function openRoutine(kind) {
        setNotice('');
        setRoutineKind(kind);
        setRoutineGroup(view === 'group' ? groupId : 'direct');
    }
    function routineCard(kind, r) {
        return <div className="routine" key={r.id}><Flex gap="2" align="center" wrap="wrap"><Text weight="medium">{botName(r.botId)}</Text><Badge color={r.state === 'active' ? 'green' : 'gray'}>{labels[r.state] || r.state}</Badge>{r.dryRunVerified && <Badge color="green">试运行通过</Badge>}</Flex><Text size="2">{r.prompt}</Text><Text size="1" color="gray">{kind === 'schedule' ? `执行时间：${time(r.nextFire)} · ${r.intervalMs ? `每 ${r.intervalMs / 60000} 分钟` : '仅一次'}` : `${r.detector === 'file' ? data.watchFile : r.detector.replace(/^file:/, '')} · 每 ${r.intervalMs / 1000} 秒 · 截止 ${time(r.deadline)}`}</Text>{kind === 'monitor' && <Text size="1" color="gray">{r.enabled ? '已启用' : '未启用'} · 最近检查：{r.lastDecision || '尚未检查'}</Text>}<Flex gap="3" wrap="wrap">{kind === 'schedule' && r.state === 'active' && <Button size="1" variant="soft" onClick={() => action(kind, r, 'pause')}>暂停</Button>}{kind === 'schedule' && r.state === 'paused' && <Button size="1" variant="soft" onClick={() => action(kind, r, 'resume')}>恢复</Button>}{kind === 'monitor' && r.state === 'active' && <><Button size="1" variant="soft" onClick={() => action(kind, r, 'dry-run')}>试运行</Button><Button size="1" variant="soft" onClick={() => action(kind, r, r.enabled ? 'pause' : 'enable')}>{r.enabled ? '暂停' : '启用'}</Button></>}{['active', 'paused'].includes(r.state) && <Button variant="soft" size="1" color="red" onClick={() => action(kind, r, 'cancel')}>取消</Button>}</Flex>{r.error && <Text size="1" color="red">{r.error}</Text>}</div>;
    }
    const routineRows = Object.values(data.states).flatMap(s => view === 'schedules' ? s.proactive?.schedules || [] : s.proactive?.monitors || []);
    const routineView = ['schedules', 'monitors'].includes(view), kind = view === 'schedules' ? 'schedule' : 'monitor';
    const title = routineView ? (view === 'schedules' ? '定时任务' : '监控') : view === 'peers' ? 'Bot 对话' : view === 'group' ? group?.name : bot?.name;
    const inspector = <><Heading size="4">{bot?.name}</Heading><Text color="gray" size="2">{bot?.description || '个人 bot'}</Text><Flex gap="2" mt="4"><Button size="1" variant="soft" onClick={() => {
        setDetails(false);
        setView('schedules');
    }}>定时任务</Button><Button size="1" variant="soft" onClick={() => {
        setDetails(false);
        setView('monitors');
    }}>监控</Button></Flex><Heading size="2" mt="6" mb="3">运行状态</Heading><Text size="2" color="gray">待处理 {state?.counts?.inbox ?? 0} · 本轮请求 {data.budget?.requests ?? 0}/{data.budget?.maxRequests ?? 32}</Text><Text as="div" size="1" color="gray">累计输出 {data.usage?.output ?? 0} token · 费用估算 ${Number(data.usage?.estimatedUsd ?? 0).toFixed(4)}</Text><Heading size="2" mt="5" mb="3">工具任务</Heading>{(data.jobs || []).filter(j => j.botId === selected).map(j => <div className="routine" key={j.id}><Text size="2">{j.tool} · {labels[j.state] || j.state}</Text><Button size="1" variant="ghost" onClick={async () => {
        try {
            const v = await post('job', {
                botId: selected, id: j.id
            });
            setResult(JSON.stringify(v, null, 2));
        }
        catch (e) {
            setNotice(e.message);
        }
    }}>查看结果</Button></div>)}{(state?.questions || []).map(q => <div className="routine" key={q.id}><Text>{q.text || q.question}</Text><TextField.Root placeholder="回答" value={answer} onChange={e => setAnswer(e.target.value)}/><Button size="1" onClick={() => post('answer', {
        id: q.id, text: answer
    }).then(() => setAnswer('')).catch(e => setNotice(e.message))}>提交回答</Button></div>)}</>;
    return <Theme appearance="dark" accentColor="amber" grayColor="sand" radius="large"><div className="app">
 <aside className="sidebar"><div className="brand"><Heading size="5">Pi Bot</Heading><Button variant="soft" aria-label="新建 bot" onClick={() => setAdding(true)}>＋</Button></div>
 <nav className="sections" aria-label="工作区"><Button variant={view === 'schedules' ? 'solid' : 'ghost'} color="gray" onClick={() => setView('schedules')}>定时任务</Button><Button variant={view === 'monitors' ? 'solid' : 'ghost'} color="gray" onClick={() => setView('monitors')}>监控</Button><Button variant={view === 'peers' ? 'solid' : 'ghost'} color="gray" onClick={() => setView('peers')}>Bot 对话</Button></nav>
 <TextField.Root placeholder="搜索 bot 或群" value={search} onChange={e => setSearch(e.target.value)}/><nav className="bots" aria-label="Bot 列表">{data.bots.filter(b => b.name.toLowerCase().includes(search.toLowerCase())).map((b, i) => <button key={b.id} className={'bot ' + (selected === b.id && view === 'chat' ? 'selected' : '')} onClick={() => {
        setSelected(b.id);
        setView('chat');
    }}><Avatar fallback={b.name.slice(0, 1)} radius="full" style={{
        background: colors[i % 4], color: 'white'
    }}/><div className="bot-label"><Text as="div" size="2" weight="medium">{b.name}</Text><Text as="div" size="1" color="gray" className="preview">{data.messages.filter(m => m.botId === b.id).at(-1)?.text || '开始聊天'}</Text></div></button>)}</nav>
 <Flex justify="between" align="center" mt="4" mb="2"><Text size="1" color="gray">群聊</Text><Button size="1" variant="ghost" onClick={() => {
        setName('');
        setMembers([]);
        setNewGroup(true);
    }}>新建群聊</Button></Flex><nav aria-label="群聊列表">{data.groups.filter(g => g.name.includes(search)).map(g => <button className={'bot ' + (view === 'group' && g.id === groupId ? 'selected' : '')} key={g.id} onClick={() => {
        setGroupId(g.id);
        setGroupTarget(g.memberIds[0]);
        setSelected(g.memberIds[0]);
        setView('group');
    }}><Avatar fallback="群" radius="full" color="gray"/><div><Text size="2" as="div">{g.name}</Text><Text size="1" color="gray">{g.memberIds.length} 个 bot</Text></div></button>)}</nav>
 <div className="mode"><Badge color="gray">{data.mode || '连接中'}</Badge><Text size="1" color="gray">{error || data.configuration?.message || '本地工作区'}</Text></div></aside>
 <main className="main"><header className="header"><Heading size="4">{title || 'Pi Bot'}</Heading>{routineView ? <Button onClick={() => openRoutine(kind)}>新建{kind === 'schedule' ? '定时任务' : '监控'}</Button> : <Button variant="ghost" color="gray" onClick={() => setDetails(true)}>详情</Button>}</header>
 {data.configuration?.setupRequired && <Callout.Root color="amber" m="3"><Callout.Text>{data.configuration.message}</Callout.Text></Callout.Root>}
 {data.trigger?.halted && <Callout.Root color="red" m="3"><Callout.Text>触发投递需要核查，已停止自动处理。</Callout.Text></Callout.Root>}{data.errors?.length > 0 && <Callout.Root color="red" m="3"><Callout.Text>{data.errors.at(-1)}</Callout.Text></Callout.Root>}{notice && <Callout.Root m="3"><Callout.Text>{notice}</Callout.Text><Button variant="ghost" onClick={() => setNotice('')}>关闭</Button></Callout.Root>}
 {routineView ? <section className="routine-page"><Text size="2" color="gray">{kind === 'schedule' ? '所有 bot 的定时任务，时间按上海时区显示。' : '所有 bot 的文件变化监控，先试运行再启用。'}</Text><div className="routine-list">{routineRows.length ? routineRows.map(r => routineCard(kind, r)) : <div className="empty"><Heading size="4">暂无{kind === 'schedule' ? '定时任务' : '监控'}</Heading><Button onClick={() => openRoutine(kind)}>创建第一个{kind === 'schedule' ? '定时任务' : '监控'}</Button></div>}</div></section> : <>
 {view === 'group' && <div className="view-toolbar group-toolbar"><Text size="2" color="gray">{groupBots.map(b => b.name).join('、')}</Text>{data.messages.some(m => m.channelId === groupId && m.sourceKind === 'bot' && m.direction === 'inbound' && m.deliveryTarget === 'direct') && <Button variant="ghost" color="gray" size="1" onClick={() => {
            const m = data.messages.find(m => m.channelId === groupId && m.sourceKind === 'bot' && m.direction === 'inbound' && m.deliveryTarget === 'direct');
            setPeerA(m.sender);
            setPeerB(m.recipient);
            setPeerScope(groupId);
            setView('peers');
        }}>bot 间对话</Button>}</div>}
 {view === 'peers' && <div className="view-toolbar"><Flex gap="2" align="center" wrap="wrap"><Picker label="发起 bot" value={peerA} onChange={setPeerA} items={data.bots}/><Text>⇄</Text><Picker label="协作 bot" value={peerB} onChange={setPeerB} items={data.bots}/><Picker label="对话范围" value={peerScope} onChange={setPeerScope} items={[{
                id: 'direct', name: '直接协作'
            }, ...data.groups]}/></Flex><Text size="1" color="gray">查看两个 bot 的实际协作记录，也可发起新任务。</Text></div>}
 <section className="conversation" aria-label="聊天消息">{messages.length ? messages.map(m => <div key={m.direction + m.messageId} className={'row ' + (m.direction === 'inbound' && m.sourceKind === 'user' ? 'user' : '')}><div className="bubble" style={m.sourceKind === 'user' ? {
            background: colors[0]
        } : undefined}><div className="bubble-meta">{m.sourceKind === 'user' ? '你' : m.direction === 'outbound' ? botName(m.sender) : m.sourceKind === 'bot' ? `${botName(m.sender)}${m.recipient === 'group' ? ' · 群消息' : ' → ' + botName(m.recipient)}` : m.sourceKind === 'schedule' ? '定时任务' : '监控'} · {new Date(m.receivedAt).toLocaleTimeString('zh-CN', {
            timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit'
        })}</div><div>{displayText(m)}</div><Text size="1" className="status">{labels[m.status] || m.status}</Text>{m.status === 'uncertain' && m.sourceKind === 'user' && <Button size="1" variant="soft" onClick={() => post('reconcile', {
            id: m.messageId
        }).catch(e => setNotice(e.message))}>核查并恢复</Button>}</div></div>) : <div className="empty"><Heading size="5">{view === 'peers' ? '暂无 bot 对话' : '准备开始'}</Heading><Text color="gray" size="2">{view === 'peers' ? '选择两个 bot，发起一项真实协作任务。' : '发一条消息，开始处理任务。'}</Text></div>}<div ref={end}/></section>
 <div className="composer-area">{mentionOptions.length > 0 && <div className="mention-menu" role="listbox" aria-label="选择 @ 成员">{mentionOptions.map((name, i) => <button key={name} className={i === mentionIndex ? 'active' : ''} onClick={() => chooseMention(name)}>{name === '全体成员' ? '@全体成员' : '@' + name}</button>)}</div>}<div className="composer"><TextArea ref={composer} aria-label="消息" placeholder={view === 'peers' ? '交给这两个 bot 的协作任务…' : view === 'group' ? `发到 ${group?.name}…` : `给 ${bot?.name || 'bot'} 发消息…`} value={draft} onChange={e => {
            setDraft(e.target.value);
            setMentionIndex(0);
            setHideMentions(false);
        }} rows={2} onKeyDown={e => {
            if (mentionOptions.length) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMentionIndex(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + mentionOptions.length) % mentionOptions.length);
                    return;
                }
                if (e.key === 'Escape') {
                    setHideMentions(true);
                    return;
                }
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    chooseMention(mentionOptions[mentionIndex]);
                    return;
                }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
            }
        }}/><Button disabled={busy || !draft.trim() || !!error || data.configuration?.setupRequired} onClick={send}>{busy ? '发送中' : view === 'peers' ? '发起协作' : '发送'}</Button></div></div></>}
 </main>{!routineView && view === 'chat' && <aside className="inspector">{inspector}</aside>}
 <Dialog.Root open={!!routineKind} onOpenChange={v => {
        if (!v)
            setRoutineKind('');
    }}><Dialog.Content maxWidth="440px"><Dialog.Title>{routineKind === 'schedule' ? '新建定时任务' : '新建监控'}</Dialog.Title><Dialog.Description size="2" mb="4">{routineKind === 'schedule' ? '选择负责 bot、任务和执行时间。' : '监控仓库内的文件变化；试运行通过后启用。'}</Dialog.Description><Flex direction="column" gap="3">{notice && <Text size="2" color="red">{notice}</Text>}<Picker label="负责 bot" value={selected} onChange={v => {
        setSelected(v);
        setRoutineGroup('direct');
    }} items={data.bots}/><Picker label="回复到" value={routineGroup} onChange={setRoutineGroup} items={[{
            id: 'direct', name: '回复到 bot 私聊'
        }, ...data.groups.filter(g => g.memberIds.includes(selected))]}/><TextArea aria-label="任务内容" placeholder="任务内容" value={prompt} onChange={e => setPrompt(e.target.value)}/><Flex gap="2"><Button size="1" variant="soft" onClick={() => setWhen(new Date(Date.now() + 120000).toLocaleString('sv-SE', {
        timeZone: 'Asia/Shanghai'
    }).replace(' ', 'T').slice(0, 16))}>2 分钟后</Button><Button size="1" variant="soft" onClick={() => setWhen(new Date(Date.now() + 3600000).toLocaleString('sv-SE', {
        timeZone: 'Asia/Shanghai'
    }).replace(' ', 'T').slice(0, 16))}>1 小时后</Button></Flex><label><Text size="2">{routineKind === 'schedule' ? '首次执行时间' : '监控截止时间'}（上海）</Text><TextField.Root aria-label="执行时间" type="datetime-local" value={when} onChange={e => setWhen(e.target.value)}/></label><label><Text size="2">{routineKind === 'schedule' ? '重复间隔（分钟，留空仅一次）' : '检查间隔（分钟）'}</Text><TextField.Root aria-label="间隔分钟" type="number" min="1" value={interval} onChange={e => setIntervalMinutes(e.target.value)}/></label>{routineKind === 'monitor' && <label><Text size="2">监控文件（仓库内路径）</Text><TextField.Root aria-label="监控文件" placeholder={data.watchFile} value={watchPath} onChange={e => setWatchPath(e.target.value)}/></label>}<Flex gap="3" justify="end"><Dialog.Close><Button variant="soft" color="gray">返回</Button></Dialog.Close><Button disabled={busy} onClick={async () => {
        setBusy(true);
        try {
            const at = Date.parse(when + ':00+08:00');
            if (!Number.isFinite(at))
                throw Error('请选择有效时间');
            await post('routine/create', {
                botId: selected, kind: routineKind, groupId: routineGroup === 'direct' ? undefined : routineGroup, filePath: watchPath || undefined, prompt, at, deadline: at, intervalMs: interval ? Number(interval) * 60000 : routineKind === 'monitor' ? 60000 : undefined, timezone: 'Asia/Shanghai'
            });
            setRoutineKind('');
            setPrompt('');
            setWhen('');
            setIntervalMinutes('');
            setWatchPath('');
            setNotice('');
        }
        catch (e) {
            setNotice(e.message);
        }
        finally {
            setBusy(false);
        }
    }}>创建</Button></Flex></Flex></Dialog.Content></Dialog.Root>
 <Dialog.Root open={newGroup} onOpenChange={setNewGroup}><Dialog.Content maxWidth="400px"><Dialog.Title>新建群聊</Dialog.Title><Dialog.Description size="2" mb="4">至少选择两个 bot；同一 bot 可加入多个群。群消息所有成员可见，输入 @ 点名或 @全体成员。</Dialog.Description><Flex direction="column" gap="3"><TextField.Root aria-label="群名称" placeholder="群名称" maxLength={60} value={name} onChange={e => setName(e.target.value)}/>{data.bots.map(b => <label key={b.id}><Flex gap="2" align="center"><Checkbox checked={members.includes(b.id)} onCheckedChange={checked => setMembers(s => checked ? [...s, b.id] : s.filter(id => id !== b.id))}/><Text size="2">{b.name}</Text></Flex></label>)}{notice && <Text color="red" size="2">{notice}</Text>}<Flex justify="end" gap="3"><Dialog.Close><Button variant="soft">返回</Button></Dialog.Close><Button disabled={busy || members.length < 2 || !name.trim()} onClick={async () => {
        setBusy(true);
        try {
            const g = await post('group', {
                name, memberIds: members
            });
            setGroupId(g.id);
            setGroupTarget(g.memberIds[0]);
            setSelected(g.memberIds[0]);
            setView('group');
            setNewGroup(false);
            setName('');
            setNotice('');
        }
        catch (e) {
            setNotice(e.message);
        }
        finally {
            setBusy(false);
        }
    }}>创建群聊</Button></Flex></Flex></Dialog.Content></Dialog.Root>
 <Dialog.Root open={!!result} onOpenChange={v => {
        if (!v)
            setResult('');
    }}><Dialog.Content><Dialog.Title>任务结果</Dialog.Title><Dialog.Description>持久工具结果，最多显示首 4096 字。</Dialog.Description><pre style={{
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'
    }}>{result}</pre><Dialog.Close><Button>关闭</Button></Dialog.Close></Dialog.Content></Dialog.Root>
 <Dialog.Root open={details} onOpenChange={setDetails}><Dialog.Content maxWidth="600px"><Dialog.Title>Bot 详情</Dialog.Title><Dialog.Description size="2" mb="4">任务结果和运行状态</Dialog.Description><Tabs.Root key={view+selected} defaultValue="details"><Tabs.List><Tabs.Trigger value="details">Details</Tabs.Trigger>{view === "chat" && <Tabs.Trigger value="computer">Computer</Tabs.Trigger>}</Tabs.List><Tabs.Content value="details">{inspector}</Tabs.Content>{view === "chat" && <Tabs.Content value="computer"><DesktopPanel botId={selected} name={bot?.name || "Bot"} enabled={data.desktop} api={(path,body)=>post(path.replace(/^\/api\//,""),body)}/></Tabs.Content>}</Tabs.Root><Flex justify="end" mt="5"><Dialog.Close><Button variant="soft">关闭</Button></Dialog.Close></Flex></Dialog.Content></Dialog.Root>
 <Dialog.Root open={adding} onOpenChange={setAdding}><Dialog.Content maxWidth="380px"><Dialog.Title>新建 bot</Dialog.Title><Dialog.Description size="2" mb="4">给助手取个名字。</Dialog.Description><TextField.Root aria-label="名称" placeholder="名称" maxLength={60} value={name} onChange={e => setName(e.target.value)}/><Flex gap="3" justify="end" mt="5"><Dialog.Close><Button variant="soft">取消</Button></Dialog.Close><Button onClick={async () => {
        try {
            const b = await post('bot', {
                name
            });
            setSelected(b.id);
            setView('chat');
            setName('');
            setAdding(false);
        }
        catch (e) {
            setNotice(e.message);
        }
    }}>创建</Button></Flex></Dialog.Content></Dialog.Root>
 </div></Theme>;
}
createRoot(document.getElementById('root')).render(<App />);
