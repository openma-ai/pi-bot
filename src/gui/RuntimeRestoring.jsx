import {PiboBrand} from './PiboBrand.jsx';
import React from 'react';
import {Theme,Button,Heading,Text,Flex}from'@radix-ui/themes';
import {LoaderCircle,WifiOff}from'lucide-react';
/** Last workspace view, without pretending a cached credential is an online endpoint. */
export function RuntimeRestoring({runtime,onSettings}){
 const last=runtime.displayRuntime;
 return <Theme appearance="dark" accentColor="amber" grayColor="sand" radius="large"><main className="runtime-restoring"><header><strong><PiboBrand/> · {last.name}</strong><Button variant="ghost" color="gray" onClick={onSettings}>连接管理</Button></header><section aria-label="恢复工作空间"><Heading size="5">{last.name}</Heading>{runtime.restoring?<LoaderCircle className="landing-spinner" size={26} aria-hidden="true"/>:<WifiOff size={26} aria-hidden="true"/>}<Text as="p" role="status">{runtime.restoring?"正在恢复上次连接…":runtime.error?"工作空间暂时离线":"正在读取连接并加载会话…"}</Text><Text as="p" size="2" color="gray">{runtime.error||"连接成功后加载此工作空间的 bot 和消息。"}</Text><Flex gap="3" mt="4"><Button variant="soft" onClick={onSettings}>修改或切换连接</Button><Button variant="ghost" color="gray" onClick={()=>void runtime.cancelConnect()}>断开并停止自动连接</Button></Flex></section></main></Theme>;
}
