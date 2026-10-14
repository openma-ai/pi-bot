import { build } from '../../../node_modules/vite/dist/node/index.js';
import tailwindcss from '../../../node_modules/@tailwindcss/vite/dist/index.mjs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
await build({configFile:false,root:root+'src/gui',plugins:[tailwindcss(),{
  name:'native-client-boundary',transform(code,id){ if(id===root+'src/gui/main.jsx') return 'import "./native-bridge.js";\n'+code; }
}],
  resolve:{alias:{'@tauri-apps/api':fileURLToPath(new URL('../node_modules/@tauri-apps/api',import.meta.url))}},
  build:{outDir:root+'clients/tauri/dist',emptyOutDir:true}});
