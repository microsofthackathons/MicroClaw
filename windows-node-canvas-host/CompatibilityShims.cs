namespace OpenClawTray.Helpers
{
    public static class LocalizationHelper
    {
        public static string Locale { get; set; } = "en-US";

        public static string GetString(string key)
        {
            var zh = Locale.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
            return key switch
            {
                "A2UI_CanvasTitle" => zh ? "MicroClaw 画布" : "MicroClaw Canvas",
                "Canvas_WaitingForContent" => zh ? "等待安全画布内容" : "Waiting for secure Canvas content",
                "A2UI_TabFallback" => zh ? "画布" : "Canvas",
                "A2UI_ModalClose" => zh ? "关闭" : "Close",
                "A2UI_DateTimeSelectDate" => zh ? "选择日期" : "Select date",
                "A2UI_MultipleChoiceSelect" => zh ? "请选择" : "Select",
                "A2UI_UnsupportedComponent" => zh ? "不支持的组件：{0}" : "Unsupported component: {0}",
                _ => key,
            };
        }
    }
}

namespace OpenClawTray.Services
{
    public static class Logger
    {
        public static void Debug(string message) => Console.Error.WriteLine($"[canvas-host][debug] {message}");
        public static void Warn(string message) => Console.Error.WriteLine($"[canvas-host][warn] {message}");
    }
}
