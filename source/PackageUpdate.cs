using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// Runs as the Discord user. The last operation that changes the active version
// is an atomic replacement of the entry JS, after its complete runtime exists.
internal static class PackageUpdate {
    const string Repo = "https://github.com/matheus1g/CallShare";
    const string Feed = "https://raw.githubusercontent.com/matheus1g/CallShare/main/release.json";
    const string Plugin = "CallShare.plugin.js";
    const long MiB = 1024 * 1024;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength=8192 };
    static string runtime, plugins, jobId, statusFile;
    static void Require(bool valid) { if(!valid) throw new InvalidDataException(); }
    static bool VersionText(string text) { return Regex.IsMatch(text??"",@"\A(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\z",RegexOptions.CultureInvariant); }
    static string Hash(string file) { using(var s=File.OpenRead(file))using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(s)).Replace("-","").ToLowerInvariant(); }
    static void Plain(string path) { Require((File.GetAttributes(path)&FileAttributes.ReparsePoint)==0); }
    static Dictionary<string,string> ReadJson(string file) {
        Plain(file);Require(new FileInfo(file).Length<=8192);return Json.Deserialize<Dictionary<string,string>>(File.ReadAllText(file));
    }
    static void Progress(string phase) {
        if(statusFile==null)return;
        var tmp=statusFile+".tmp";File.WriteAllText(tmp,Json.Serialize(new {id=jobId,phase=phase}),new UTF8Encoding(false));
        if(File.Exists(statusFile))File.Replace(tmp,statusFile,null);else File.Move(tmp,statusFile);
    }
    static void CopyBounded(Stream input,Stream output,long limit) {
        byte[] buf=new byte[65536];int n;long total=0;
        while((n=input.Read(buf,0,buf.Length))>0){total+=n;Require(total<=limit);output.Write(buf,0,n);}
    }
    static void Download(string address,Stream dest,long limit) {
        var uri=new Uri(address);
        for(int i=0;i<5;i++){
            Require(uri.Scheme=="https" && uri.IsDefaultPort && uri.UserInfo=="" &&
                (uri.Host=="raw.githubusercontent.com"||uri.Host=="github.com"||uri.Host=="release-assets.githubusercontent.com"||uri.Host=="objects.githubusercontent.com"));
            var request=(HttpWebRequest)WebRequest.Create(uri);
            request.UserAgent="CallShare package updater";request.AllowAutoRedirect=false;request.Timeout=30000;request.ReadWriteTimeout=30000;
            using(var response=(HttpWebResponse)request.GetResponse()){
                if((int)response.StatusCode>=300 && (int)response.StatusCode<400){uri=new Uri(uri,response.Headers["Location"]);continue;}
                Require(response.StatusCode==HttpStatusCode.OK && response.ContentLength<=limit);
                using(var input=response.GetResponseStream())CopyBounded(input,dest,limit);
                if(response.ContentLength>=0)Require(dest.Length==response.ContentLength);
                return;
            }
        }
        throw new InvalidDataException();
    }
    static string InstalledVersion(string file) {
        Plain(file);Require(new FileInfo(file).Length<8*MiB);
        using(var reader=File.OpenText(file)){
            for(int i=0;i<24;i++){
                var line=reader.ReadLine();if(line==null)break;
                var m=Regex.Match(line,@"^\s*\*\s*@version\s+(\S+)\s*$");
                if(m.Success&&VersionText(m.Groups[1].Value))return m.Groups[1].Value;
            }
        }
        throw new InvalidDataException();
    }
    static void Extract(string archive,string stage,string version) {
        var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);long total=0;
        using(var zip=ZipFile.OpenRead(archive)){
            Require(zip.Entries.Count>0 && zip.Entries.Count<=512);
            foreach(var entry in zip.Entries){
                string name=entry.FullName;
                Require(name.Length<=230 && seen.Add(name));
                foreach(var part in name.Split('/'))Require(Regex.IsMatch(part,@"\A[A-Za-z0-9_-][A-Za-z0-9_.-]*\z") && !part.EndsWith(".") &&
                    !Regex.IsMatch(part,@"^(CON|AUX|NUL|PRN|COM[1-9]|LPT[1-9])(\.|$)",RegexOptions.IgnoreCase));
                if(name!=Plugin && !name.StartsWith("CallShare-runtime/",StringComparison.Ordinal))continue;
                total+=entry.Length;Require(entry.Length<=160*MiB && total<=384*MiB);
                var target=Path.Combine(stage,name.Replace('/',Path.DirectorySeparatorChar));Directory.CreateDirectory(Path.GetDirectoryName(target));
                using(var input=entry.Open())using(var output=new FileStream(target,FileMode.CreateNew)){CopyBounded(input,output,entry.Length);Require(output.Length==entry.Length);}
            }
        }
        var tree=Path.Combine(stage,"CallShare-runtime");
        foreach(var f in new[]{"CallShare-helper.exe","CallShare-install.exe","CallShare-update.exe","release.json"})Require(File.Exists(Path.Combine(tree,f)));
        Require(InstalledVersion(Path.Combine(stage,Plugin))==version && ReadJson(Path.Combine(tree,"release.json"))["version"]==version);
    }
    static void Idle() {
        foreach(var name in new[]{"CallShare-helper","CallShare-vpn-worker"}){
            var processes=Process.GetProcessesByName(name);
            foreach(var p in processes)p.Dispose();
            if(processes.Length!=0)throw new InvalidOperationException("busy");
        }
    }
    static void Apply(string stage,string version,string previous,string digest,Action idle) {
        var live=Path.Combine(plugins,Plugin);Require(InstalledVersion(live)==previous);
        var versions=Path.Combine(runtime,"releases");Directory.CreateDirectory(versions);Plain(versions);
        string prepared=Path.Combine(stage,"CallShare-runtime"),target=Path.Combine(versions,version);
        var marker=".callshare-package";File.WriteAllText(Path.Combine(prepared,marker),digest);
        idle();
        if(Directory.Exists(target)){
            // A terminated previous attempt may have placed the runtime before
            // switching the JS. Verify its files again before reusing it.
            Plain(target);Require(File.ReadAllText(Path.Combine(target,marker))==digest);
            foreach(var f in Directory.GetFiles(prepared,"*",SearchOption.AllDirectories)){
                var existing=Path.Combine(target,f.Substring(prepared.Length+1));
                for(var parent=Path.GetDirectoryName(existing);parent!=target;parent=Path.GetDirectoryName(parent))Plain(parent);
                Plain(existing);Require(Hash(existing)==Hash(f));
            }
        } else Directory.Move(prepared,target);
        Require(InstalledVersion(live)==previous);
        File.Replace(Path.Combine(stage,Plugin),live,null);
    }
    static int Main(string[] args) {
        if(args.Length==1 && args[0]=="--self-test"){try{SelfTest();return 0;}catch{return 1;}}
        string stage=null;
        try{
            var here=new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar));
            var root=here.Name=="CallShare-runtime"?here:here.Parent!=null && here.Parent.Name=="releases"?here.Parent.Parent:null;
            Require(root!=null && root.Name=="CallShare-runtime");runtime=root.FullName;plugins=root.Parent.FullName;
            Plain(root.FullName);Plain(plugins);
            using(var gate=new FileStream(Path.Combine(runtime,"update.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)){
                var job=ReadJson(Path.Combine(runtime,"update-request.json"));
                jobId=job["id"];Require(Regex.IsMatch(jobId,@"\A[a-f0-9]{32}\z"));statusFile=Path.Combine(runtime,"update-status.json");
                var next=job["version"];Require(VersionText(next));
                var previous=InstalledVersion(Path.Combine(plugins,Plugin));Require(new Version(next)>new Version(previous));
                Idle();Progress("checking");ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
                string digest;
                using(var mem=new MemoryStream()){
                    Download(Feed,mem,8192);
                    var feed=Json.Deserialize<Dictionary<string,string>>(Encoding.UTF8.GetString(mem.ToArray()));
                    digest=feed["sha256"];Require(feed["version"]==next && Regex.IsMatch(digest,@"\A[a-f0-9]{64}\z"));
                }
                stage=Path.Combine(runtime,".update-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(stage);
                var zip=Path.Combine(stage,"package.zip");Progress("downloading");
                using(var output=new FileStream(zip,FileMode.CreateNew))Download(Repo+"/releases/download/v"+next+"/CallShare-"+next+"-completo.zip",output,192*MiB);
                Progress("verifying");Require(Hash(zip)==digest);Extract(zip,stage,next);
                Progress("installing");Apply(stage,next,previous,digest,Idle);Progress("done");
            }
            return 0;
        }catch(Exception e){try{Progress(e is InvalidOperationException && e.Message=="busy"?"busy":"failed");}catch{}return 1;}
        finally{try{if(stage!=null && Path.GetDirectoryName(stage)==runtime && Regex.IsMatch(Path.GetFileName(stage),@"^\.update-[a-f0-9]{32}$"))Directory.Delete(stage,true);}catch{}}
    }
    static void SelfTest(){
        var test=Directory.CreateDirectory(Path.Combine(Path.GetTempPath(),"CallShare-test-"+Guid.NewGuid().ToString("N"))).FullName;
        try{
            plugins=test;runtime=Path.Combine(test,"CallShare-runtime");Directory.CreateDirectory(runtime);
            var live=Path.Combine(test,Plugin);File.WriteAllText(live,"/**\n * @version 1.0.0\n */");
            var zip=Path.Combine(test,"test.zip");var stage=Directory.CreateDirectory(Path.Combine(test,"test-stage")).FullName;
            using(var z=ZipFile.Open(zip,ZipArchiveMode.Create)){
                foreach(var file in new[]{Plugin,"CallShare-runtime/release.json","CallShare-runtime/CallShare-helper.exe","CallShare-runtime/CallShare-install.exe","CallShare-runtime/CallShare-update.exe"})
                    using(var w=new StreamWriter(z.CreateEntry(file).Open()))w.Write(file==Plugin?"/**\n * @version 1.0.1\n */":file.EndsWith(".json")?"{\"version\":\"1.0.1\"}":"test");
            }
            Extract(zip,stage,"1.0.1");bool refused=false;
            try{Apply(stage,"1.0.1","1.0.0",Hash(zip),delegate{throw new InvalidOperationException("busy");});}catch(InvalidOperationException){refused=true;}
            Require(refused && InstalledVersion(live)=="1.0.0");
            Apply(stage,"1.0.1","1.0.0",Hash(zip),delegate{});
            Require(InstalledVersion(live)=="1.0.1" && File.Exists(Path.Combine(runtime,"releases","1.0.1","CallShare-helper.exe")));
            File.Delete(zip);using(var z=ZipFile.Open(zip,ZipArchiveMode.Create)){z.CreateEntry("../outside");}
            refused=false;try{Extract(zip,stage,"1.0.2");}catch(InvalidDataException){refused=true;}Require(refused);
        }finally{if(Path.GetDirectoryName(test)==Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar) && Path.GetFileName(test).StartsWith("CallShare-test-"))Directory.Delete(test,true);}
    }
}
