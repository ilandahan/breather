import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { pathToFileURL } from "node:url";

export function notify(title, body) {
  const p = platform();
  if (p === "win32") {
    // Two constraints found the hard way (2026-08-31):
    // - detached:true (DETACHED_PROCESS) makes powershell exit 0 without
    //   executing anything, so the window never appears.
    // - a non-detached child dies with its parent, and the window blocks
    //   until dismissed, so the caller would hang until the user closes it.
    // Fix: a short-lived outer powershell Start-Process-es an independent
    // inner one that owns the window. Outer returns in ~1s; inner survives
    // any caller. Topmost=True keeps it above the terminal; WPF card instead
    // of the default MessageBox chrome.
    const psTitle = title.replace(/'/g, "''");
    const psBody = body.replace(/'/g, "''");
    const inner = `Add-Type -AssemblyName PresentationFramework
[xml]$x = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" SizeToContent="WidthAndHeight"
        WindowStartupLocation="Manual" ResizeMode="NoResize">
  <Border CornerRadius="14" Background="#FF26262F" BorderBrush="#7C6BF0" BorderThickness="1.5" Padding="22,18,22,18" MaxWidth="400" Margin="24">
    <Border.Effect>
      <DropShadowEffect Color="#7C6BF0" BlurRadius="28" ShadowDepth="0" Opacity="0.55"/>
    </Border.Effect>
    <StackPanel>
      <TextBlock Name="TitleText" FontFamily="Segoe UI" FontSize="13" FontWeight="Bold" Foreground="#C7BDFF" Margin="0,0,0,6"/>
      <TextBlock Name="BodyText" FontFamily="Segoe UI" FontSize="14.5" Foreground="#FFFFFF" TextWrapping="Wrap" LineHeight="22" Margin="0,0,0,16"/>
      <Button Name="OkButton" Content="Got it" HorizontalAlignment="Right" Background="#7C6BF0" Foreground="White" FontSize="12.5" FontFamily="Segoe UI" FontWeight="SemiBold" Cursor="Hand" BorderThickness="0">
        <Button.Template>
          <ControlTemplate TargetType="Button">
            <Border CornerRadius="8" Background="{TemplateBinding Background}" Padding="16,8">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
          </ControlTemplate>
        </Button.Template>
      </Button>
    </StackPanel>
  </Border>
</Window>
'@
$w = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $x))
$w.FindName('TitleText').Text = ('${psTitle}').ToUpper()
$w.FindName('BodyText').Text = '${psBody}'
$w.FindName('OkButton').Add_Click({ $w.Close() })
$w.Add_Loaded({
  $wa = [System.Windows.SystemParameters]::WorkArea
  $w.Left = $wa.Right - $w.ActualWidth - 16
  $w.Top = $wa.Bottom - $w.ActualHeight - 16
})
$w.ShowDialog() | Out-Null`;
    const args = ["-NoProfile", "-Command", `Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${Buffer.from(inner, "utf16le").toString("base64")}'`];
    if (process.env.BREATHER_NOTIFY_DRYRUN) {
      process.stdout.write(JSON.stringify({ cmd: "powershell.exe", args, inner }));
      return;
    }
    try { spawnSync("powershell.exe", args, { stdio: "ignore", windowsHide: true, timeout: 15000 }); } catch {}
    return;
  }
  let cmd, args;
  if (p === "darwin") {
    cmd = "osascript";
    args = ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`];
  } else {
    cmd = "notify-send";
    args = [title, body];
  }
  if (process.env.BREATHER_NOTIFY_DRYRUN) {
    process.stdout.write(JSON.stringify({ cmd, args }));
    return;
  }
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  notify(process.argv[2] || "Claude", process.argv[3] || "test");
}
