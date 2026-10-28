import {createServer} from 'vite';
import tailwindcss from '@tailwindcss/vite';
const root=process.cwd(),port=Number(process.env.PIBOT_QA_PORT||5208);
if(!Number.isInteger(port)||port<1024||[5194,5196].includes(port))throw Error('Use a separate QA port');
const server=await createServer({configFile:false,cacheDir:root+'/artifacts/model-auth-fallback/vite-cache',root,plugins:[tailwindcss()],server:{host:'127.0.0.1',port,strictPort:true,hmr:process.env.PIBOT_QA_HMR!=='0',watch:{ignored:['**/artifacts/**','**/dist/**','**/target/**']}}});
await server.listen();console.log(`ISOLATED FAKE AUTH QA: http://127.0.0.1:${port}/clients/tauri/test/ui/model-auth-review.html`);
process.on('SIGTERM',async()=>{await server.close();process.exit(0);});
