// Manual, read-only certificate validation. This policy cannot install or trust a certificate,
// create an identity, start a tunnel or modify an existing stream.
function providerCertificateInfo(value,now=Date.now()) {
    const states=['ready','expiring','expired','not-yet-valid','fingerprint-mismatch','invalid','unavailable'];
    if(!value||value.provider!=='riseup'||!states.includes(value.status))return {provider:'riseup',status:'unavailable',validated:false,checkedAt:now};
    const date=v=>typeof v==='string'&&v.length<40&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
    const out={provider:'riseup',status:value.status,validated:false,checkedAt:now,
        fingerprint:/^[a-f0-9]{64}$/.test(value.fingerprint||'')?value.fingerprint:null,
        validFrom:date(value.validFrom),expiresAt:date(value.expiresAt),
        certificateCount:Number.isInteger(value.certificateCount)&&value.certificateCount>=1&&value.certificateCount<=8?value.certificateCount:null};
    out.validated=value.validated===true&&['ready','expiring'].includes(out.status)&&Boolean(out.fingerprint&&out.validFrom&&out.expiresAt&&out.certificateCount)&&Date.parse(out.validFrom)<=now&&Date.parse(out.expiresAt)>now;
    if(['ready','expiring'].includes(out.status)&&!out.validated)out.status='invalid';
    return out;
}
class ProviderMonitor {
    constructor({check,onResult=()=>{},now=()=>Date.now()}){
        Object.assign(this,{check,onResult,now});this.pending=false;this.result=null;this.history=[];this.generation=0;
    }
    validate({busy=false}={}){
        if(this.pending||busy)return null;
        const generation=this.generation;this.pending=true;
        this.task=Promise.resolve().then(()=>generation===this.generation?this.check():null).catch(()=>null).then(value=>{
            if(generation!==this.generation)return;
            this.result=providerCertificateInfo(value,this.now());this.pending=false;
            this.history.push({...this.result});if(this.history.length>24)this.history.shift();
            this.onResult(this.result);
        }).finally(()=>{if(generation===this.generation)this.pending=false;});
        return this.task;
    }
    cancel(){this.generation++;this.pending=false;}
    report(){return {mode:'manual',automatic:false,pending:this.pending,current:this.result,history:this.history.map(row=>({...row}))};}
}
if(typeof module!=='undefined')module.exports={ProviderMonitor,providerCertificateInfo};
