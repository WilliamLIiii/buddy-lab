import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { createModelFixture } from './openai-fixture.mjs';

// Controlled UI verification only. Production never imports this fixture.
const root=fileURLToPath(new URL('../output/ui-qa/',import.meta.url));
const workspaceRoot=join(root,'workspace');await fs.mkdir(workspaceRoot,{recursive:true});
await fs.writeFile(join(workspaceRoot,'source.md'),'# UI verification\nsource-fixture\n');
const model=await createModelFixture();
let credential='';
const secretStore={type:'keychain',async get(){return credential;},async set(value){credential=value;},async delete(){credential='';}};
const app=await createApp({dataDir:join(root,'data'),workspaceRoot,env:{},secretStore,automationOptions:{pollIntervalMs:0}});
const url=await app.listen(47832);
await fetch(`${url}/api/config`, { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseURL:model.baseURL,model:'fixture-model'}) });
await fs.writeFile(join(root,'endpoints.json'),JSON.stringify({url,modelURL:model.baseURL,model:'fixture-model'}));
console.log(JSON.stringify({url,modelURL:model.baseURL,model:'fixture-model'}));
const stop=async()=>{await app.close();await model.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
