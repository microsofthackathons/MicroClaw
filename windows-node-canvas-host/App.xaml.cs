using Microsoft.UI.Xaml;
using Microsoft.UI.Dispatching;

namespace MicroClaw.WindowsNodeCanvasHost;

public partial class App : Application
{
    private CanvasHostServer? _server;

    public App()
    {
        InitializeComponent();
        UnhandledException += (_, args) =>
        {
            Console.Error.WriteLine($"[canvas-host] unhandled: {args.Exception.GetType().Name}: {args.Exception.Message}");
            args.Handled = true;
        };
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            var bootstrapJson = await Console.In.ReadLineAsync();
            var bootstrap = CanvasHostBootstrap.Parse(bootstrapJson);
            OpenClawTray.Helpers.LocalizationHelper.Locale = bootstrap.UiLocale;
            _server = new CanvasHostServer(bootstrap, DispatcherQueue.GetForCurrentThread());
            await _server.RunAsync();
            Exit();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[canvas-host] startup failed: {ex.GetType().Name}: {ex.Message}");
            Exit();
        }
    }
}
