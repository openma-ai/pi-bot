import React, { useEffect, useRef, useState } from 'react';
import { Button, Flex, Text, TextField, Badge, Card } from '@radix-ui/themes';
const control = (method, params = {}) => window.__PIBOT_NATIVE__.call('runtime_control', {
    method: 'tailscale/' + method, params
});
/** Discovery is local SDK peer metadata; a service must still identify and pair. */
export function TailnetConnect({ profile, onSave, onCancel }) {
    const [status, setStatus] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [host, setHost] = useState(profile?.host || ''), [port, setPort] = useState(String(profile?.serverPort || 4319)), [service, setService] = useState(null), [code, setCode] = useState('');
    const alive = useRef(true), generation = useRef(0), wantLogin = useRef(false), opened = useRef(''), inFlight = useRef(false);
    useEffect(() => {
        alive.current = true;
        let pending = false;
        const poll = async () => {
            if (pending)
                return;
            pending = true;
            try {
                const version = generation.current;
                const next = await control('status');
                if (alive.current && version === generation.current) {
                    setStatus(next);
                    if (next.backendState === 'Running')
                        wantLogin.current = false;
                    else if (wantLogin.current && next.authURL && opened.current !== next.authURL) {
                        opened.current = next.authURL;
                        await control('openLogin');
                    }
                }
            }
            catch (e) {
                if (alive.current)
                    setError(String(e));
            }
            finally {
                pending = false;
            }
        };
        void poll();
        const timer = setInterval(poll, 2000);
        return () => {
            alive.current = false;
            generation.current++;
            clearInterval(timer);
        };
    }, []);
    async function action(fn) {
        if (inFlight.current)
            return;
        inFlight.current = true;
        const version = generation.current;
        setBusy(true);
        setError('');
        try {
            await fn();
        }
        catch (e) {
            if (alive.current && version === generation.current)
                setError(String(e.message || e));
        }
        finally {
            inFlight.current = false;
            if (alive.current)
                setBusy(false);
        }
    }
    const running = status?.backendState === 'Running';
    function choose(ip) {
        generation.current++;
        setHost(ip);
        setService(null);
        setCode('');
        setError('');
    }
    const params = {
        host, port: Number(port)
    };
    async function connect() {
        await onSave({
            id: profile?.id || crypto.randomUUID(), name: service?.name || profile?.name || host, mode: 'tailnet', embeddedTailscale: true, host, serverPort: Number(port), dataDir: ''
        });
    }
    return <div className="tailnet-connect"><Text as="p" color="gray" size="2">登录一次，选择电脑，再配对 Pibo 工作空间。无需 SSH 用户名或密钥。</Text>
 {!running ? <Card><Text as="p" weight="medium">{status?.backendState === 'NeedsMachineAuth' ? '等待网络管理员批准设备' : '登录应用内网络'}</Text><Text as="p" size="2" color="gray">网络身份将仅保存在这台设备的安全存储中。不会启用系统 VPN。</Text><Flex gap="2" mt="3" wrap="wrap"><Button disabled={busy} onClick={() => void action(async () => {
            wantLogin.current = true;
            opened.current = '';
            await control('browserStart');
            setStatus(await control('status'));
        })}>登录 / 恢复连接</Button>{status?.authURL && <Button disabled={busy} onClick={() => void action(() => control('openLogin'))}>打开授权页面</Button>}<Button variant="soft" disabled={busy} onClick={() => void action(async () => {
            generation.current++;
            wantLogin.current = false;
            await control('stop');
            setStatus(await control('status'));
        })}>取消连接</Button></Flex></Card> : <>
 <Flex align="center" justify="between" my="3"><Badge color="green">网络已连接</Badge><Button variant="ghost" disabled={busy} onClick={() => void action(async () => {
            await control('logout');
            setStatus(await control('status'));
            setService(null);
        })}>退出网络并清除本机节点身份</Button></Flex>
 <Text as="p" weight="medium">选择运行 Pibo 的电脑</Text><Text as="p" color="gray" size="1">在线只代表网络在线，下一步会检查 Pibo 服务。</Text><Flex direction="column" gap="2" my="3">{(status.peers || []).map(p => <Button key={p.ip} variant={host === p.ip ? 'solid' : 'soft'} disabled={busy || !p.online} onClick={() => choose(p.ip)} style={{
            justifyContent: 'space-between', height: 'auto', padding: '12px'
        }}><span>{p.name} · {p.ip}</span><span>{p.online ? '在线' : '离线'}</span></Button>)}{!status.peers?.length && <Text color="gray" size="2">暂时没有设备。确认目标电脑已加入同一网络，或填写它的 Tailscale IPv4。</Text>}</Flex>
 <label>Tailscale IPv4<TextField.Root value={host} disabled={busy} onChange={e => choose(e.target.value)} placeholder="100.x.x.x"/></label><label>Pibo 服务端口<TextField.Root inputMode="numeric" value={port} disabled={busy} onChange={e => {
            generation.current++;
            setPort(e.target.value);
            setService(null);
        }}/></label>
 <Button mt="3" disabled={busy || !host || !(Number(port) > 0 && Number(port) <= 65535)} onClick={() => void action(async () => {
            const version = generation.current;
            const found = await control('probe', params);
            if (alive.current && version === generation.current)
                setService(found);
        })}>检查 Pibo 服务</Button>
 {service && <Card mt="3"><Text as="p" weight="medium">{service.name}</Text><Text as="p" size="2" color="gray">首次配对：在电脑上运行 tailnet-pair，将短时一次性配对码填入这里。配对后此设备可访问整个工作空间；电脑端可随时撤销。</Text><TextField.Root type="password" autoComplete="off" value={code} onChange={e => setCode(e.target.value)} placeholder="一次性配对码"/><Flex gap="2" mt="3" wrap="wrap"><Button disabled={busy || code.length !== 24} onClick={() => void action(async () => {
            await control('pair', {
                ...params, code
            });
            setCode('');
            await connect();
        })}>配对并进入</Button><Button variant="soft" disabled={busy} onClick={() => void action(connect)}>已配对，直接进入</Button><Button variant="ghost" disabled={busy} onClick={() => void action(() => control('forgetDevice', params))}>清除本机配对</Button></Flex></Card>}
 </>}
 {error && <Text as="p" role="alert" color="red" mt="3">{error}</Text>}<Button mt="4" variant="ghost" disabled={busy} onClick={() => {
        generation.current++;
        wantLogin.current = false;
        void control('closeLogin');
        onCancel();
    }}>返回选择连接方式</Button></div>;
}
