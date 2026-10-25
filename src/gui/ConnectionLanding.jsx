import React, { useState, useRef, useEffect } from 'react';
import { Theme, Heading, Text, Button, Flex, Card, Badge } from '@radix-ui/themes';
import { Laptop, Cloud, ArrowRight, ArrowLeft, Network, Check, LoaderCircle } from 'lucide-react';
import { TailnetConnect } from './TailnetConnect.jsx';
import { RuntimeEditor } from './SettingsPage.jsx';
import { connectionIssue, usableProfiles } from './connection-flow.js';
export function ConnectionLanding({ runtime, onSettings }) {
    const profiles = usableProfiles(runtime.status.profiles || []);
    const phone = !!runtime.status.remoteOnly;
    const [step, setStep] = useState('choose'), [kind, setKind] = useState(phone ? 'remote' : 'local'), [candidate, setCandidate] = useState(null), [failure, setFailure] = useState('');
    const attempt = useRef(0), heading = useRef();
    const [last] = useState(() => {
        try {
            return localStorage.getItem('pibo.lastConnection') || '';
        }
        catch {
            return '';
        }
    });
    useEffect(() => {
        if (phone && kind === "local")
            setKind(runtime.status.embeddedTailscaleAvailable ? "tailnet" : "remote");
    }, [phone, kind, runtime.status.embeddedTailscaleAvailable]);
    useEffect(() => {
        heading.current?.focus();
    }, [step]);
    useEffect(() => () => {
        attempt.current++;
    }, []);
    const choices = [...(!phone ? [{
                id: 'local', name: '这台 Mac', description: '使用本机已启动的 Pibo 工作空间', icon: Laptop
            }] : []), {
            id: 'remote', name: '服务地址直连', description: '输入 HTTPS 地址，登录后连接 Pibo 与桌面', icon: Cloud
        }, ...(runtime.status.embeddedTailscaleAvailable ? [{
                id: 'tailnet', name: '通过 Tailscale', description: '登录网络、选择电脑，登录后直接使用 Pibo', icon: Network
            }] : [])];
    async function connect(profile) {
        const version = ++attempt.current;
        setCandidate(profile);
        setFailure('');
        setStep('connecting');
        try {
            await runtime.connect(profile);
            if (version !== attempt.current)
                return;

        }
        catch (e) {
            if (version !== attempt.current)
                return;
            setFailure(String(e.message || e));
            setStep('error');
        }
    }
    async function save(profile) { await runtime.configure(profile); await connect(profile); }
    function create() {
        if (kind === 'tailnet') { setCandidate({id:crypto.randomUUID(),mode:'tailnet'});setStep('configure');return; }
        setCandidate({id:crypto.randomUUID(),name:kind==='local'?'本机工作空间':'Pibo 服务',mode:kind==='local'?'local':'direct',dataDir:''});
        setStep('configure');
    }
    const issue = connectionIssue(failure, candidate, runtime.status.tailscaleNodeState);
    return <Theme appearance="dark" accentColor="amber" grayColor="sand" radius="large"><main className="connection-landing"><div className="landing-top"><span className="landing-brand">Pibo</span><Button variant="ghost" color="gray" onClick={onSettings}>连接管理</Button></div><section className="landing-panel" aria-label="连接工作空间">
 <div className="landing-step" aria-label="连接步骤"><span data-current={step === 'choose'}>1 选择位置</span><span data-current={step === 'configure'}>2 连接信息</span><span data-current={['connecting', 'error'].includes(step)}>3 连接</span></div>
 <Heading ref={heading} tabIndex={-1} className="landing-heading" size="6">{step === 'choose' ? '从你的工作空间开始' : step === 'configure' ? '连接信息' : step === 'connecting' ? '正在连接工作空间…' : issue.title}</Heading>
 {step === 'choose' && <>{runtime.restoring&&<div role="status" className="landing-loading">正在恢复上次连接…<Button variant="soft" onClick={()=>void runtime.cancelConnect()}>取消恢复</Button></div>}{runtime.error&&<Text as="p" role="alert" color="amber">{runtime.error}</Text>}<Text as="p" color="gray" size="2">任务和文件保留在运行 Pibo 服务的电脑上。先连接，再开始会话。</Text>{runtime.status.profiles === null ? <div role="status" className="landing-loading">正在读取连接…{runtime.error && <><Text role="alert">{runtime.error}</Text><Button onClick={() => void runtime.refresh().catch(() => {
            })}>重新读取</Button></>}</div> : <>
 {(runtime.status.profiles||[]).some(p=>p.mode==='ssh')&&<Text as="p" color="amber">旧 SSH 连接已停用并保留。请新建 Tailscale 或 HTTPS 连接并使用服务访问密码登录；地址和凭据不会自动迁移。</Text>}{profiles.length > 0 && <div className="landing-returning"><Text as="p" size="2" weight="medium">继续使用</Text>{[...profiles].sort((a, b) => Number(b.id === last) - Number(a.id === last)).map(p => <Card key={p.id} className="landing-saved"><Flex justify="between" align="center" gap="3"><div><Text as="p" weight="medium">{p.name}</Text><Text size="1" color="gray">{p.mode === 'local' ? '这台 Mac' : p.embeddedTailscale ? '私有网络 · Tailscale' : '远程电脑'}</Text></div><Flex gap="2"><Button variant="ghost" onClick={() => {
                setCandidate(p);
                setKind(p.mode==='tailnet'?'tailnet':p.mode==='local'?'local':'remote');setStep('configure');
            }}>修改</Button><Button onClick={() => void connect(p)}>继续连接</Button></Flex></Flex></Card>)}</div>}
 <fieldset className="landing-choices"><legend>{profiles.length ? '添加其他连接' : '工作空间在哪里？'}</legend>{choices.map(({ id, name, description, icon: Icon }) => <label key={id} className="landing-choice" data-selected={kind === id}><input type="radio" name="connection-kind" value={id} checked={kind === id} onChange={() => setKind(id)}/><Icon size={21} aria-hidden="true"/><span><strong>{name}</strong><small>{description}</small></span>{kind === id && <Check size={16} className="choice-check"/>}</label>)}</fieldset>
 {kind === 'tailnet' && <Text as="p" color="gray" size="1">需要分别授权此应用，并让远程电脑登录同一网络。外层连接仍受当前 VPN 路由影响。</Text>}
 <Flex justify="end" mt="5"><Button onClick={create}>继续<ArrowRight size={16}/></Button></Flex></>}</>}
 {step === 'configure' && candidate?.mode === 'tailnet' && <TailnetConnect profile={candidate} onSave={save} onCancel={()=>setStep('choose')} />}
 {step === 'configure' && candidate?.mode !== 'tailnet' && <RuntimeEditor key={candidate.id} profile={candidate} knownProfile={profiles.some(p => p.id === candidate.id)} onboarding onSave={save} onCancel={() => setStep('choose')} remoteOnly={phone} sessionOnly={runtime.status.credentialStorage === 'session'} tailscaleAvailable={runtime.status.embeddedTailscaleAvailable} tailState={runtime.status.tailscaleNodeState}/>}
 {step === 'connecting' && <div className="landing-connecting" role="status"><LoaderCircle size={30} className="landing-spinner"/><Text as="p">{candidate?.embeddedTailscale ? '正在连接私有网络、验证远程电脑并查找服务。' : '正在验证连接并查找运行中的服务。'}</Text><Text as="p" size="2" color="gray">{candidate?.name} · 不会启动或重启远程服务</Text><Button variant="soft" color="gray" onClick={() => {
        attempt.current++;
        void runtime.cancelConnect().catch(() => {
        });
        setStep('choose');
    }}>取消连接</Button></div>}
 {step === 'error' && <div className="landing-error"><Text as="p">{issue.detail}</Text>{candidate?.embeddedTailscale && <div className="landing-network-status"><Badge color={['prepared', 'dialed'].includes(runtime.status.tailscaleNodeState) ? 'green' : 'amber'}>应用节点：{['prepared', 'dialed'].includes(runtime.status.tailscaleNodeState) ? '已准备' : '待授权'}</Badge><Text as="p" size="1" color="gray">远程电脑网络登录状态：尚未检测，不代表已登录。</Text></div>}<details><summary>查看连接详情</summary><pre>{failure}</pre></details><Flex gap="3" wrap="wrap" mt="5"><Button onClick={() => void connect(candidate)}>重试连接</Button><Button variant="soft" onClick={() => setStep('configure')}>修改连接信息</Button><Button variant="ghost" color="gray" onClick={() => setStep('choose')}><ArrowLeft size={15}/>重新选择</Button></Flex></div>}
 <Text as="p" size="1" color="gray" className="landing-footnote">已有配置和会话会保留。模型与服务账号可在连接后设置。</Text>
 </section></main></Theme>;
}
