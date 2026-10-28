import {createServer} from 'vite';
import tailwindcss from '@tailwindcss/vite';
const root=process.cwd();
const server=await createServer({configFile:false,cacheDir:root+'/artifacts/model-auth-review/vite-cache',root,plugins:[tailwindcss()],
  server:{host:'127.0.0.1',port:5196,strictPort:true,watch:{ignored:['**/artifacts/**','**/.harness-build*/**','**/dist/**','**/target/**']}}});
await server.listen();
console.log('Isolated model-auth UI QA: http://127.0.0.1:5196/clients/tauri/test/ui/model-auth-review.html');
process.on('SIGTERM',async()=>{await server.close();process.exit(0);});
