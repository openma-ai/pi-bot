import {mkdirSync,writeFileSync} from 'node:fs';
import {methods,notifications,PROTOCOL_VERSION} from '../src/sdk/protocol/index.ts';
mkdirSync('dist/protocol',{recursive:true});
const schema={version:PROTOCOL_VERSION,methods,notifications};writeFileSync('dist/protocol/schema.json',JSON.stringify(schema,null,2)+'\n');
const table=Object.keys(methods).map(name=>`| \`${name}\` | [params / result](../dist/protocol/schema.json) |`).join('\n');
writeFileSync('docs/protocol.md',`# Pi Bot app-server protocol\n\nGenerated from src/sdk/protocol. Version: ${PROTOCOL_VERSION}. Regenerate with npm run protocol:schema.\n\nJSON-RPC 2.0 over in-process, HTTP + SSE, or stdio JSONL. Initialize, acknowledge with initialized, read a snapshot, then subscribe after its seq. Secrets and reasoning text never enter events.\n\n| Method | Schema |\n|---|---|\n${table}\n\nNotifications: ${Object.keys(notifications).map(x=>'\`'+x+'\`').join(', ')}.\n`);
