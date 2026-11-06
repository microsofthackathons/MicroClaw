using System.Collections.ObjectModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;

namespace OpenClawTray.Windows;

public sealed partial class A2UICanvasWindow
{
    private Grid RootGrid = null!;
    private StackPanel EmptyPanel = null!;
    private TextBlock WaitingForContentText = null!;
    private ContentControl SingleSurfaceHost = null!;
    private StandaloneTabView MultiSurfaceTabs = null!;

    public void InitializeComponent()
    {
        Width = 900;
        Height = 650;
        MinWidth = 320;
        MinHeight = 240;

        RootGrid = new Grid();
        EmptyPanel = new StackPanel
        {
            Padding = new Thickness(32),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Spacing = 12,
            Visibility = Visibility.Visible,
        };
        var icon = new FontIcon
        {
            FontSize = 32,
            Glyph = "\uE71B",
            Opacity = 0.55,
        };
        AutomationProperties.SetAccessibilityView(icon, AccessibilityView.Raw);
        WaitingForContentText = new TextBlock
        {
            HorizontalAlignment = HorizontalAlignment.Center,
            FontSize = 20,
            FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
            Opacity = 0.7,
        };
        AutomationProperties.SetLiveSetting(WaitingForContentText, AutomationLiveSetting.Polite);
        EmptyPanel.Children.Add(icon);
        EmptyPanel.Children.Add(WaitingForContentText);

        SingleSurfaceHost = new ContentControl
        {
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            VerticalContentAlignment = VerticalAlignment.Stretch,
            Visibility = Visibility.Collapsed,
        };
        MultiSurfaceTabs = new StandaloneTabView
        {
            Spacing = 12,
            Visibility = Visibility.Collapsed,
        };
        RootGrid.Children.Add(EmptyPanel);
        RootGrid.Children.Add(SingleSurfaceHost);
        RootGrid.Children.Add(MultiSurfaceTabs);
        Content = RootGrid;
    }
}

internal sealed class StandaloneTabView : StackPanel
{
    public StandaloneTabView() => TabItems = new TabItemCollection(this);

    public Collection<TabViewItem> TabItems { get; }

    public object? SelectedItem { get; set; }

    private sealed class TabItemCollection(StandaloneTabView owner) : Collection<TabViewItem>
    {
        protected override void InsertItem(int index, TabViewItem item)
        {
            base.InsertItem(index, item);
            owner.Children.Insert(index, item);
        }

        protected override void SetItem(int index, TabViewItem item)
        {
            base.SetItem(index, item);
            owner.Children[index] = item;
        }

        protected override void RemoveItem(int index)
        {
            if (ReferenceEquals(owner.SelectedItem, this[index]))
                owner.SelectedItem = null;
            owner.Children.RemoveAt(index);
            base.RemoveItem(index);
        }

        protected override void ClearItems()
        {
            owner.SelectedItem = null;
            owner.Children.Clear();
            base.ClearItems();
        }
    }
}

internal sealed class TabViewItem : StackPanel
{
    private object? _header;
    private object? _content;

    public TabViewItem() => Spacing = 4;

    public object? Header
    {
        get => _header;
        set
        {
            _header = value;
            Rebuild();
        }
    }

    public object? Content
    {
        get => _content;
        set
        {
            _content = value;
            Rebuild();
        }
    }

    public bool IsClosable { get; set; }

    private void Rebuild()
    {
        Children.Clear();
        if (_header is UIElement headerElement)
        {
            Children.Add(headerElement);
        }
        else if (_header != null)
        {
            Children.Add(new TextBlock
            {
                Text = _header.ToString(),
                FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
            });
        }

        if (_content is UIElement contentElement)
            Children.Add(contentElement);
    }
}
