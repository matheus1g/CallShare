// Installation-time compatibility check for Windows Firewall Shields-Up.
// The installer owns only AllowInboundRules changes explicitly approved here.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class FirewallProfiles {
    internal sealed class Profile {
        public string name;
        public bool active, blocked;
        public string enabled, allowInbound, localAllowInbound, defaultInbound, defaultOutbound;
    }
    internal sealed class Snapshot {
        public int activeMask, modifyState = 0;
        public Profile[] profiles;
    }
    internal interface IPolicy {
        Snapshot Read();
        void SetAllowInbound(string name, bool value);
    }

    // Fixed operating-system commands only. No downloaded or caller-provided script is evaluated.
    const string ReadCommand = @"
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$policy = New-Object -ComObject HNetCfg.FwPolicy2
try {
    $active = $policy.CurrentProfileTypes
    if ($null -eq $active) { throw 'CurrentProfileTypes unavailable' }
    $rows = @(foreach ($entry in @(@{name='Domain';mask=1},@{name='Private';mask=2},@{name='Public';mask=4})) {
        $effective = NetSecurity\Get-NetFirewallProfile -Name $entry.name -PolicyStore ActiveStore -ErrorAction Stop
        $local = NetSecurity\Get-NetFirewallProfile -Name $entry.name -PolicyStore PersistentStore -ErrorAction Stop
        $blocked = $policy.BlockAllInboundTraffic([int]$entry.mask)
        if ($null -eq $blocked) { throw 'BlockAllInboundTraffic unavailable' }
        [PSCustomObject]@{
            name = $entry.name
            active = (([int]$active -band $entry.mask) -ne 0)
            blocked = [bool]$blocked
            enabled = [string]$effective.Enabled
            allowInbound = [string]$effective.AllowInboundRules
            localAllowInbound = [string]$local.AllowInboundRules
            defaultInbound = [string]$effective.DefaultInboundAction
            defaultOutbound = [string]$effective.DefaultOutboundAction
        }
    })
    [PSCustomObject]@{ activeMask=[int]$active; modifyState=[int]$policy.LocalPolicyModifyState; profiles=$rows } | ConvertTo-Json -Depth 4 -Compress
} finally {
    if ($policy) { $null = [Runtime.InteropServices.Marshal]::ReleaseComObject($policy) }
}";

    sealed class WindowsPolicy : IPolicy {
        static string Run(string command) {
            string powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(command));
            var start = new ProcessStartInfo(powershell, "-NoLogo -NoProfile -NonInteractive -EncodedCommand " + encoded) {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Environment.SystemDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            start.EnvironmentVariables["PSModulePath"] = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\Modules");
            using (var process = Process.Start(start)) {
                Task<string> output = process.StandardOutput.ReadToEndAsync();
                Task<string> error = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(30000)) {
                    try { process.Kill(); } catch { }
                    throw new Exception("CS_SETUP_FIREWALL_QUERY");
                }
                if (process.ExitCode != 0 || !Task.WaitAll(new Task[] { output, error }, 5000) || output.Result.Length > 65536)
                    throw new Exception("CS_SETUP_FIREWALL_QUERY");
                return output.Result.Trim().TrimStart('\uFEFF');
            }
        }
        public Snapshot Read() {
            try {
                var value = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 8 }.Deserialize<Snapshot>(Run(ReadCommand));
                Validate(value);
                return value;
            } catch { throw new Exception("CS_SETUP_FIREWALL_QUERY"); }
        }
        public void SetAllowInbound(string name, bool value) {
            if (!KnownName(name)) throw new Exception("CS_SETUP_FIREWALL_QUERY");
            Run("$ErrorActionPreference = 'Stop'; NetSecurity\\Set-NetFirewallProfile -Name " + name +
                " -PolicyStore PersistentStore -AllowInboundRules " + (value ? "True" : "False") + " -ErrorAction Stop");
        }
    }

    static bool KnownName(string name) { return name == "Domain" || name == "Private" || name == "Public"; }
    static bool BooleanSetting(string value) { return value == "True" || value == "False" || value == "NotConfigured"; }
    static bool DefaultAction(string value) { return value == "Block" || value == "Allow" || value == "NotConfigured"; }
    static int Mask(string name) { return name == "Domain" ? 1 : name == "Private" ? 2 : 4; }
    static void Validate(Snapshot value) {
        if (value == null || value.activeMask < 0 || value.activeMask > 7 || value.modifyState < 0 || value.modifyState > 2 || value.profiles == null || value.profiles.Length != 3)
            throw new Exception("CS_SETUP_FIREWALL_QUERY");
        var names = new HashSet<string>();
        foreach (var row in value.profiles) {
            if (row == null || !KnownName(row.name) || !names.Add(row.name) || row.active != ((value.activeMask & Mask(row.name)) != 0) ||
                !BooleanSetting(row.enabled) || !BooleanSetting(row.allowInbound) || !BooleanSetting(row.localAllowInbound) ||
                !DefaultAction(row.defaultInbound) || !DefaultAction(row.defaultOutbound)) throw new Exception("CS_SETUP_FIREWALL_QUERY");
        }
    }
    internal static Snapshot Capture() { return new WindowsPolicy().Read(); }
    internal static List<Profile> Candidates(Snapshot value) {
        Validate(value);
        var result = new List<Profile>();
        foreach (var row in value.profiles) {
            if (!(row.active || row.name == "Public") || row.enabled != "True") continue;
            if (row.defaultInbound == "Block" && row.blocked != (row.allowInbound == "False"))
                throw new Exception("CS_SETUP_FIREWALL_QUERY");
            if (row.blocked && row.allowInbound == "False" && row.defaultInbound == "Block") result.Add(row);
        }
        return result;
    }
    static Profile Find(Snapshot value, string name) {
        foreach (var row in value.profiles) if (row.name == name) return row;
        throw new Exception("CS_SETUP_FIREWALL_QUERY");
    }
    static bool SameSettings(Profile left, Profile right) {
        return left.name == right.name && left.active == right.active && left.enabled == right.enabled &&
            left.defaultInbound == right.defaultInbound && left.defaultOutbound == right.defaultOutbound;
    }
    static void Unchanged(Snapshot before, Snapshot current, List<Profile> targets) {
        Validate(current);
        if (current.activeMask != before.activeMask || current.modifyState != before.modifyState) throw new Exception("CS_SETUP_FIREWALL_CHANGED");
        foreach (var target in targets) {
            var row = Find(current, target.name);
            if (!SameSettings(target, row) || target.blocked != row.blocked || target.allowInbound != row.allowInbound || target.localAllowInbound != row.localAllowInbound)
                throw new Exception("CS_SETUP_FIREWALL_CHANGED");
        }
    }
    static void SaveBackup(string root, Snapshot before, List<Profile> targets) {
        try {
            string file = Path.Combine(root, "CallShare-firewall-backup-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmssZ") + "-" + Guid.NewGuid().ToString("N") + ".json");
            var names = new List<string>();
            foreach (var target in targets) names.Add(target.name);
            string data = new JavaScriptSerializer().Serialize(new { schema = 1, at = DateTime.UtcNow.ToString("o"), operation = "AllowInboundRules", profiles = names, before = before });
            using (var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                byte[] bytes = new UTF8Encoding(false).GetBytes(data);
                output.Write(bytes, 0, bytes.Length);
                output.Flush(true);
            }
            if (File.ReadAllText(file, Encoding.UTF8) != data) throw new IOException();
        } catch { throw new Exception("CS_SETUP_FIREWALL_BACKUP"); }
    }
    internal static void Apply(IPolicy policy, Snapshot before, List<Profile> targets, Action backup) {
        Unchanged(before, policy.Read(), targets);
        backup();
        var attempted = new List<Profile>();
        try {
            foreach (var target in targets) {
                attempted.Add(target);
                policy.SetAllowInbound(target.name, true);
            }
            var after = policy.Read();
            Validate(after);
            if (after.activeMask != before.activeMask) throw new Exception("CS_SETUP_FIREWALL_CHANGED");
            foreach (var target in targets) {
                var row = Find(after, target.name);
                if (!SameSettings(target, row)) throw new Exception("CS_SETUP_FIREWALL_CHANGED");
                if (row.allowInbound != "True" || row.localAllowInbound != "True" || row.blocked)
                    throw new Exception("CS_SETUP_FIREWALL_POLICY");
            }
        } catch {
            bool restored = true;
            for (int i = attempted.Count - 1; i >= 0; i--) {
                try {
                    var row = Find(policy.Read(), attempted[i].name);
                    if (row.localAllowInbound == "True") policy.SetAllowInbound(row.name, false);
                    if (Find(policy.Read(), row.name).localAllowInbound != "False") restored = false;
                } catch { restored = false; }
            }
            if (!restored) throw new Exception("CS_SETUP_FIREWALL_RESTORE");
            throw;
        }
    }
    internal static void Configure(IPolicy policy, Func<string, bool> approve, Action<Snapshot, List<Profile>> backup) {
        var before = policy.Read();
        var targets = Candidates(before);
        if (targets.Count == 0) return;
        foreach (var target in targets)
            if (target.localAllowInbound != "False" || before.modifyState == 1) throw new Exception("CS_SETUP_FIREWALL_POLICY");
        var labels = new List<string>();
        foreach (var target in targets) labels.Add(target.name + (target.active ? " (ativo)" : " (pode ser usado pelo túnel)"));
        string prompt = "O Windows está configurado para bloquear todas as conexões de entrada nestes perfis.\n\n" + String.Join(", ", labels.ToArray()) +
            "\n\nPara o CallShare receber a transmissão, as permissões de entrada existentes precisam voltar a valer nesses perfis. " +
            "Essa alteração também vale para outros aplicativos e interfaces que usam os mesmos perfis.\n\n" +
            "O instalador salvará a configuração anterior na pasta protegida do CallShare. Deseja aplicar esse ajuste?";
        if (!approve(prompt)) throw new Exception("CS_SETUP_FIREWALL_DECLINED");
        Apply(policy, before, targets, delegate { backup(before, targets); });
    }
    public static void ConfigureForInstall(string root, Func<string, bool> approve) {
        Configure(new WindowsPolicy(), approve, delegate(Snapshot before, List<Profile> targets) { SaveBackup(root, before, targets); });
    }

    sealed class FakePolicy : IPolicy {
        public Snapshot Value;
        public readonly List<string> Writes = new List<string>();
        public bool Managed, FailAfterWrite;
        public Snapshot Read() {
            return new JavaScriptSerializer().Deserialize<Snapshot>(new JavaScriptSerializer().Serialize(Value));
        }
        public void SetAllowInbound(string name, bool value) {
            Writes.Add(name + ":" + value);
            var row = Find(Value, name);
            row.localAllowInbound = value ? "True" : "False";
            if (!Managed) { row.allowInbound = row.localAllowInbound; row.blocked = !value; }
            if (FailAfterWrite && value) throw new Exception("CS_SETUP_FIREWALL_QUERY");
        }
    }
    static Snapshot Fixture(int mask) {
        var result = new Snapshot { activeMask = mask, profiles = new Profile[3] };
        string[] names = { "Domain", "Private", "Public" };
        for (int i = 0; i < names.Length; i++) result.profiles[i] = new Profile {
            name = names[i], active = (mask & Mask(names[i])) != 0, enabled = "True", blocked = names[i] == "Public",
            allowInbound = names[i] == "Public" ? "False" : "True", localAllowInbound = names[i] == "Public" ? "False" : "NotConfigured",
            defaultInbound = "Block", defaultOutbound = "Allow"
        };
        return result;
    }
    public static void SelfTest() {
        foreach (int mask in new[] { 2, 6 }) {
            var fake = new FakePolicy { Value = Fixture(mask) };
            var before = fake.Read();
            var targets = Candidates(before);
            if (targets.Count != 1 || targets[0].name != "Public") throw new Exception("Firewall Public selection");
            int backups = 0;
            Apply(fake, before, targets, delegate { backups++; });
            if (backups != 1 || fake.Writes.Count != 1 || fake.Writes[0] != "Public:True" || Find(fake.Read(), "Public").blocked)
                throw new Exception("Firewall repair result");
        }
        var inactive = Fixture(2);
        var domain = Find(inactive, "Domain"); domain.blocked = true; domain.allowInbound = "False"; domain.localAllowInbound = "False";
        if (Candidates(inactive).Count != 1) throw new Exception("Inactive domain selected");
        var normal = Fixture(6); var publicProfile = Find(normal, "Public"); publicProfile.blocked = false; publicProfile.allowInbound = "True";
        if (Candidates(normal).Count != 0) throw new Exception("Healthy firewall selected");
        var inconsistent = Fixture(6); Find(inconsistent, "Public").blocked = false;
        bool rejectedInconsistent = false;
        try { Candidates(inconsistent); } catch { rejectedInconsistent = true; }
        if (!rejectedInconsistent) throw new Exception("Inconsistent firewall accepted");
        var healthy = new FakePolicy { Value = normal };
        Configure(healthy, delegate { throw new Exception("Unnecessary firewall consent"); }, delegate { throw new Exception("Unnecessary firewall backup"); });
        if (healthy.Writes.Count != 0) throw new Exception("Healthy firewall modified");
        var declined = new FakePolicy { Value = Fixture(6) }; bool declinedCorrectly = false;
        try { Configure(declined, delegate { return false; }, delegate { throw new Exception("Backup after refusal"); }); }
        catch (Exception error) { declinedCorrectly = error.Message == "CS_SETUP_FIREWALL_DECLINED"; }
        if (!declinedCorrectly || declined.Writes.Count != 0) throw new Exception("Firewall consent ignored");
        var imposed = new FakePolicy { Value = Fixture(6) }; Find(imposed.Value, "Public").localAllowInbound = "NotConfigured";
        bool imposedRejected = false;
        try { Configure(imposed, delegate { throw new Exception("Managed firewall consent"); }, delegate { }); }
        catch (Exception error) { imposedRejected = error.Message == "CS_SETUP_FIREWALL_POLICY"; }
        if (!imposedRejected || imposed.Writes.Count != 0) throw new Exception("Managed firewall modified");
        foreach (bool partial in new[] { false, true }) {
            var fake = new FakePolicy { Value = Fixture(6), Managed = !partial, FailAfterWrite = partial };
            var before = fake.Read(); bool rejected = false;
            try { Apply(fake, before, Candidates(before), delegate { }); } catch { rejected = true; }
            if (!rejected || fake.Writes.Count != 2 || fake.Writes[1] != "Public:False" || Find(fake.Read(), "Public").localAllowInbound != "False")
                throw new Exception("Firewall rollback");
        }
        var failedBackup = new FakePolicy { Value = Fixture(6) }; var snapshot = failedBackup.Read();
        try { Apply(failedBackup, snapshot, Candidates(snapshot), delegate { throw new IOException(); }); } catch (IOException) { }
        if (failedBackup.Writes.Count != 0) throw new Exception("Firewall wrote before backup");
        var changed = new FakePolicy { Value = Fixture(6) }; snapshot = changed.Read(); changed.Value.activeMask = 2; Find(changed.Value, "Public").active = false;
        bool stopped = false;
        try { Apply(changed, snapshot, Candidates(snapshot), delegate { }); } catch { stopped = true; }
        if (!stopped || changed.Writes.Count != 0) throw new Exception("Firewall changed profile accepted");
    }
}
