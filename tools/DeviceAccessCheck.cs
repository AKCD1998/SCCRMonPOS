using System;
using System.Linq;
using SCCRMonPOS;
using SCCRMonPOS.Updates;

internal static class DeviceAccessCheck
{
    private static int checks;
    private static void Assert(bool condition) { checks++; if (!condition) throw new Exception("Device access check failed: " + checks); }
    private static TailnetIdentity Identity() { return new TailnetIdentity { BackendState = "Running", CurrentTailnet = new TailnetName { Name = "synthetic-company" }, Self = new TailnetNode { Id = "synthetic-node", Hostname = "POS", Online = true, Ips = new[] { "100.64.0.1" } } }; }
    private static DevicePolicy Policy() { return new DevicePolicy { SchemaVersion = 1, Tailnet = "synthetic-company", Devices = new[] { new ApprovedDevice { NodeId = "synthetic-node", Hostname = "POS", Ipv4 = "100.64.0.1", Status = "approved", AdaPaths = new[] { @"D:\AdaSoft\AdaPosFront.exe" } } } }; }
    private static bool Allows(DevicePolicy policy, TailnetIdentity identity, bool adapter = true, bool ada = true) { return DeviceAccessGuard.Evaluate(policy, identity, _ => adapter, _ => ada) == null; }
    private static int Main()
    {
        try
        {
            Assert(Allows(Policy(), Identity()));
            var identity = Identity(); identity.Self.Id = "other-node"; Assert(!Allows(Policy(), identity));
            identity = Identity(); identity.Self.Ips = new[] { "100.64.0.2" }; Assert(!Allows(Policy(), identity));
            identity = Identity(); identity.Self.Hostname = "OTHER"; Assert(!Allows(Policy(), identity));
            identity = Identity(); identity.Self.Online = false; Assert(!Allows(Policy(), identity));
            identity = Identity(); identity.BackendState = "Stopped"; Assert(!Allows(Policy(), identity));
            identity = Identity(); identity.CurrentTailnet.Name = "other-company"; Assert(!Allows(Policy(), identity));
            Assert(!Allows(Policy(), Identity(), adapter: false));
            Assert(!Allows(Policy(), Identity(), ada: false));
            var policy = Policy(); policy.Devices[0].Status = "pending"; Assert(!Allows(policy, Identity()));
            policy = Policy(); policy.Devices[0].Status = "denied"; Assert(!Allows(policy, Identity()));
            policy = Policy(); policy.Devices = new[] { policy.Devices[0], policy.Devices[0] }; Assert(!Allows(policy, Identity()));
            Assert(!Allows(null, Identity())); Assert(!Allows(Policy(), null));
            policy = DeviceAccessGuard.LoadPolicy(); Assert(policy.Devices.Count(d => d.Status == "approved") == 8);
            Assert(policy.Devices.All(d => !string.IsNullOrEmpty(d.NodeId) && !string.IsNullOrEmpty(d.Ipv4)));
            var pos2 = new TailnetIdentity { BackendState = "Running", CurrentTailnet = new TailnetName { Name = "akcd1998.github" }, Self = new TailnetNode { Id = "nEdQXowQ4t11CNTRL", Hostname = "POS2", Online = true, Ips = new[] { "100.93.254.58" } } };
            Assert(Allows(policy, pos2));
            Assert(!Allows(policy, pos2, adapter: false));
            Assert(!Allows(policy, pos2, ada: false));
            pos2.Self.Id = "unapproved-node-with-same-ip"; Assert(!Allows(policy, pos2));
            pos2.Self.Id = "nEdQXowQ4t11CNTRL"; pos2.Self.Hostname = "OTHER"; Assert(!Allows(policy, pos2));
            var branch004Pos2 = new TailnetIdentity { BackendState = "Running", CurrentTailnet = new TailnetName { Name = "akcd1998.github" }, Self = new TailnetNode { Id = "noJJCWPrL221CNTRL", Hostname = "POS002", Online = true, Ips = new[] { "100.73.76.18" } } };
            Assert(Allows(policy, branch004Pos2));
            Assert(!Allows(policy, branch004Pos2, adapter: false));
            Assert(!Allows(policy, branch004Pos2, ada: false));
            branch004Pos2.Self.Id = "unapproved-node-with-same-ip"; Assert(!Allows(policy, branch004Pos2));
            branch004Pos2.Self.Id = "noJJCWPrL221CNTRL"; branch004Pos2.Self.Hostname = "OTHER"; Assert(!Allows(policy, branch004Pos2));
            var branch003Pos2 = new TailnetIdentity { BackendState = "Running", CurrentTailnet = new TailnetName { Name = "akcd1998.github" }, Self = new TailnetNode { Id = "nFQPDepQTh11CNTRL", Hostname = "POS2", Online = true, Ips = new[] { "100.100.253.52" } } };
            Assert(Allows(policy, branch003Pos2));
            Assert(!Allows(policy, branch003Pos2, adapter: false));
            Assert(!Allows(policy, branch003Pos2, ada: false));
            branch003Pos2.Self.Id = "unapproved-node-with-same-ip"; Assert(!Allows(policy, branch003Pos2));
            branch003Pos2.Self.Id = "nFQPDepQTh11CNTRL"; branch003Pos2.Self.Ips = new[] { "100.93.254.58" }; Assert(!Allows(policy, branch003Pos2));
            branch003Pos2.Self.Ips = new[] { "100.100.253.52" }; branch003Pos2.Self.Hostname = "OTHER"; Assert(!Allows(policy, branch003Pos2));
            bool denied = false; try { new UpdateRelease().RequireDeviceAccess(); } catch { denied = true; } Assert(denied);
            new UpdateRelease { DeviceAccessVersion = 1 }.RequireDeviceAccess(); Assert(true);
            Console.WriteLine("{\"ok\":true,\"checks\":" + checks + "}"); return 0;
        }
        catch (Exception ex) { Console.WriteLine(ex.Message); return 1; }
    }
}
