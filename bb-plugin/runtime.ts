import { access, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeBundle } from './runtime.generated.js';
const exec=promisify(execFile);
export function verifyBundle(bundle) {
  if(!/^[0-9A-Za-z.+-]+$/.test(bundle.version)||!/^[a-f0-9]{64}$/.test(bundle.sha256)||!/^[a-f0-9]{64}$/.test(bundle.requirementsHash))throw new Error('Invalid runtime identity');
  const entries=Object.entries(bundle.files).sort(([a],[b])=>a<b?-1:a>b?1:0);
  for(const [name] of entries) if(isAbsolute(name)||name.split('/').includes('..')||name.includes('\\'))throw new Error('Invalid runtime path');
  const canonical=JSON.stringify(Object.fromEntries(entries));
  if(createHash('sha256').update(canonical).digest('hex')!==bundle.sha256)throw new Error('Runtime payload checksum mismatch');
}
export async function materializeRuntime(dataDir,bundle=runtimeBundle) {
  verifyBundle(bundle);
  const base=join(dataDir,'runtimes');await mkdir(base,{recursive:true});
  const path=join(base,bundle.version+'-'+bundle.sha256.slice(0,16));
  let current;
  try {current=JSON.parse(await readFile(join(path,'runtime.json'),'utf8'));} catch {}
  if(current?.sha256!==bundle.sha256) {
    const temporary=path+'.preparing-'+randomUUID();await mkdir(temporary,{recursive:true});
    try {
      for(const [name,encoded] of Object.entries(bundle.files)) {
        const target=join(temporary,name);await mkdir(join(target,'..'),{recursive:true});
        await writeFile(target,Buffer.from(encoded as string,'base64'),{flag:'wx',mode:0o600});
      }
      await writeFile(join(temporary,'runtime.json'),JSON.stringify({version:bundle.version,sha256:bundle.sha256}),{flag:'wx'});
      try {await rename(temporary,path);} catch(error) {if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;
        const existing=JSON.parse(await readFile(join(path,'runtime.json'),'utf8'));
        if(existing.sha256!==bundle.sha256)throw new Error('Cached runtime is corrupt; existing files preserved');}
    } finally {await rm(temporary,{recursive:true,force:true});}
  }
  const {stdout}=await exec('python3',['-c','import sys;print(str(sys.version_info.major)+str(sys.version_info.minor))'],{timeout:10000});
  const env=join(dataDir,'environments',process.platform+'-'+process.arch+'-py'+stdout.trim()+'-'+bundle.requirementsHash.slice(0,16));
  const python=join(env,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  let managed=false;
  try {const marker=JSON.parse(await readFile(join(env,'worker-ready.json'),'utf8'));await access(python);managed=marker.requirementsHash===bundle.requirementsHash;} catch {}
  const workRoot=join(dataDir,'jobs');await mkdir(workRoot,{recursive:true});
  return {runtimePath:path,runtimeVersion:bundle.version,runtimeSha256:bundle.sha256,
    requirementsHash:bundle.requirementsHash,environmentPath:env,managedPython:managed?python:null,
    needsSetup:!managed,workRoot,platform:process.platform};
}
