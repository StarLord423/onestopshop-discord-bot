$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$botRoot = $PSScriptRoot
$form = New-Object System.Windows.Forms.Form
$form.Text = 'OneStopShop bot - local token setup'
$form.Size = New-Object System.Drawing.Size(620,290)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(20,20)
$label.Size = New-Object System.Drawing.Size(570,85)
$label.Text = "Paste the BOT token from OneStopShop Community's Developer Portal.`r`nIt is saved only to this project's ignored .env file, restricted to your Windows user.`r`nDo not paste your Discord account token or any key into chat.`r`nServer: 1551412456050401300"
$form.Controls.Add($label)
$field = New-Object System.Windows.Forms.TextBox
$field.Location = New-Object System.Drawing.Point(20,110)
$field.Size = New-Object System.Drawing.Size(560,28)
$field.UseSystemPasswordChar = $true
$form.Controls.Add($field)
$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(20,195)
$status.Size = New-Object System.Drawing.Size(570,40)
$form.Controls.Add($status)
$save = New-Object System.Windows.Forms.Button
$save.Text = 'Save token locally'
$save.Location = New-Object System.Drawing.Point(20,155)
$save.Size = New-Object System.Drawing.Size(180,30)
$save.Add_Click({
    $botToken = $field.Text.Trim()
    if ($botToken.Length -lt 30 -or $botToken -match '\s') { $status.Text = 'Paste a valid bot token without spaces.'; return }
    try {
        $envPath = Join-Path $botRoot '.env'
        if (Test-Path -LiteralPath $envPath) { $content = [IO.File]::ReadAllText($envPath) }
        else { $content = [IO.File]::ReadAllText((Join-Path $botRoot '.env.example')) }
        $tokenLine = 'DISCORD_TOKEN=' + $botToken
        $content = [regex]::Replace($content, '(?m)^DISCORD_TOKEN=.*$', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $tokenLine })
        [IO.File]::WriteAllText($envPath, $content, (New-Object System.Text.UTF8Encoding($false)))
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $envPath -AclObject $acl
        $field.Clear()
        $status.Text = 'Saved locally. You can close this window. No token was sent to chat.'
        $save.Enabled = $false
    } catch { $status.Text = 'Could not save securely. Close this window and report the setup failure (not the token).' }
})
$form.Controls.Add($save)
[void]$form.ShowDialog()
