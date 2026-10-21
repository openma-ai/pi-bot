import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
const run=randomUUID(),limit=16*1024;
const server=http.createServer((req,res)=>{
 if(req.url==='/health'&&req.method==='GET')return res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({service:'pibo-synthetic-tailnet-test',run}));
 if(req.url!=='/echo'||req.method!=='POST')return res.writeHead(404).end();
 const chunks=[];let size=0;
 req.on('data',chunk=>{size+=chunk.length;if(size>limit){res.writeHead(413).end();req.destroy();}else chunks.push(chunk);});
 req.on('end',()=>{if(!res.writableEnded)res.writeHead(200,{'Content-Type':'application/octet-stream','X-Pibo-Test-Run':run}).end(Buffer.concat(chunks));});
});
server.maxConnections=32;server.requestTimeout=5000;server.headersTimeout=5000;
server.on('upgrade',(req,socket,head)=>{
 if(req.url!=='/ws'||req.headers['sec-websocket-version']!=='13'||typeof req.headers['sec-websocket-key']!=='string'){socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');return;}
 const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
 socket.setTimeout(30000,()=>socket.destroy());let pending=Buffer.alloc(0);
 function receive(chunk){pending=Buffer.concat([pending,chunk]);if(pending.length>limit+14)return socket.destroy();
  while(pending.length>=6){const first=pending[0],second=pending[1],op=first&15;let len=second&127,offset=2;
   if(!(first&128)||!(second&128)||len===127)return socket.destroy();
   if(len===126){if(pending.length<8)return;len=pending.readUInt16BE(2);offset=4;}
   if(len>limit)return socket.destroy();if(pending.length<offset+4+len)return;
   const mask=pending.subarray(offset,offset+4),body=Buffer.from(pending.subarray(offset+4,offset+4+len));for(let i=0;i<len;i++)body[i]^=mask[i%4];pending=pending.subarray(offset+4+len);
   if(op===8){socket.end(Buffer.from([0x88,0]));return;}if(![1,2,9].includes(op))return socket.destroy();
   const header=Buffer.alloc(len<126?2:4);header[0]=0x80|(op===9?10:op);header[1]=len<126?len:126;if(len>=126)header.writeUInt16BE(len,2);socket.write(Buffer.concat([header,body]));
  }
 }
 socket.on('data',receive);socket.on('error',()=>{});if(head.length)receive(head);
});
server.listen(Number(process.env.PORT??8080),'127.0.0.1',()=>console.log(JSON.stringify({listen:'127.0.0.1:'+server.address().port,service:'pibo-synthetic-tailnet-test',run})));
