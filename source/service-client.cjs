// Unprivileged service client. This module does not request elevation or install anything.
const net=require('node:net'),cp=require('node:child_process'),path=require('node:path');
const error=code=>Object.assign(new Error(code),{code});
const serviceFailures=new Set(['CS_SERVICE_BUSY','CS_SERVICE_AUTH','CS_SERVICE_INPUT','CS_SERVICE_LAUNCH','CS_SERVICE_START','CS_SERVICE_PIPE']);
function serviceDiagnostic({fs=require('node:fs'),programFiles=process.env.ProgramFiles||'C:\\Program Files',now=Date.now}={}){
  try{const file=path.join(programFiles,'CallShare','CallShare-broker-status.json');if(fs.statSync(file).size>4096)return null;
    const value=JSON.parse(fs.readFileSync(file,'utf8')),at=Date.parse(value.at);
    if(value.brokerVersion!=='0.13.4'||!Number.isFinite(at)||Math.abs(now()-at)>300000)return null;
    return {stage:['starting','listening','responded','stopped','start-failed','pipe-failed','request-failed'].includes(value.stage)?value.stage:null,
      failure:serviceFailures.has(value.failure)?value.failure:null,nativeCode:Number.isInteger(value.nativeCode)&&value.nativeCode>=0&&value.nativeCode<=4294967295?value.nativeCode:null};
  }catch{return null;}
}
function brokerRequest(op,token,{connect=net.connect}={}){
  if(!['status','launch'].includes(op)||op==='launch'&&!/^[a-f0-9]{64}$/.test(token||''))return Promise.reject(error('CS_SERVICE_INPUT'));
  return new Promise((resolve,reject)=>{
    const socket=connect('\\\\.\\pipe\\CallShareBroker-v1');let data='',done=false;
    const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();err?reject(err):resolve(value);};
    const timer=setTimeout(()=>finish(error('CS_SERVICE_UNAVAILABLE')),4000);
    socket.once('error',()=>finish(error('CS_SERVICE_UNAVAILABLE')));
    socket.once('connect',()=>socket.write(JSON.stringify({protocol:1,op,...(op==='launch'?{token}:{})})+'\n'));
    socket.on('data',chunk=>{data+=chunk.toString();if(data.length>4096)return finish(error('CS_SERVICE_PROTOCOL'));
      const end=data.indexOf('\n');if(end<0)return;
      try{const v=JSON.parse(data.slice(0,end));if(v.protocol!==1||v.brokerVersion!=='0.13.4')throw Error();
        if(v.failure){if(!serviceFailures.has(v.failure))throw Error();return finish(error(v.failure));}
        if(op==='launch'&&v.launched!==true)throw Error();finish(null,{brokerVersion:v.brokerVersion,launched:v.launched===true});
      }catch{finish(error('CS_SERVICE_PROTOCOL'));}
    });socket.once('end',()=>{if(!done)finish(error('CS_SERVICE_UNAVAILABLE'));});
  });
}
async function launchViaService(token,{request=brokerRequest,start,diagnostic=serviceDiagnostic,delay=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}={}){
  if(!/^[a-f0-9]{64}$/.test(token||''))throw error('CS_SERVICE_INPUT');
  try{return await request('launch',token);}catch(e){if(e.code!=='CS_SERVICE_UNAVAILABLE')throw Object.assign(e,{serviceDiagnostic:diagnostic()});}
  const startService=start||(()=>new Promise(resolve=>{
    const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','sc.exe');
    const child=cp.spawn(exe,['start','CallShareBroker'],{windowsHide:true,stdio:'ignore'});
    const timer=setTimeout(()=>{child.kill();resolve(-1);},10000);timer.unref?.();
    const finish=code=>{clearTimeout(timer);resolve(code);};child.once('error',()=>finish(-1));child.once('exit',finish);
  }));
  const code=await startService();
  if(code===1060)throw error('CS_SERVICE_MISSING');
  if(code!==0&&code!==1056)throw Object.assign(error(code===5?'CS_SERVICE_ACCESS':'CS_SERVICE_START'),{serviceDiagnostic:diagnostic()});
  const deadline=now()+15000;
  while(now()<deadline){try{return await request('launch',token);}catch(e){if(e.code!=='CS_SERVICE_UNAVAILABLE')throw Object.assign(e,{serviceDiagnostic:diagnostic()});}await delay(250);}
  const details=diagnostic();throw Object.assign(error(['start-failed','pipe-failed'].includes(details?.stage)&&serviceFailures.has(details?.failure)?details.failure:'CS_SERVICE_UNAVAILABLE'),{serviceDiagnostic:details});
}
module.exports={brokerRequest,launchViaService,serviceDiagnostic};
