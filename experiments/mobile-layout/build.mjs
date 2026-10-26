import {build} from '../../node_modules/vite/dist/node/index.js';
import {resolve} from 'node:path';
import {copyFileSync} from 'node:fs';
const root=process.cwd();
await build({configFile:false,root,resolve:{alias:{react:resolve('experiments/mobile-layout/node_modules/react'),'react-dom':resolve('experiments/mobile-layout/node_modules/react-dom')}},build:{outDir:'artifacts/mobile-layout/bundled',emptyOutDir:true,rolldownOptions:{input:resolve('experiments/mobile-layout/index.html')}}});
copyFileSync('artifacts/mobile-layout/bundled/experiments/mobile-layout/index.html','artifacts/mobile-layout/bundled/index.html');
