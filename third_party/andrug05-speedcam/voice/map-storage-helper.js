'use strict';
// Only provisions SpeedCAM's own directory. No arbitrary path/UID, recursive
// chmod/chown, file copying, disk mounting or changes to the shared directory.
const fs=require('fs'),path=require('path').posix,mounts=require('./hdd-mounts');
const APP='aurelm_speed_camera_warning',OAP='/var/opt/public/oap';
function appUid(io){io=io||fs;const found=[];
 for(const n of io.readdirSync(OAP)){if(!/^oap_\d+$/.test(n))continue;try{
  const a=JSON.parse(io.readFileSync(path.join(OAP,n,'data/apps/'+APP+'.json'),'utf8')),uid=a.userId;
  if(!Number.isInteger(uid)||uid<12000||uid>=15000)continue;
  const p=JSON.parse(io.readFileSync(path.join(OAP,'oap_'+uid,'source/package.json'),'utf8'));
  if(p.name===APP&&found.indexOf(uid)<0)found.push(uid);
 }catch(e){}}
 if(found.length!==1)throw Error('MAP_HDD_HELPER_IDENTITY');return found[0];
}
function provision(share,uid,io,probe){io=io||fs;probe=probe||((p)=>mounts.inspect(p,'/var/opt',io));
 const checked=probe(share);if(!checked.ok)throw Error(checked.reason);
 const base=checked.realPath,name='speedcam-city-maps-'+uid,root=path.join(base,name);
 const flags=io.constants||fs.constants;
 // Pin the mounted parent and child with directory descriptors. Never follow
 // a user-replaced child symlink, including between validation and chown.
 const parent=io.openSync(base,flags.O_RDONLY|flags.O_DIRECTORY|flags.O_NOFOLLOW);let child;
 try{
  if(io.fstatSync(parent).dev!==checked.device)throw Error('MAP_HDD_CHANGED');
  const pinned='/proc/self/fd/'+parent+'/'+name;let created=false;
  try{io.mkdirSync(pinned,0o700);created=true;}catch(e){if(e.code!=='EEXIST')throw e;}
  child=io.openSync(pinned,flags.O_RDONLY|flags.O_DIRECTORY|flags.O_NOFOLLOW);
  const st=io.fstatSync(child);if(!st.isDirectory()||st.dev!==checked.device||[0,uid].indexOf(st.uid)<0)throw Error('MAP_HDD_PATH');
  if(st.uid===0){if(!created&&io.readdirSync('/proc/self/fd/'+child).length)throw Error('MAP_HDD_HELPER_OWNER');io.fchownSync(child,uid,uid);}
  io.fchmodSync(child,0o700);
  io.fsyncSync(child);io.fsyncSync(parent);
  const after=probe(share);if(!after.ok||after.device!==checked.device||after.realPath!==base)throw Error('MAP_HDD_CHANGED');
  return {ok:true,mapStorageProtocol:1,uid,share,root};
 }finally{if(child!==undefined)io.closeSync(child);io.closeSync(parent);}
}
function validate(request){if(!request||request.action!=='map-storage-prepare'||!Number.isInteger(request.share)||request.share<0||request.share>=mounts.SHARES.length||Object.keys(request).some(k=>['action','share'].indexOf(k)<0))throw Error('MAP_HDD_HELPER_REQUEST');}
function prepare(request){validate(request);return provision(mounts.SHARES[request.share],appUid());}
let pending=false;
function prepareAsync(request){return new Promise((resolve,reject)=>{
 try{validate(request);if(pending)throw Error('MAP_HDD_HELPER_BUSY');}catch(e){return reject(e);}pending=true;
 // Directory fsync can be slow. Run it outside the audio service's event loop.
 require('child_process').execFile(process.execPath,[__filename,String(request.share)],{timeout:4000,killSignal:'SIGKILL',maxBuffer:8192},(err,out)=>{
  pending=false;try{const r=JSON.parse(out);if(!r.ok)throw Error(r.error||'MAP_HDD_HELPER_FAILED');if(err)throw Error('MAP_HDD_HELPER_FAILED');resolve(r);}catch(e){reject(Error(err&&err.killed?'MAP_HDD_HELPER_TIMEOUT':e.message));}
 });
});}
if(require.main===module){try{if(process.argv.length!==3||! /^[01]$/.test(process.argv[2]))throw Error('MAP_HDD_HELPER_REQUEST');process.stdout.write(JSON.stringify(prepare({action:'map-storage-prepare',share:Number(process.argv[2])}))+'\n');}catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.code||e.message})+'\n');process.exitCode=1;}}
module.exports={prepare,prepareAsync,provision,appUid};
