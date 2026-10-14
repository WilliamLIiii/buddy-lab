import {readFile,writeFile,mkdir,lstat,copyFile,realpath} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),digest=data=>createHash('sha256').update(data).digest('hex');
const arg=name=>{const i=args.indexOf(name);return i<0?'':args[i+1]||'';};
if(!arg('--source-dir')&&!arg('--icons-json')){console.log('仅供学习：node scripts/import-reference-assets.mjs --source-dir <你有权使用的本地web/assets目录> [--icons-json <你有权使用的SVG字典.json>] [--apply]\n默认只检查；--apply 才写入Git忽略的本机参考目录。不会执行原版代码、读取帐号或访问网络。');process.exit(0);}
const manifest=JSON.parse(await readFile(join(root,'reference/original-assets-manifest.json'),'utf8'));
const destination=join(root,'web/assets/reference'),receipt={version:manifest.source.version,assets:[],icons:{},mismatches:[],applied:false};
const source=arg('--source-dir')?await realpath(arg('--source-dir')):'';
for(const entry of manifest.entries.filter(e=>e.kind==='asset')){
  if(!source)break;const path=resolve(source,entry.path);if(!path.startsWith(source+'/'))throw Error('参考清单路径越界。');
  let bytes;try{if((await lstat(path)).isSymbolicLink())throw Error('不导入符号链接。');if(!(await realpath(path)).startsWith(source+'/'))throw Error('真实路径越界。');bytes=await readFile(path);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(bytes.length!==entry.bytes||digest(bytes)!==entry.sha256){receipt.mismatches.push(entry.path);continue;}
  receipt.assets.push(entry.path);
  if(args.includes('--apply')){await mkdir(dirname(join(destination,entry.path)),{recursive:true});await copyFile(path,join(destination,entry.path));}
}
if(arg('--icons-json')){
  const icons=JSON.parse(await readFile(arg('--icons-json'),'utf8'));
  for(const entry of manifest.entries.filter(e=>e.kind==='icon')){const svg=icons[entry.name];if(typeof svg!=='string')continue;if(Buffer.byteLength(svg)!==entry.bytes||digest(svg)!==entry.sha256||!svg.startsWith('<svg')||/<(?:script|foreignObject|iframe)|\bon[a-z]+\s*=|javascript:/i.test(svg)){receipt.mismatches.push('icon:'+entry.name);continue;}receipt.icons[entry.name]=svg;}
}
if(args.includes('--apply')){await mkdir(destination,{recursive:true});await writeFile(join(destination,'local-assets.json'),JSON.stringify({assets:receipt.assets,icons:receipt.icons}),{mode:0o600});receipt.applied=true;}
console.log(JSON.stringify({sourceVersion:receipt.version,verifiedAssets:receipt.assets.length,verifiedIcons:Object.keys(receipt.icons).length,mismatches:receipt.mismatches,applied:receipt.applied,publicRedistributionAuthorized:false},null,2));
