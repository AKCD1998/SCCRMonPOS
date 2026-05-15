using System;
using System.Threading;
using System.Windows.Forms;

namespace SCCRMonPOS
{
    /// <summary>
    /// Application entry point.
    /// Uses a named Mutex to prevent multiple instances from running on the same machine.
    /// The app runs entirely in the system tray (no main window).
    /// </summary>
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // Single-instance guard — "Global\" prefix works across user sessions
            bool createdNew;
            using (var mutex = new Mutex(true, @"Global\SCCRMonPOS_SingleInstance", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show(
                        "SCCRMonPOS กำลังทำงานอยู่แล้วในระบบ\nตรวจสอบ System Tray",
                        "SCCRM",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                    return;
                }

                // Wire up a global uncaught-exception handler so the tray app
                // never silently crashes without at least showing a message.
                Application.ThreadException += OnUnhandledThreadException;
                AppDomain.CurrentDomain.UnhandledException += OnUnhandledDomainException;

                Application.Run(new TrayAppContext());
            }
        }

        private static void OnUnhandledThreadException(object sender, ThreadExceptionEventArgs e)
        {
            MessageBox.Show(
                "เกิดข้อผิดพลาดที่ไม่ได้คาดคิด:\n\n" + e.Exception.Message +
                "\n\n" + e.Exception.StackTrace,
                "SCCRM — Unhandled Error",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }

        private static void OnUnhandledDomainException(object sender, UnhandledExceptionEventArgs e)
        {
            string msg = e.ExceptionObject?.ToString() ?? "(unknown)";
            MessageBox.Show(
                "เกิดข้อผิดพลาดร้ายแรง:\n\n" + msg,
                "SCCRM — Fatal Error",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}
