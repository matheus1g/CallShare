const failure=code=>Object.assign(new Error(code),{code});
class PreparationBudget {
  constructor({deadline,now=()=>Date.now(),code='CS_PREPARE_TIMEOUT',setTimer=setTimeout,clearTimer=clearTimeout}){
    Object.assign(this,{deadline,now,code,clearTimer});this.controller=new AbortController();
    this.expired=false;this.pending=new Set();
    this.timer=setTimer(()=>this.expire(),Math.max(0,deadline-now()));this.timer?.unref?.();
  }
  expire(code=this.code){if(this.expired)return;this.expired=true;this.code=code;this.controller.abort();for(const reject of this.pending)reject(failure(this.code));this.pending.clear();}
  assert(){if(this.expired||this.now()>=this.deadline){this.expire();throw failure(this.code);}}
  async run(work,onExpire=()=>{}){
    this.assert();let rejectTimeout;
    const timeout=new Promise((_resolve,reject)=>{rejectTimeout=reject;this.pending.add(reject);});
    const abort=()=>{try{Promise.resolve(onExpire()).catch(()=>{});}catch{}};
    this.controller.signal.addEventListener('abort',abort,{once:true});
    try{return await Promise.race([Promise.resolve().then(()=>{this.assert();return work();}),timeout]);}
    finally{this.pending.delete(rejectTimeout);this.controller.signal.removeEventListener('abort',abort);}
  }
  close(){this.clearTimer(this.timer);this.pending.clear();}
}
module.exports={PreparationBudget};
