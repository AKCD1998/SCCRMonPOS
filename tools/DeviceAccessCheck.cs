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
            policy = DeviceAccessGuard.LoadPolicy(); Assert(policy.Devices.Count(d => d.Status == "approved") == 5);
            Assert(policy.Devices.All(d => !string.IsNullOrEmpty(d.NodeId) && !string.IsNullOrEmpty(d.Ipv4)));
            bool denied = false; try { new UpdateRelease().RequireDeviceAccess(); } catch { denied = true; } Assert(denied);
            new UpdateRelease { DeviceAccessVersion = 1 }.RequireDeviceAccess(); Assert(true);
            Console.WriteLine("{\"ok\":true,\"checks\":" + checks + "}"); return 0;
        }
        catch (Exception ex) { Console.WriteLine(ex.Message); return 1; }
    }
}
