import {mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server.mjs';import {createCoreWorkflowFixture} from './core-workflow-fixture.mjs';
const root=fileURLToPath(new URL('../output/core-architecture-ui/',import.meta.url));await mkdir(root,{recursive:true});
const fixture=await createCoreWorkflowFixture(),app=await createApp({dataDir:join(root,'data'),workspaceRoot:join(root,'workspace'),env:{},secretStore:{type:'memory',async get(){return'';},async set(){},async delete(){}},automationOptions:{pollIntervalMs:0}}),url=await app.listen(47835);
await fetch(url+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseURL:fixture.baseURL,model:'isolated-core-fixture'})});
const workspace=app.store.workspaces()[0];await writeFile(join(workspace.root,'source.md'),'实际验收来源资料：需要真实读取、审批写盘和保存可重用步骤。');
await writeFile(join(root,'endpoints.json'),JSON.stringify({url,workspaceId:workspace.id}));console.log(JSON.stringify({url}));
const stop=async()=>{await app.close();await fixture.close();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
