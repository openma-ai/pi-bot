import React from 'react';
import {Badge,Flex,Text} from '@radix-ui/themes';

const labels={active:'运行中',paused:'已暂停',completed:'已完成',cancelled:'已取消',expired:'已到期'};
const time=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});

/** Agent-owned schedules and monitors are visible here, without client controls. */
export function RoutineStatus({kind,routine:r,watchFile}){
    return <div className="routine">
        <Flex gap="2" align="center" wrap="wrap">
            <Text weight="medium">{kind==='schedule'?'定时任务':'监控'}</Text>
            <Badge color={r.state==='active'?'green':'gray'}>{kind==='schedule'&&r.state==='completed'?'已触发':kind==='monitor'&&r.state==='active'&&!r.enabled?'未启用':labels[r.state]||r.state}</Badge>
            {r.dryRunVerified&&<Badge color="green">试运行通过</Badge>}
        </Flex>
        <Text size="2">{r.prompt}</Text>
        <Text size="1" color="gray">{kind==='schedule'?`执行时间：${time(r.nextFire)} · ${r.intervalMs?`每 ${r.intervalMs/60000} 分钟`:'仅一次'}`:`${r.detector==='file'?watchFile:String(r.detector||'文件变化').replace(/^file:/,'')} · 每 ${r.intervalMs/1000} 秒 · 截止 ${time(r.deadline)}`}</Text>
        {kind==='monitor'&&<Text size="1" color="gray">{r.enabled?'已启用':'未启用'} · 最近检查：{{silent:'无变化',wake:'发现变化',error:'检查失败'}[r.lastDecision]||'尚未检查'}</Text>}
        {r.error&&<Text size="1" color="red">{r.error}</Text>}
    </div>;
}

export function BotRoutineStatus({proactive,watchFile}){
    return <>{[['schedule','schedules','定时任务'],['monitor','monitors','监控']].map(([kind,key,label])=>{
        const rows=(proactive?.[key]||[]).filter(r=>['active','paused'].includes(r.state));
        return <section className="details-section" aria-label={label+'状态'} key={key}>
            <Text as="p" size="2" color="gray">{label}</Text>
            {rows.length?rows.map(r=><RoutineStatus key={r.id} kind={kind} routine={r} watchFile={watchFile}/>):<Text as="p" size="2" color="gray">还没有{label}</Text>}
        </section>;
    })}</>;
}
