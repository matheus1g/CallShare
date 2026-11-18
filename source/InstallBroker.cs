// One-time installer bootstrap. No network session is prepared by installation.
using System;
using System.IO;
using System.Reflection;
using System.Diagnostics;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.ServiceProcess;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using Microsoft.Win32;

internal static class InstallBroker {
    const string Service="CallShareBroker";
    static string Root{get{return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"CallShare");}}
    static string PackageDir;
    static readonly string[] Files={"CallShareBroker.exe","CallShare-vpn-worker.exe","Windows.Packet.Filter.3.6.2.1.x64.msi","VC_redist.x64.exe"};
    [STAThread]static void Main(string[] args){
        if(args.Length==1&&args[0]=="--self-test"){try{SelfTest();}catch{Environment.ExitCode=1;}return;}
        try{
            string sid;bool remove=false;
            if(args.Length==0||args.Length==1&&args[0]=="--uninstall"){
                sid=WindowsIdentity.GetCurrent().User.Value;remove=args.Length==1;
                var info=new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,(remove?"--remove ":"--install ")+sid){UseShellExecute=true,Verb="runas",WindowStyle=ProcessWindowStyle.Hidden};
                Process.Start(info);return;
            }
            if(args.Length!=2||(args[0]!="--install"&&args[0]!="--remove")||!ValidSid(args[1]))throw new Exception("CS_SETUP_ARGUMENTS");
            sid=args[1];remove=args[0]=="--remove";
            if(!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))throw new Exception("CS_SETUP_ADMIN");
            if(remove){Uninstall();MessageBox.Show("O auxiliar do CallShare foi removido. Os drivers compartilhados permanecem instalados.","CallShare");return;}
            Install(sid);MessageBox.Show("Auxiliar instalado e verificado. As permissões do Firewall foram conferidas. Volte ao painel do CallShare e use Preparar compartilhamento. As próximas preparações não pedirão autorização do Windows.","CallShare");
        }catch(System.ComponentModel.Win32Exception e){if(e.NativeErrorCode!=1223)MessageBox.Show("O Windows não concluiu a instalação. Código: CS_SETUP_WINDOWS.","CallShare");}
        catch(Exception e){string code=Regex.IsMatch(e.Message??"",@"\ACS_[A-Z_]+\z")?e.Message:"CS_SETUP_INTERNAL";
            string detail=code=="CS_SETUP_REBOOT_REQUIRED"?"O instalador oficial pediu um reinício inicial do Windows. Reinicie quando for conveniente e execute novamente a instalação do auxiliar.":"A instalação não foi concluída.";
            if(code=="CS_SETUP_SERVICE_START")detail="Os arquivos foram instalados, mas o serviço não iniciou. A instalação não foi declarada pronta.";
            if(code=="CS_SETUP_SERVICE_PROBE")detail="O serviço iniciou, mas não respondeu corretamente à verificação local. A instalação não foi declarada pronta.";
            if(code=="CS_SETUP_FIREWALL_DECLINED")detail="O auxiliar foi instalado. O ajuste dos perfis do Firewall foi recusado, e o bloqueio total de entrada pode impedir as transmissões. Execute novamente o instalador quando quiser revisar esse ajuste.";
            if(code=="CS_SETUP_FIREWALL_QUERY")detail="O auxiliar foi instalado, mas o Windows não disponibilizou a verificação dos perfis do Firewall. A compatibilidade de rede precisa ser conferida.";
            if(code=="CS_SETUP_FIREWALL_POLICY")detail="O auxiliar foi instalado, mas uma configuração ou política do Windows manteve o bloqueio das permissões de entrada. O ajuste local foi encerrado. Consulte a política do Firewall e os registros na pasta do CallShare.";
            if(code=="CS_SETUP_FIREWALL_CHANGED")detail="A configuração de rede mudou durante a verificação do Firewall. Execute novamente o instalador para conferir os perfis atuais.";
            if(code=="CS_SETUP_FIREWALL_BACKUP")detail="O registro da configuração anterior do Firewall não foi confirmado. Execute novamente o instalador para revisar o ajuste.";
            if(code=="CS_SETUP_FIREWALL_RESTORE")detail="O ajuste do Firewall não foi confirmado e a restauração do valor local anterior também precisa ser conferida. Preserve os registros CallShare-firewall-backup na pasta do CallShare em Arquivos de Programas.";
            MessageBox.Show(detail+" Código: "+code+". Nenhuma sessão VPN foi preparada.","CallShare");Environment.ExitCode=1;}
    }
    static bool ValidSid(string value){try{return Regex.IsMatch(value,@"\AS-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+\z")&&new SecurityIdentifier(value).IsAccountSid();}catch{return false;}}
    static DirectorySecurity Acl(){var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));
        foreach(string id in new[]{"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(id),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-5-32-545"),FileSystemRights.ReadAndExecute,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));return acl;}
    static void CheckDirectory(string path){
        if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw new Exception("CS_SETUP_DIRECTORY");
        var acl=Directory.GetAccessControl(path);
        const FileSystemRights write=FileSystemRights.Write|FileSystemRights.Delete|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership|FileSystemRights.DeleteSubdirectoriesAndFiles;
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&(rule.FileSystemRights&write)!=0&&
            rule.IdentityReference.Value!="S-1-5-18"&&rule.IdentityReference.Value!="S-1-5-32-544")throw new Exception("CS_SETUP_DIRECTORY");
    }
    static int Run(string exe,string args){using(var process=Process.Start(new ProcessStartInfo(exe,args){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,WorkingDirectory=Root})){
        if(!process.WaitForExit(180000))throw new Exception("CS_SETUP_TIMEOUT");return process.ExitCode;}}
    static bool Exists(){using(var service=new ServiceController(Service)){try{var status=service.Status;return true;}catch{return false;}}}
    static void StopService(){if(!Exists())return;using(var service=new ServiceController(Service)){if(service.Status==ServiceControllerStatus.Stopped)return;service.Stop();service.WaitForStatus(ServiceControllerStatus.Stopped,TimeSpan.FromSeconds(80));}}
    static string Sc{get{return Path.Combine(Environment.SystemDirectory,"sc.exe");}}
    static string ServiceArguments(string action){return action+" "+Service+" binPath= \"\\\""+Path.Combine(Root,Files[0])+"\\\"\" start= demand obj= LocalSystem";}
    static void Install(string sid){
        Directory.CreateDirectory(Root,Acl());CheckDirectory(Root);StopService();
        PackageDir=Path.Combine(Root,"setup-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(PackageDir,Acl());
        try{
            foreach(string name in Files)Extract(name,Path.Combine(PackageDir,name));
            if(!RuntimeReady()){
                int runtimeExit=Run(Path.Combine(PackageDir,Files[3]),"/install /quiet /norestart");
                if(runtimeExit==3010||runtimeExit==1641)throw new Exception("CS_SETUP_REBOOT_REQUIRED");
                if(runtimeExit!=0||!RuntimeReady())throw new Exception("CS_SETUP_RUNTIME");
            }
            string driver=Path.Combine(PackageDir,Files[2]);
            int driverExit=DriverReady()?0:Run(Path.Combine(Environment.SystemDirectory,"msiexec.exe"),"/i \""+driver+"\" /quiet /norestart");
            if(driverExit==3010||driverExit==1641)throw new Exception("CS_SETUP_REBOOT_REQUIRED");
            if(driverExit!=0)throw new Exception("CS_SETUP_DRIVER");
            foreach(string name in new[]{Files[0],Files[1]}){
                string destination=Path.Combine(Root,name);
                if(File.Exists(destination)&&(File.GetAttributes(destination)&FileAttributes.ReparsePoint)!=0)throw new Exception("CS_SETUP_DIRECTORY");
                File.Copy(Path.Combine(PackageDir,name),destination,true);
            }
            using(var key=Registry.LocalMachine.CreateSubKey(@"SOFTWARE\CallShare\Broker")){key.SetValue("UserSid",sid,RegistryValueKind.String);key.SetValue("Version","0.13.4",RegistryValueKind.String);}
            string action=Exists()?"config":"create";
            if(Run(Sc,ServiceArguments(action))!=0)throw new Exception("CS_SETUP_SERVICE");
            string security="D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LCRP;;;"+sid+")";
            if(Run(Sc,"sdset "+Service+" \""+security+"\"")!=0)throw new Exception("CS_SETUP_PERMISSIONS");
            Firewall(true);
            VerifyService(sid);
            FirewallProfiles.ConfigureForInstall(Root,delegate(string prompt){return MessageBox.Show(prompt,"CallShare · permissões de entrada",MessageBoxButtons.YesNo,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)==DialogResult.Yes;});
            // Only the idle broker starts for verification. No worker/tunnel or Discord restart.
        }finally{foreach(string name in Files)try{File.Delete(Path.Combine(PackageDir,name));}catch{}try{Directory.Delete(PackageDir,false);}catch{}}
    }
    static void Extract(string name,string target){using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload."+name)){
        if(stream==null)throw new Exception("CS_SETUP_PAYLOAD");using(var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None))stream.CopyTo(output);
    }}
    static bool RuntimeReady(){
        foreach(string name in new[]{"MSVCP140.dll","MSVCP140_ATOMIC_WAIT.dll","VCRUNTIME140.dll","VCRUNTIME140_1.dll"}){
            string file=Path.Combine(Environment.SystemDirectory,name);if(!File.Exists(file))return false;
            var version=FileVersionInfo.GetVersionInfo(file);if(version.FileMajorPart<14||version.FileMajorPart==14&&version.FileMinorPart<44)return false;
        }
        return true;
    }
    static bool DriverReady(){string file=Path.Combine(Environment.SystemDirectory,@"drivers\ndisrd.sys");if(!File.Exists(file))return false;
        var v=FileVersionInfo.GetVersionInfo(file);return v.FileMajorPart==3&&(v.FileMinorPart>6||v.FileMinorPart==6&&v.FileBuildPart>=1);}
    static void VerifyService(string sid){
        try{using(var service=new ServiceController(Service)){if(service.Status!=ServiceControllerStatus.Running)service.Start();service.WaitForStatus(ServiceControllerStatus.Running,TimeSpan.FromSeconds(20));}}
        catch{throw new Exception("CS_SETUP_SERVICE_START");}
        // An alternate administrator's credential is not the authorized plugin user's identity.
        // Confirm Running in that case; the user's own client performs the authenticated check.
        if(WindowsIdentity.GetCurrent().User.Value!=sid)return;
        try{using(var pipe=new NamedPipeClientStream(".","CallShareBroker-v1",PipeDirection.InOut,PipeOptions.Asynchronous,TokenImpersonationLevel.Identification)){
            pipe.Connect(10000);using(var timer=new System.Threading.Timer(delegate(object unused){try{pipe.Dispose();}catch{}},null,5000,Timeout.Infinite)){
                byte[] request=Encoding.UTF8.GetBytes("{\"protocol\":1,\"op\":\"status\"}\n");pipe.Write(request,0,request.Length);pipe.Flush();
                var bytes=new MemoryStream();int next;while((next=pipe.ReadByte())!=-1&&next!=10){if(bytes.Length>=4096)throw new Exception();bytes.WriteByte((byte)next);}
                if(next!=10||!ValidServiceReply(Encoding.UTF8.GetString(bytes.ToArray())))throw new Exception();
            }
        }}catch{throw new Exception("CS_SETUP_SERVICE_PROBE");}
    }
    static bool ValidServiceReply(string json){try{
        var reply=new JavaScriptSerializer{MaxJsonLength=4096,RecursionLimit=4}.Deserialize<Dictionary<string,object>>(json);
        return reply.ContainsKey("protocol")&&reply["protocol"] is int&&(int)reply["protocol"]==1&&reply.ContainsKey("brokerVersion")&&Object.Equals(reply["brokerVersion"],"0.13.4")&&
            reply.ContainsKey("failure")&&reply["failure"]==null&&reply.ContainsKey("launched")&&Object.Equals(reply["launched"],false);
    }catch{return false;}}
    static void Firewall(bool add){
        string netsh=Path.Combine(Environment.SystemDirectory,"netsh.exe"),program=Path.Combine(Root,Files[1]);
        foreach(string protocol in new[]{"TCP","UDP"}){
            string name="CallShare scoped relay "+protocol;
            Run(netsh,"advfirewall firewall delete rule name=\""+name+"\" program=\""+program+"\"");
            if(add&&Run(netsh,"advfirewall firewall add rule name=\""+name+"\" dir=in action=allow program=\""+program+"\" protocol="+protocol+" profile=any enable=yes edge=no")!=0)throw new Exception("CS_SETUP_FIREWALL");
        }
    }
    static void Uninstall(){
        if(!Directory.Exists(Root))return;CheckDirectory(Root);StopService();if(Exists()&&Run(Sc,"delete "+Service)!=0)throw new Exception("CS_SETUP_SERVICE");Firewall(false);
        foreach(string name in new[]{Files[0],Files[1]}){string path=Path.Combine(Root,name);if(File.Exists(path))File.Delete(path);}
        string diagnostic=Path.Combine(Root,"CallShare-broker-status.json");if(File.Exists(diagnostic))File.Delete(diagnostic);
        using(var key=Registry.LocalMachine.OpenSubKey(@"SOFTWARE\CallShare",true))if(key!=null)try{key.DeleteSubKey("Broker",false);}catch{}
        // Delete only a known, empty owned directory. Shared drivers and other files are retained.
        try{Directory.Delete(Root,false);}catch{}
    }
    static void SelfTest(){FirewallProfiles.SelfTest();if(ValidSid("S-1-5-21-1-2-3-1001 --config x")||ValidSid("S-1-5-18")||!ValidSid("S-1-5-21-1-2-3-1001"))throw new Exception();
        const string reply="{\"protocol\":1,\"brokerVersion\":\"0.13.4\",\"launched\":false,\"failure\":null}";
        if(!ValidServiceReply(reply))throw new Exception();
        foreach(string bad in new[]{reply.Replace("0.13.4","0.10.0"),reply.Replace("null","\"CS_SERVICE_AUTH\""),reply.Replace("false","true"),"{}","private-token"})if(ValidServiceReply(bad))throw new Exception();
        // Parse the same Windows command line used by sc.exe without invoking it.
        int count;IntPtr parsed=CommandLineToArgvW("sc.exe "+ServiceArguments("create"),out count);
        try{if(parsed==IntPtr.Zero||count!=9||Marshal.PtrToStringUni(Marshal.ReadIntPtr(parsed,4*IntPtr.Size))!="\""+Path.Combine(Root,Files[0])+"\"")throw new Exception("CS_SETUP_QUOTING");}finally{if(parsed!=IntPtr.Zero)LocalFree(parsed);}
        foreach(string name in Files)using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload."+name)){if(stream==null||stream.Length<10000)throw new Exception();}
    }
    [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CommandLineToArgvW(string command,out int count);
    [DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr memory);
}
