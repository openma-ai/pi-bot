type BotIdentity = {id:string;name:string;avatar?:{color?:string;shape?:number;picture?:string}|null};
export type LayoutMessage = { messageId: string; direction: string; sourceKind: string; sender?: string; botId?: string; receivedAt: number; status?: string; streaming?: boolean; [key: string]: unknown };
export const isUserMessage = (m: LayoutMessage) => m.direction === 'inbound' && ['user', 'answer'].includes(m.sourceKind);
export function messageSender(m: LayoutMessage, bots: BotIdentity[]) {
  const id = m.sender || (m.direction === 'outbound' ? m.botId : undefined);
  const bot = bots.find(b => b.id === id);
  return { id: id || `unknown-group-sender:${m.messageId}`, bot, name: bot?.name || (id ? '已移除的成员' : '未知成员') };
}
function validTime(t: number) { return Number.isFinite(t) && Math.abs(t) <= 8640000000000000; }
export function needsTimeSeparator(current: LayoutMessage, previous?: LayoutMessage, timeZone?: string) {
  if (!validTime(current.receivedAt)) return false;
  if (!previous || !validTime(previous.receivedAt)) return true;
  const day = new Intl.DateTimeFormat('en-CA', {timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
  return day.format(current.receivedAt) !== day.format(previous.receivedAt) || current.receivedAt - previous.receivedAt >= 300000;
}
export function messageTimes(timestamp: number, timeZone?: string) {
  if (!validTime(timestamp)) return { iso: undefined, full: '时间未知', label: '时间未知' };
  const date = new Date(timestamp);
  return { iso: date.toISOString(), full: new Intl.DateTimeFormat('zh-CN',{timeZone,year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'long'}).format(date), label:new Intl.DateTimeFormat('zh-CN',{timeZone,year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(date) };
}
/** Pure adjacency layout: no wall clock, content-length or index-derived identity. */
export function layoutMessages(messages: LayoutMessage[], group: boolean, bots: BotIdentity[], timeZone?: string) {
  const boundary = (m: LayoutMessage) => ["failed", "uncertain", "interrupted", "cancelled"].includes(m.status || "") || m.kind === "event";
  const separators = messages.map((m,i)=>needsTimeSeparator(m,messages[i-1],timeZone));
  const keys = messages.map(m => group && !isUserMessage(m) && (m.sourceKind === 'bot' || m.direction === 'outbound') ? messageSender(m,bots).id : null);
  return messages.map((message,i) => ({ message, separator:separators[i], sender:keys[i] ? messageSender(message,bots) : null,
    runStart: Boolean(keys[i] && (i === 0 || boundary(message) || separators[i] || keys[i-1] !== keys[i] || boundary(messages[i-1]))),
    runEnd: Boolean(keys[i] && (i === messages.length-1 || separators[i+1] || keys[i+1] !== keys[i] || boundary(messages[i+1]) || boundary(message))),
    time:messageTimes(message.receivedAt,timeZone),
  }));
}
