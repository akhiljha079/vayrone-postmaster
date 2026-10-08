// Vayrone PostMaster tray icon. Starts at Windows logon for every user (HKLM Run key).
// Shows whether PostMaster is running, opens the admin panel, and starts or restarts the
// services (asks for administrator rights). PostMaster itself runs as Windows services;
// closing this icon does not stop it.
//
// Built by scripts/package-windows.mjs with the C# compiler of .NET Framework 4 (part of Windows):
//   csc /target:winexe /win32icon:vpm.ico /out:VayronePostMasterTray.exe Tray.cs
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.ServiceProcess;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("Vayrone PostMaster tray")]
[assembly: System.Reflection.AssemblyCompany("Vayrone Infratech")]
[assembly: System.Reflection.AssemblyProduct("Vayrone PostMaster")]

static class Program
{
    [STAThread]
    static void Main()
    {
        bool first;
        using (var one = new Mutex(true, "Local\\VayronePostMasterTray", out first))
        {
            if (!first) return; // already in this user's tray
            Application.EnableVisualStyles();
            Application.Run(new TrayContext());
        }
    }
}

class TrayContext : ApplicationContext
{
    static readonly string[][] Services = {
        new[] { "VayronePostMasterDB", "Database" },
        new[] { "VayronePostMaster", "Mail server and admin panel" },
        new[] { "VayronePostMasterWorker", "Worker (external mail, outgoing queue, backups)" },
        new[] { "VayronePostMasterUpdater", "Updater and watchdog" },
    };

    readonly NotifyIcon icon = new NotifyIcon();
    readonly ToolStripMenuItem[] lines = new ToolStripMenuItem[Services.Length + 1];
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly Icon okIcon, downIcon, startingIcon;
    readonly string appDir = Path.GetDirectoryName(Application.ExecutablePath);
    bool? wasOk;

    public TrayContext()
    {
        var baseIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        okIcon = WithDot(baseIcon, Color.FromArgb(22, 163, 74));
        downIcon = WithDot(baseIcon, Color.FromArgb(220, 38, 38));
        startingIcon = WithDot(baseIcon, Color.FromArgb(245, 158, 11));

        var menu = new ContextMenuStrip();
        var open = new ToolStripMenuItem("Open Vayrone PostMaster", null, (s, e) => OpenPanel());
        open.Font = new Font(open.Font, FontStyle.Bold);
        menu.Items.Add(open);
        menu.Items.Add(new ToolStripSeparator());
        for (int i = 0; i < lines.Length; i++)
        {
            lines[i] = new ToolStripMenuItem("…") { Enabled = false };
            menu.Items.Add(lines[i]);
        }
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Start PostMaster", null, (s, e) => Elevated(Vpm(), "ensure-services")));
        menu.Items.Add(new ToolStripMenuItem("Restart PostMaster", null, (s, e) => Restart()));
        menu.Items.Add(new ToolStripMenuItem("Status window", null, (s, e) => Shell("cmd.exe", "/k \"\"" + Vpm() + "\" status\"")));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Hide this icon (PostMaster keeps running)", null, (s, e) => { icon.Visible = false; ExitThread(); }));

        icon.ContextMenuStrip = menu;
        icon.Icon = startingIcon;
        icon.Text = "Vayrone PostMaster";
        icon.DoubleClick += (s, e) => OpenPanel();
        icon.Visible = true;

        timer.Interval = 10000;
        timer.Tick += (s, e) => Refresh();
        timer.Start();
        Refresh();
    }

    string Vpm() { return Path.Combine(Path.GetDirectoryName(appDir), "bin\\vpm.exe"); }

    static string WebPort()
    {
        using (var k = Registry.LocalMachine.OpenSubKey("Software\\Vayrone\\PostMaster"))
        {
            var v = k == null ? null : k.GetValue("WebPort") as string;
            return string.IsNullOrEmpty(v) ? "443" : v;
        }
    }

    static string AdminUrl()
    {
        var port = WebPort();
        return port == "443" ? "https://localhost/" : "https://localhost:" + port + "/";
    }

    static bool PortOpen(int port)
    {
        try
        {
            using (var c = new TcpClient())
            {
                var r = c.BeginConnect("127.0.0.1", port, null, null);
                return r.AsyncWaitHandle.WaitOne(1500) && c.Connected;
            }
        }
        catch { return false; }
    }

    void Refresh()
    {
        bool allRunning = true, anyPending = false;
        for (int i = 0; i < Services.Length; i++)
        {
            string state;
            try
            {
                using (var sc = new ServiceController(Services[i][0]))
                {
                    var st = sc.Status;
                    if (st == ServiceControllerStatus.StartPending) anyPending = true;
                    state = st == ServiceControllerStatus.Running ? "running" : st == ServiceControllerStatus.StartPending ? "starting" : "STOPPED";
                    if (st != ServiceControllerStatus.Running) allRunning = false;
                }
            }
            catch { state = "not installed"; allRunning = false; }
            lines[i].Text = (state == "running" ? "✔ " : "✖ ") + Services[i][1] + ": " + state;
        }
        int port;
        bool web = int.TryParse(WebPort(), out port) && PortOpen(port);
        lines[Services.Length].Text = (web ? "✔ " : "✖ ") + "Admin panel " + AdminUrl() + (web ? "" : ": not answering");
        bool ok = allRunning && web;

        icon.Icon = ok ? okIcon : anyPending ? startingIcon : downIcon;
        var text = ok ? "Vayrone PostMaster: running" : anyPending ? "Vayrone PostMaster: starting…" : "Vayrone PostMaster: NOT running";
        icon.Text = text.Length > 63 ? text.Substring(0, 63) : text;
        if (wasOk == true && !ok && !anyPending)
            icon.ShowBalloonTip(10000, "Vayrone PostMaster stopped", "Mail is not being delivered. Right-click the tray icon and choose Start PostMaster.", ToolTipIcon.Error);
        if (wasOk == false && ok)
            icon.ShowBalloonTip(5000, "Vayrone PostMaster", "PostMaster is running again.", ToolTipIcon.Info);
        wasOk = ok;
    }

    void OpenPanel() { Shell(AdminUrl(), null); }

    void Restart()
    {
        // Stop the dependants before the database, start in reverse; one administrator prompt.
        var cmd = "/c net stop VayronePostMasterWorker & net stop VayronePostMaster & net stop VayronePostMasterDB" +
                  " & net start VayronePostMasterDB & net start VayronePostMaster & net start VayronePostMasterWorker & net start VayronePostMasterUpdater";
        Elevated("cmd.exe", cmd);
    }

    static void Shell(string file, string args)
    {
        try { Process.Start(new ProcessStartInfo(file, args ?? "") { UseShellExecute = true }); }
        catch (Exception e) { MessageBox.Show(e.Message, "Vayrone PostMaster"); }
    }

    void Elevated(string file, string args)
    {
        try
        {
            var p = Process.Start(new ProcessStartInfo(file, args) { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden });
            icon.Icon = startingIcon;
            icon.Text = "Vayrone PostMaster: starting…";
            ThreadPool.QueueUserWorkItem(_ => { try { p.WaitForExit(120000); } catch { } });
        }
        catch (System.ComponentModel.Win32Exception) { /* the administrator prompt was cancelled */ }
    }

    static Icon WithDot(Icon baseIcon, Color color)
    {
        var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.DrawIcon(new Icon(baseIcon, 32, 32), new Rectangle(0, 0, 32, 32));
            using (var b = new SolidBrush(color)) g.FillEllipse(b, 18, 18, 13, 13);
            using (var p = new Pen(Color.White, 2)) g.DrawEllipse(p, 18, 18, 13, 13);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }
}
