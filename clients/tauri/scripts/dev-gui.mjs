// The real native frontend with hot reload. No fixture runtime or mocked bridge.
import {createServer} from 'vite';
import tailwindcss from '@tailwindcss/vite';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const server=await createServer({configFile:false,cacheDir:root+'node_modules/.vite-native-dev',root:root+'src/gui',plugins:[tailwindcss(),{
  name:'native-development-boundary',
  transform(code,id){if(id===root+'src/gui/main.jsx')return 'import "./native-bridge.js";\n'+code;},
}],resolve:{alias:{'@tauri-apps/api':fileURLToPath(new URL('../node_modules/@tauri-apps/api',import.meta.url))}},server:{watch:{ignored:['**/artifacts/**','**/.harness-build*/**','**/dist/**','**/target/**']},host:'127.0.0.1',port:5194,strictPort:true}});
await server.listen();
console.log('Pibo native development frontend: http://127.0.0.1:5194 (open through Tauri)');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await server.close();process.exit(0);});
