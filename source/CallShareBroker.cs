// Original CallShare service. No user-supplied executable, path, command or script is accepted.
// This source is staged for the per-process transport; it is not installed by build/self-test.
using System;
using System.IO;
using System.IO.Pipes;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.ServiceProcess;
using Microsoft.Win32;

internal sealed class CallShareBroker : ServiceBase {
    internal const string Version="0.13.4",Name="CallShareBroker",Pipe="CallShareBroker-v1";
    readonly JavaScriptSerializer json=new JavaScriptSerializer{MaxJsonLength=4096,RecursionLimit=4};
    volatile bool stopping;
    NamedPipeServerStream activePipe;
    Thread thread;
    Process worker;
    string workerToken,userSid,root;
    string pipeName=Pipe;
    bool ipcSelfTest;
    bool protectedRoot;
    string diagnosticFailure,diagnosticStage;
    uint? diagnosticCode;
    DateTime diagnosticAt;
    static void Main(string[] args){
        if(args.Length==1&&args[0]=="--self-test"){SelfTest();return;}
        if(args.Length==2&&args[0]=="--self-test-ipc"){
            if(!Regex.IsMatch(args[1],"\\A[a-f0-9]{32}\\z")){Environment.ExitCode=1;return;}
            using(var broker=new CallShareBroker()){
                broker.pipeName="CallShareBroker-test-"+args[1];broker.ipcSelfTest=true;broker.userSid=WindowsIdentity.GetCurrent().User.Value;
                using(var timer=new Timer(delegate(object unused){broker.stopping=true;try{if(broker.activePipe!=null)broker.activePipe.Dispose();}catch{}},null,8000,Timeout.Infinite))broker.Serve();
            }return;
        }
        if(args.Length!=0){Environment.ExitCode=1;return;}
        ServiceBase.Run(new CallShareBroker());
    }
    CallShareBroker(){ServiceName=Name;CanStop=true;CanShutdown=true;AutoLog=false;}
    protected override void OnStart(string[] args){
        root=AppDomain.CurrentDomain.BaseDirectory;
        CheckProtectedDirectory(root);
        protectedRoot=true;
        try{
            Diagnostic("starting",null,null);
            using(var key=Registry.LocalMachine.OpenSubKey(@"SOFTWARE\CallShare\Broker",false))
                userSid=key==null?null:key.GetValue("UserSid") as string;
            if(userSid==null||!new SecurityIdentifier(userSid).IsAccountSid())throw new InvalidOperationException();
            stopping=false;thread=new Thread(Serve){IsBackground=true};thread.Start();
        }catch(Exception error){Diagnostic("start-failed","CS_SERVICE_START",error);throw;}
    }
    protected override void OnStop(){
        RequestAdditionalTime(65000);stopping=true;
        try{if(activePipe!=null)activePipe.Dispose();}catch{}
        StopOwnedWorker();if(thread!=null)thread.Join(5000);
        Diagnostic("stopped",null,null);
    }
    protected override void OnShutdown(){OnStop();}
    static string Arguments(string token,string sid){
        if(token==null||!Regex.IsMatch(token,"\\A[a-f0-9]{64}\\z")||!new SecurityIdentifier(sid).IsAccountSid())throw new InvalidOperationException();
        return "--pipe callshare-vpn-"+token.Substring(0,24)+" --token "+token+" --user-sid "+sid;
    }
    static void CheckProtectedDirectory(string path){
        if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException();
        var acl=Directory.GetAccessControl(path);
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
            // Read/execute for Users is harmless; writing service binaries is not.
            const FileSystemRights writes=FileSystemRights.Write|FileSystemRights.Delete|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership|FileSystemRights.DeleteSubdirectoriesAndFiles;
            string sid=rule.IdentityReference.Value;
            if(rule.AccessControlType==AccessControlType.Allow&&(rule.FileSystemRights&writes)!=0&&sid!="S-1-5-18"&&sid!="S-1-5-32-544"&&sid!="S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464")throw new InvalidOperationException();
        }
    }
    bool IsLocalAuthorizedClient(NamedPipeServerStream pipe){
        uint pid;
        if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid)||pid==0){if(ipcSelfTest)Console.Error.WriteLine("CS_PIPE_TEST_PID:"+Marshal.GetLastWin32Error());return false;}
        bool allowed=false;
        pipe.RunAsClient(delegate(){using(var identity=WindowsIdentity.GetCurrent(true))allowed=identity!=null&&identity.User!=null&&identity.User.Value==userSid;});
        if(ipcSelfTest&&!allowed)Console.Error.WriteLine("CS_PIPE_TEST_IDENTITY");return allowed;
    }
    static byte[] ReadAuthenticatedRequest(Stream pipe,Func<bool> authorize){
        var bytes=new MemoryStream();int next;
        while((next=pipe.ReadByte())!=-1&&next!=10){if(bytes.Length>=4096)throw new InvalidOperationException("CS_SERVICE_INPUT");bytes.WriteByte((byte)next);}
        if(next!=10)throw new InvalidOperationException("CS_SERVICE_INPUT");
        // ImpersonateNamedPipeClient authenticates the last message READ, not just a connection.
        // Parse no command and launch nothing until this bounded frame has been authenticated.
        try{if(!authorize())throw new UnauthorizedAccessException();}
        catch(Exception error){throw new InvalidOperationException("CS_SERVICE_AUTH",error);}
        return bytes.ToArray();
    }
    void Diagnostic(string stage,string failure,Exception error){
        if(!protectedRoot)return;
        try{
            Exception native=error==null?null:error.InnerException??error;
            if(failure!=null){diagnosticFailure=failure;diagnosticStage=stage;diagnosticCode=native==null?(uint?)null:unchecked((uint)native.HResult);diagnosticAt=DateTime.UtcNow;}
            else if(stage=="starting"||stage=="responded"||stage=="stopped"){diagnosticFailure=null;diagnosticCode=null;}
            File.WriteAllText(Path.Combine(root,"CallShare-broker-status.json"),json.Serialize(new{brokerVersion=Version,stage=diagnosticFailure==null?stage:diagnosticStage,failure=diagnosticFailure,
                nativeCode=diagnosticCode,at=(diagnosticFailure==null?DateTime.UtcNow:diagnosticAt).ToString("o")}),new UTF8Encoding(false));
        }catch{}
    }
    void Serve(){
        var acl=new PipeSecurity();acl.SetAccessRuleProtection(true,false);
        foreach(string sid in new[]{userSid,"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid),PipeAccessRights.FullControl,AccessControlType.Allow));
        while(!stopping)try{
            using(var pipe=new NamedPipeServerStream(pipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,acl)){
                Diagnostic("listening",null,null);
                activePipe=pipe;if(ipcSelfTest)Console.Error.WriteLine("CS_PIPE_TEST_LISTENING");pipe.WaitForConnection();if(stopping)return;
                using(var timeout=new Timer(delegate(object unused){try{pipe.Dispose();}catch{}},null,3500,Timeout.Infinite)){
                  try{
                    var bytes=ReadAuthenticatedRequest(pipe,delegate(){return IsLocalAuthorizedClient(pipe);});
                    var req=json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(bytes));
                    foreach(string field in req.Keys)if(field!="protocol"&&field!="op"&&field!="token")throw new InvalidOperationException();
                    object protocol,op;
                    if(!req.TryGetValue("protocol",out protocol)||!(protocol is int)||(int)protocol!=1||!req.TryGetValue("op",out op)||!(op is string))throw new InvalidOperationException();
                    string operation=(string)op;bool launched=false;string failure=null;
                    if(ipcSelfTest&&operation!="status")throw new InvalidOperationException();
                    if(operation=="launch"){
                        object token;if(!req.TryGetValue("token",out token)||!(token is string))throw new InvalidOperationException();
                        string args=Arguments((string)token,userSid);
                        if(worker!=null&&!worker.HasExited){if(workerToken!=(string)token)failure="CS_SERVICE_BUSY";else launched=true;}
                        else{
                            if(worker!=null)worker.Dispose();
                            string exe=Path.Combine(root,"CallShare-vpn-worker.exe");
                            worker=new Process{StartInfo=new ProcessStartInfo(exe,args){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,WorkingDirectory=root}};
                            try{launched=worker.Start();workerToken=(string)token;}catch(Exception error){throw new InvalidOperationException("CS_SERVICE_LAUNCH",error);}
                        }
                    }else if(operation!="status")throw new InvalidOperationException();
                    var response=Encoding.UTF8.GetBytes(json.Serialize(new{protocol=1,brokerVersion=Version,launched=launched,failure=failure})+"\n");
                    pipe.Write(response,0,response.Length);pipe.Flush();
                    Diagnostic("responded",null,null);
                    if(ipcSelfTest)stopping=true;
                  }catch(Exception error){
                    string reason=error.Message=="CS_SERVICE_AUTH"?"CS_SERVICE_AUTH":error.Message=="CS_SERVICE_LAUNCH"?"CS_SERVICE_LAUNCH":"CS_SERVICE_INPUT";
                    Diagnostic("request-failed",reason,error);
                    if(ipcSelfTest){Console.Error.WriteLine("CS_PIPE_TEST_ERROR:"+reason+":"+error.HResult.ToString("X8"));Environment.ExitCode=1;stopping=true;}
                    try{var failed=Encoding.UTF8.GetBytes(json.Serialize(new{protocol=1,brokerVersion=Version,launched=false,failure=reason})+"\n");pipe.Write(failed,0,failed.Length);pipe.Flush();}catch{}
                  }
                }
            }
        }catch(Exception error){Diagnostic("pipe-failed","CS_SERVICE_PIPE",error);if(ipcSelfTest){Console.Error.WriteLine("CS_PIPE_TEST_ERROR:"+error.HResult.ToString("X8"));Environment.ExitCode=1;stopping=true;}if(!stopping)Thread.Sleep(100);}
    }
    void StopOwnedWorker(){
        var child=worker;if(child==null)return;
        try{if(!child.HasExited){using(var pipe=new NamedPipeClientStream(".","callshare-vpn-"+workerToken.Substring(0,24),PipeDirection.InOut)){
            pipe.Connect(2500);byte[] data=Encoding.UTF8.GetBytes(json.Serialize(new{token=workerToken,op="stop"})+"\n");pipe.Write(data,0,data.Length);pipe.Flush();
        }child.WaitForExit(55000);}}catch{}
        // An unresponsive worker retains its own lease and kill-on-close child job.
        // Never kill by process name or alter another application's session here.
    }
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint pid);
    static void SelfTest(){
        using(var stream=new MemoryStream(Encoding.UTF8.GetBytes("{\"protocol\":1,\"op\":\"status\"}\n"))){
            bool called=false;var frame=ReadAuthenticatedRequest(stream,delegate(){called=true;if(stream.Position!=stream.Length)throw new Exception();return true;});
            if(!called||frame.Length!=stream.Length-1)throw new Exception();
        }
        using(var stream=new MemoryStream(Encoding.UTF8.GetBytes("malformed-private-payload\n"))){
            bool refused=false;try{ReadAuthenticatedRequest(stream,delegate(){return false;});}catch(InvalidOperationException error){refused=error.Message=="CS_SERVICE_AUTH";}if(!refused)throw new Exception();
        }
        foreach(string malformed in new[]{"no-newline",new string('x',4097)+"\n"})using(var stream=new MemoryStream(Encoding.UTF8.GetBytes(malformed))){
            bool refused=false;try{ReadAuthenticatedRequest(stream,delegate(){throw new Exception("authorization must not run");});}catch(InvalidOperationException error){refused=error.Message=="CS_SERVICE_INPUT";}if(!refused)throw new Exception();
        }
        string sid=WindowsIdentity.GetCurrent().User.Value,token=new string('a',64);
        string args=Arguments(token,sid);
        if(args!="--pipe callshare-vpn-"+new string('a',24)+" --token "+token+" --user-sid "+sid)throw new Exception();
        foreach(string bad in new[]{token+" --config arbitrary",token+"\n",new string('A',64),""}){
            bool refused=false;try{Arguments(bad,sid);}catch{refused=true;}if(!refused)throw new Exception();
        }
        var text=new JavaScriptSerializer().Serialize(new{protocol=1,brokerVersion=Version,launched=true,failure=(string)null});
        if(text.Contains(token)||text.Contains(sid))throw new Exception();
    }
}
