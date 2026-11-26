'use strict';
const fs=require('fs'),path=require('path');
const SHARES=['/var/opt/hdshare','/mnt/share'];
function unescapeMount(s){return s.replace(/\\([0-7]{3})/g,(_,n)=>String.fromCharCode(parseInt(n,8)));}
function mountFor(text,dir){return text.split('\n').map(line=>{const a=line.split(' '),cut=a.indexOf('-');return cut>5?{point:unescapeMount(a[4]),device:a[2],options:a[5].split(','),type:a[cut+1],source:unescapeMount(a[cut+2]),fsOptions:(a[cut+3]||'').split(',')}:null;}).filter(m=>m&&(dir===m.point||dir.indexOf(m.point==='/'?'/':m.point+'/')===0)).sort((a,b)=>b.point.length-a.point.length)[0]||null;}
function inspect(share,local,io){io=io||fs;const r={path:share,ok:false};try{
 r.realPath=io.realpathSync(share);const st=io.statSync(r.realPath);if(!st.isDirectory())throw Error('MAP_HDD_PATH');
 const m=mountFor(io.readFileSync('/proc/self/mountinfo','utf8'),r.realPath);r.mount=m;
 if(!m||m.point==='/'||m.device.split(':')[0]==='0')throw Error('MAP_HDD_NOT_MOUNTED');
 if(m.options.indexOf('rw')<0||m.fsOptions.indexOf('ro')>=0)throw Error('MAP_HDD_READ_ONLY');
 r.device=st.dev;r.sameDevice=!!(local&&st.dev===io.statSync(local).dev);
 // hdshare can share a block filesystem with /var/opt. That does not make
 // the dedicated shared directory an app-private directory. The privileged
 // helper sees the host mounts, whereas the app may see a private namespace.
 // Keep the same-device guard for unexpected aliases outside the known share
 // roots unless the destination itself is a separate mount point.
 if(r.sameDevice&&SHARES.indexOf(r.realPath)<0&&m.point!==r.realPath)throw Error('MAP_HDD_SAME_DEVICE');
 r.ok=true;
 }catch(e){r.reason=e.code==='ENOENT'?'MAP_HDD_NOT_FOUND':e.code||e.message;}return r;
}
module.exports={SHARES,mountFor,inspect,unescapeMount};
