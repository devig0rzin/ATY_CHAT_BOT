param(
  [ValidateSet("ai", "whatsapp")]
  [string]$Mode = "ai"
)

$ErrorActionPreference = "Stop"

$sendToWhatsapp = $Mode -eq "whatsapp"
$body = @{
  message = "Olá, quero saber como a Automation To You pode automatizar minha empresa."
  send_to_whatsapp = $sendToWhatsapp
} | ConvertTo-Json -Compress

$response = Invoke-WebRequest `
  -Uri "http://127.0.0.1:8787/dev/chat-test" `
  -Method POST `
  -Headers @{ "content-type" = "application/json" } `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
  -UseBasicParsing

@{
  StatusCode = $response.StatusCode
  Content = ($response.Content | ConvertFrom-Json)
} | ConvertTo-Json -Depth 20
