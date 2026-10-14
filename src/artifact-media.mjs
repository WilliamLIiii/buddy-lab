import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {extname} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {safePath} from './tools.mjs';

const formats={'.mp4':['video','video/mp4'],'.webm':['video','video/webm'],'.mov':['video','video/quicktime'],'.mp3':['audio','audio/mpeg'],'.wav':['audio','audio/wav'],'.m4a':['audio','audio/mp4']};
export const artifactMedia = path => {const f=formats[extname(path).toLowerCase()];return f?{kind:f[0],mimeType:f[1]}:null;};
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export async function serveArtifactMedia(req,res,root,path){
  const media=artifactMedia(path);if(!media)throw fail('仅支持实际音频或视频文件。');
  const handle=await open(await safePath(root,path),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await handle.stat();if(!stat.isFile())throw fail('产物文件不可用。',404);
    let start=0,end=stat.size-1,status=200;
    if(req.headers.range){
      const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(!m||(!m[1]&&!m[2])){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return res.end();}
      if(!m[1])start=Math.max(0,stat.size-Number(m[2]));else start=Number(m[1]);
      end=m[1]&&m[2]?Math.min(Number(m[2]),stat.size-1):stat.size-1;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=stat.size||end<start){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return res.end();}status=206;
    }
    res.writeHead(status,{'Content-Type':media.mimeType,'Accept-Ranges':'bytes','Content-Length':Math.max(0,end-start+1),...(status===206?{'Content-Range':`bytes ${start}-${end}/${stat.size}`}:{})});
    if(req.method==='HEAD'||!stat.size)return res.end();
    await pipeline(handle.createReadStream({start,end,autoClose:false}),res);
  }finally{await handle.close();}
}
