import React from 'react';import {createRoot} from 'react-dom/client';import {Theme,Text} from '@radix-ui/themes';import '@radix-ui/themes/styles.css';import '/src/gui/style.css';import '/src/gui/components.css';import {DesktopPanel} from '/src/gui/DesktopPanel.jsx';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const sample=(state,reason)=>({state,reason,checkedAt:Date.now()});
const capability={configured:true,canOpenView:true,platform:'linux',computerUse:sample('ready','隔离测试：操作后端可用'),browser:sample('ready','隔离测试：CDP可用'),screenCapture:sample('ready','隔离测试：截图可用'),vnc:sample('unconfigured','隔离测试：尚未打开视图'),availableTools:{browser:[],computer:[]}};
window.__DESKTOP_QA__={binds:0,capability};
const api=async(path)=>{if(path.endsWith('/bind')){window.__DESKTOP_QA__.binds++;capability.vnc=sample('ready','隔离测试：RFB握手成功');}return {...capability};};
const original=window.fetch.bind(window);window.fetch=(url,options)=>String(url).includes('/api/desktop/')?original(png):original(url,options);
createRoot(document.getElementById('root')).render(<Theme className="app-theme" radius="large" appearance="dark" accentColor="amber" grayColor="sand"><main style={{padding:24}}><Text as="p">本地布局验证 · 模拟桌面，无网络连接</Text><DesktopPanel botId="layout-only" name="SDK direct synthetic desktop" enabled capabilities={capability} api={api}/><input aria-label="键盘布局验证" placeholder="仅用于键盘布局验证"/></main></Theme>);
