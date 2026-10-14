import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../',import.meta.url));
const digest=data=>createHash('sha256').update(data).digest('hex');
export async function localReferenceAssets(root=project){
  const folder=join(root,'web/assets/reference');
  const result={assets:{},icons:{},notice:'本机参考资源，不包含公开再分发授权。'};
  try{
    if((await lstat(folder)).isSymbolicLink())return result;
    const canonical=await realpath(folder);
    const known=JSON.parse(await readFile(join(root,'reference/original-assets-manifest.json'),'utf8')).entries;
    const state=JSON.parse(await readFile(join(folder,'local-assets.json'),'utf8'));
    for(const item of known.filter(e=>e.kind==='asset')){
      if(!state.assets?.includes(item.path)||!/^[-a-zA-Z0-9_/\.]+$/.test(item.path)||item.path.split('/').includes('..'))continue;
      const path=resolve(folder,item.path);if(!path.startsWith(resolve(folder)+'/')||(await lstat(path)).isSymbolicLink()||!(await realpath(path)).startsWith(canonical+'/'))continue;
      const bytes=await readFile(path);if(bytes.length!==item.bytes||digest(bytes)!==item.sha256)continue;
      result.assets[item.path]='/assets/reference/'+item.path;
    }
    for(const item of known.filter(e=>e.kind==='icon')){
      const svg=state.icons?.[item.name];
      if(typeof svg!=='string'||Buffer.byteLength(svg)!==item.bytes||digest(svg)!==item.sha256)continue;
      if(!svg.startsWith('<svg')||/<(?:script|foreignObject|iframe)|\bon[a-z]+\s*=|javascript:/i.test(svg))continue;
      result.icons[item.name]=svg;
    }
  }catch{return result;}
  return result;
}
